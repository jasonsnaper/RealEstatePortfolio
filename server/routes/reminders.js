const { apiError, sendJson } = require('../lib/router');
const { requireAuth, getOwnedPropertyOr404, logAudit } = require('../lib/helpers');
const { todayInTimezone, addDays } = require('../lib/dates');

const TYPES = ['rent', 'lease_expiration', 'inspection', 'insurance_renewal', 'tax', 'maintenance', 'other'];

function serializeReminder(r) {
  return { id: r.id, propertyId: r.property_id, type: r.type, title: r.title, dueDate: r.due_date, status: r.status };
}

/** Auto-derive reminders that don't need a row of their own: lease expiration
 * dates and open maintenance with a scheduled date. Manually-created reminders
 * (from the `reminders` table) are merged in alongside these computed ones. */
function computeAutoReminders(db, propertyId, timezone) {
  const today = todayInTimezone(timezone);
  const horizon = addDays(today, 60); // surface anything due within ~2 months
  const out = [];

  const lease = db.prepare("SELECT * FROM leases WHERE property_id = ? AND status = 'active'").get(propertyId);
  if (lease && lease.end_date && lease.end_date >= today && lease.end_date <= horizon) {
    out.push({ id: `lease-end-${lease.id}`, propertyId, type: 'lease_expiration', title: `Lease ends for ${lease.tenant_name}`, dueDate: lease.end_date, status: 'pending', auto: true });
  }
  const scheduledMaintenance = db.prepare(`
    SELECT * FROM maintenance_requests WHERE property_id = ? AND scheduled_date IS NOT NULL
    AND scheduled_date >= ? AND scheduled_date <= ? AND status NOT IN ('completed','cancelled')
  `).all(propertyId, today, horizon);
  for (const m of scheduledMaintenance) {
    out.push({ id: `maint-${m.id}`, propertyId, type: 'maintenance', title: m.title, dueDate: m.scheduled_date, status: 'pending', auto: true });
  }
  const docs = db.prepare(`SELECT * FROM documents WHERE property_id = ? AND expiration_date IS NOT NULL AND expiration_date >= ? AND expiration_date <= ?`).all(propertyId, today, horizon);
  for (const d of docs) {
    const type = d.category === 'insurance' ? 'insurance_renewal' : d.category === 'tax' ? 'tax' : 'other';
    const displayName = d.filename.replace(/\.[^./\\]+$/, ''); // drop the file extension — "Policy.pdf expires" reads like a typo, not a reminder
    out.push({ id: `doc-${d.id}`, propertyId, type, title: `${displayName} expires`, dueDate: d.expiration_date, status: 'pending', auto: true });
  }
  return out;
}

function registerReminderRoutes(router, { db }) {
  router.get('/api/properties/:id/reminders', async (req, res) => {
    const owner = requireAuth(db, req);
    const property = getOwnedPropertyOr404(db, owner.id, req.params.id);
    const manual = db.prepare("SELECT * FROM reminders WHERE property_id = ? AND status = 'pending' ORDER BY due_date").all(property.id);
    const auto = computeAutoReminders(db, property.id, property.timezone);
    const combined = [...manual.map(serializeReminder), ...auto].sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    sendJson(res, 200, combined);
  });

  router.post('/api/properties/:id/reminders', async (req, res) => {
    const owner = requireAuth(db, req);
    const property = getOwnedPropertyOr404(db, owner.id, req.params.id);
    const { type, title, dueDate } = req.body;
    if (!title || !dueDate) throw apiError(400, 'Title and due date are required');
    const result = db.prepare('INSERT INTO reminders (property_id, type, title, due_date) VALUES (?, ?, ?, ?)')
      .run(property.id, TYPES.includes(type) ? type : 'other', title.trim(), dueDate);
    logAudit(db, { actorType: 'owner', actorId: owner.id, action: 'create', entityType: 'reminder', entityId: result.lastInsertRowid, after: req.body });
    sendJson(res, 201, serializeReminder(db.prepare('SELECT * FROM reminders WHERE id = ?').get(result.lastInsertRowid)));
  });

  router.post('/api/reminders/:id/dismiss', async (req, res) => {
    const owner = requireAuth(db, req);
    const reminder = db.prepare(`
      SELECT r.* FROM reminders r JOIN properties p ON p.id = r.property_id WHERE r.id = ? AND p.owner_id = ?
    `).get(req.params.id, owner.id);
    if (!reminder) throw apiError(404, 'Reminder not found');
    db.prepare("UPDATE reminders SET status='dismissed' WHERE id=?").run(reminder.id);
    sendJson(res, 200, { ok: true });
  });

  // Portfolio-wide reminders feed for the dashboard's "upcoming deadlines" widget.
  router.get('/api/portfolio/reminders', async (req, res) => {
    const owner = requireAuth(db, req);
    const properties = db.prepare("SELECT * FROM properties WHERE owner_id = ? AND status = 'active'").all(owner.id);
    let all = [];
    for (const property of properties) {
      const manual = db.prepare("SELECT * FROM reminders WHERE property_id = ? AND status = 'pending'").all(property.id).map(serializeReminder);
      const auto = computeAutoReminders(db, property.id, property.timezone);
      all = all.concat([...manual, ...auto].map((r) => ({ ...r, propertyName: property.name })));
    }
    all.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    sendJson(res, 200, all.slice(0, 25));
  });
}

module.exports = { registerReminderRoutes, computeAutoReminders };

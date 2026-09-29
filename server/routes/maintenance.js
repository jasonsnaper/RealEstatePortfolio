const path = require('path');
const { apiError, sendJson } = require('../lib/router');
const { requireAuth, getOwnedPropertyOr404, saveBase64Image, logAudit } = require('../lib/helpers');
const { dollarsToCents } = require('../lib/money');

const { UPLOADS_DIR } = require('../db');
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const STATUSES = ['open', 'scheduled', 'in_progress', 'completed', 'cancelled'];

function serializeRequest(db, r) {
  const photos = db.prepare('SELECT * FROM maintenance_photos WHERE maintenance_request_id = ?').all(r.id);
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    priority: r.priority,
    status: r.status,
    assignedVendor: r.assigned_vendor,
    estimatedCostCents: r.estimated_cost_cents,
    actualCostCents: r.actual_cost_cents,
    scheduledDate: r.scheduled_date,
    completedDate: r.completed_date,
    createdBy: r.created_by,
    createdAt: r.created_at,
    photos: photos.map((p) => ({ id: p.id, url: `/uploads/properties/${r.property_id}/maintenance/${p.file_path}` })),
  };
}

function registerMaintenanceRoutes(router, { db }) {
  router.get('/api/properties/:id/maintenance', async (req, res) => {
    const owner = requireAuth(db, req);
    const property = getOwnedPropertyOr404(db, owner.id, req.params.id);
    let rows = db.prepare('SELECT * FROM maintenance_requests WHERE property_id = ? ORDER BY created_at DESC').all(property.id);
    if (req.query.status) rows = rows.filter((r) => r.status === req.query.status);
    sendJson(res, 200, rows.map((r) => serializeRequest(db, r)));
  });

  router.post('/api/properties/:id/maintenance', async (req, res) => {
    const owner = requireAuth(db, req);
    const property = getOwnedPropertyOr404(db, owner.id, req.params.id);
    const b = req.body;
    if (!b.title) throw apiError(400, 'A title is required');
    const result = db.prepare(`
      INSERT INTO maintenance_requests (property_id, title, description, priority, assigned_vendor, estimated_cost_cents, scheduled_date, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'owner')
    `).run(
      property.id, b.title.trim(), b.description || null,
      PRIORITIES.includes(b.priority) ? b.priority : 'normal',
      b.assignedVendor || null, b.estimatedCost ? dollarsToCents(b.estimatedCost) : null, b.scheduledDate || null
    );
    attachPhotos(db, property.id, result.lastInsertRowid, b.images);
    logAudit(db, { actorType: 'owner', actorId: owner.id, action: 'create', entityType: 'maintenance_request', entityId: result.lastInsertRowid, after: b });
    sendJson(res, 201, serializeRequest(db, db.prepare('SELECT * FROM maintenance_requests WHERE id = ?').get(result.lastInsertRowid)));
  });

  router.put('/api/maintenance/:id', async (req, res) => {
    const owner = requireAuth(db, req);
    const before = db.prepare(`
      SELECT m.* FROM maintenance_requests m JOIN properties p ON p.id = m.property_id WHERE m.id = ? AND p.owner_id = ?
    `).get(req.params.id, owner.id);
    if (!before) throw apiError(404, 'Maintenance request not found');
    const b = req.body;
    db.prepare(`
      UPDATE maintenance_requests SET title=?, description=?, priority=?, status=?, assigned_vendor=?,
             estimated_cost_cents=?, actual_cost_cents=?, scheduled_date=?, completed_date=?
      WHERE id=?
    `).run(
      b.title ?? before.title, b.description ?? before.description,
      PRIORITIES.includes(b.priority) ? b.priority : before.priority,
      STATUSES.includes(b.status) ? b.status : before.status,
      b.assignedVendor ?? before.assigned_vendor,
      b.estimatedCost != null ? dollarsToCents(b.estimatedCost) : before.estimated_cost_cents,
      b.actualCost != null ? dollarsToCents(b.actualCost) : before.actual_cost_cents,
      b.scheduledDate ?? before.scheduled_date,
      b.completedDate ?? (b.status === 'completed' && !before.completed_date ? new Date().toISOString().slice(0, 10) : before.completed_date),
      before.id
    );
    attachPhotos(db, before.property_id, before.id, b.images);
    logAudit(db, { actorType: 'owner', actorId: owner.id, action: 'update', entityType: 'maintenance_request', entityId: before.id, before, after: b });
    sendJson(res, 200, serializeRequest(db, db.prepare('SELECT * FROM maintenance_requests WHERE id = ?').get(before.id)));
  });

  // Marking a maintenance job's actual cost paid also books it as a real
  // expense transaction, in one action, instead of asking the owner to
  // duplicate the number into the Transactions tab by hand.
  router.post('/api/maintenance/:id/log-expense', async (req, res) => {
    const owner = requireAuth(db, req);
    const request = db.prepare(`
      SELECT m.* FROM maintenance_requests m JOIN properties p ON p.id = m.property_id WHERE m.id = ? AND p.owner_id = ?
    `).get(req.params.id, owner.id);
    if (!request) throw apiError(404, 'Maintenance request not found');
    const { amount, date } = req.body;
    if (!amount || !date) throw apiError(400, 'Amount and date are required');
    const amountCents = dollarsToCents(amount);
    db.prepare(`
      INSERT INTO transactions (property_id, type, direction, amount_cents, category, description, txn_date, is_operating)
      VALUES (?, 'expense', 'out', ?, 'Maintenance', ?, ?, 1)
    `).run(request.property_id, amountCents, `Maintenance: ${request.title}`, date);
    db.prepare('UPDATE maintenance_requests SET actual_cost_cents = ? WHERE id = ?').run(amountCents, request.id);
    sendJson(res, 200, serializeRequest(db, db.prepare('SELECT * FROM maintenance_requests WHERE id = ?').get(request.id)));
  });
}

function attachPhotos(db, propertyId, requestId, images) {
  if (!Array.isArray(images) || images.length === 0) return;
  const destDir = path.join(UPLOADS_DIR, 'properties', String(propertyId), 'maintenance');
  for (const dataUrl of images) {
    const filename = saveBase64Image(dataUrl, destDir, 'maint');
    db.prepare('INSERT INTO maintenance_photos (maintenance_request_id, file_path) VALUES (?, ?)').run(requestId, filename);
  }
}

module.exports = { registerMaintenanceRoutes, serializeRequest, attachPhotos, PRIORITIES, STATUSES };

const path = require('path');
const fs = require('fs');
const { apiError, sendJson } = require('../lib/router');
const { requireAuth, getOwnedPropertyOr404, logAudit, saveBase64Image } = require('../lib/helpers');
const { ensureChargesGenerated } = require('../lib/chargeGenerator');
const { getChargeStatus, summarizeStatuses } = require('../lib/rentStatus');
const { todayInTimezone } = require('../lib/dates');
const { serializeAccount } = require('./bankAccounts');

const { UPLOADS_DIR } = require('../db');

function serializeProperty(db, property) {
  // Every account linked to this property, in full (institution, mask,
  // manual-vs-connected, balance type, shared/reconnect flags) — the SAME
  // shape /api/bank-accounts uses, via the one shared serializer, so the
  // property page can show all of them (not just the first) without a
  // second round-trip or a second, drifting copy of this mapping.
  const bankAccountRows = db.prepare(`
    SELECT ba.* FROM bank_accounts ba
    JOIN property_bank_accounts pba ON pba.bank_account_id = ba.id
    WHERE pba.property_id = ? ORDER BY ba.nickname
  `).all(property.id);
  const bankAccounts = bankAccountRows.map((r) => serializeAccount(db, r));

  const lease = db.prepare("SELECT * FROM leases WHERE property_id = ? AND status = 'active' LIMIT 1").get(property.id);
  let rentStatus = { status: 'paid', noCharges: true };
  let currentChargeSummary = null;
  let monthlyRentCents = 0;
  let olderOutstandingCents = 0;

  if (lease) {
    ensureChargesGenerated(db, lease.id, property.timezone);
    const today = todayInTimezone(property.timezone);
    const history = db.prepare('SELECT rent_cents, effective_date FROM lease_rent_history WHERE lease_id = ? ORDER BY effective_date DESC LIMIT 1').get(lease.id);
    monthlyRentCents = history ? history.rent_cents : 0;

    const charges = db.prepare('SELECT * FROM charges WHERE lease_id = ? ORDER BY period_start DESC').all(lease.id);
    const statuses = charges.map((c) => {
      const payments = db.prepare('SELECT * FROM payments WHERE charge_id = ?').all(c.id);
      return getChargeStatus(c, payments, today).status;
    });
    rentStatus = summarizeStatuses(statuses);

    if (charges.length > 0) {
      const current = charges[0];
      const payments = db.prepare('SELECT * FROM payments WHERE charge_id = ?').all(current.id);
      const result = getChargeStatus(current, payments, today);
      currentChargeSummary = {
        chargeId: current.id,
        periodStart: current.period_start,
        periodEnd: current.period_end,
        dueDate: current.due_date,
        lateDate: current.late_date,
        amountCents: current.amount_cents,
        paidCents: result.netPaid,
        outstandingCents: result.outstanding,
        status: result.status,
      };

      // "Owed this period" only ever describes the current charge — but an
      // older, unrelated shortfall (say last month's rent was only paid
      // halfway) is still real money owed and easy to miss if we only ever
      // surface the current period. Sum what's left on every OTHER charge so
      // the UI can flag it, however the current period is doing.
      for (let i = 1; i < charges.length; i++) {
        const c = charges[i];
        const cPayments = db.prepare('SELECT * FROM payments WHERE charge_id = ?').all(c.id);
        olderOutstandingCents += getChargeStatus(c, cPayments, today).outstanding;
      }
    }
  }

  return {
    id: property.id,
    name: property.name,
    address: {
      line1: property.address_line1, line2: property.address_line2,
      city: property.city, state: property.state, zip: property.zip,
    },
    timezone: property.timezone,
    coverPhotoUrl: property.cover_photo_path ? `/uploads/properties/${property.id}/${property.cover_photo_path}` : null,
    coverFocal: { x: property.cover_focal_x, y: property.cover_focal_y },
    status: property.status,
    isSample: !!property.is_sample,
    archivedAt: property.archived_at,
    occupancyStatus: lease ? 'occupied' : 'vacant',
    currentTenant: lease ? { id: lease.id, name: lease.tenant_name } : null,
    monthlyRentCents,
    rentStatus: rentStatus.status,
    hasNoLeaseYet: !lease,
    currentCharge: currentChargeSummary,
    olderOutstandingCents,
    bankAccounts,
  };
}

function registerPropertyRoutes(router, { db }) {
  router.get('/api/properties', async (req, res) => {
    const owner = requireAuth(db, req);
    const status = req.query.status === 'archived' ? 'archived' : 'active';
    let rows = db.prepare('SELECT * FROM properties WHERE owner_id = ? AND status = ?').all(owner.id, status);

    if (req.query.q) {
      const q = req.query.q.toLowerCase();
      rows = rows.filter((p) =>
        p.name.toLowerCase().includes(q) ||
        (p.address_line1 || '').toLowerCase().includes(q) ||
        (p.city || '').toLowerCase().includes(q)
      );
    }

    let serialized = rows.map((p) => serializeProperty(db, p));

    if (req.query.occupancy === 'occupied') serialized = serialized.filter((p) => p.occupancyStatus === 'occupied');
    if (req.query.occupancy === 'vacant') serialized = serialized.filter((p) => p.occupancyStatus === 'vacant');
    if (req.query.rentStatus) serialized = serialized.filter((p) => p.rentStatus === req.query.rentStatus);

    const sort = req.query.sort || 'name';
    const dir = req.query.dir === 'desc' ? -1 : 1;
    serialized.sort((a, b) => {
      if (sort === 'rent') return dir * (a.monthlyRentCents - b.monthlyRentCents);
      if (sort === 'status') return dir * a.rentStatus.localeCompare(b.rentStatus);
      return dir * a.name.localeCompare(b.name);
    });

    sendJson(res, 200, serialized);
  });

  router.post('/api/properties', async (req, res) => {
    const owner = requireAuth(db, req);
    const { name, addressLine1, addressLine2, city, state, zip, timezone } = req.body;
    if (!name || !name.trim()) throw apiError(400, 'Property name is required');

    const result = db.prepare(`
      INSERT INTO properties (owner_id, name, address_line1, address_line2, city, state, zip, timezone)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(owner.id, name.trim(), addressLine1 || null, addressLine2 || null, city || null, state || null, zip || null, timezone || 'America/Denver');

    db.prepare('INSERT INTO units (property_id, label) VALUES (?, ?)').run(result.lastInsertRowid, 'Main');
    logAudit(db, { actorType: 'owner', actorId: owner.id, action: 'create', entityType: 'property', entityId: result.lastInsertRowid, after: req.body });

    const property = db.prepare('SELECT * FROM properties WHERE id = ?').get(result.lastInsertRowid);
    sendJson(res, 201, serializeProperty(db, property));
  });

  router.get('/api/properties/:id', async (req, res) => {
    const owner = requireAuth(db, req);
    const property = getOwnedPropertyOr404(db, owner.id, req.params.id);
    sendJson(res, 200, serializeProperty(db, property));
  });

  router.put('/api/properties/:id', async (req, res) => {
    const owner = requireAuth(db, req);
    const before = getOwnedPropertyOr404(db, owner.id, req.params.id);
    const { name, addressLine1, addressLine2, city, state, zip, timezone } = req.body;
    if (!name || !name.trim()) throw apiError(400, 'Property name is required');

    db.prepare(`
      UPDATE properties SET name=?, address_line1=?, address_line2=?, city=?, state=?, zip=?, timezone=?, updated_at=datetime('now')
      WHERE id = ?
    `).run(name.trim(), addressLine1 || null, addressLine2 || null, city || null, state || null, zip || null, timezone || before.timezone, before.id);

    logAudit(db, { actorType: 'owner', actorId: owner.id, action: 'update', entityType: 'property', entityId: before.id, before, after: req.body });
    const updated = db.prepare('SELECT * FROM properties WHERE id = ?').get(before.id);
    sendJson(res, 200, serializeProperty(db, updated));
  });

  router.post('/api/properties/:id/archive', async (req, res) => {
    const owner = requireAuth(db, req);
    const property = getOwnedPropertyOr404(db, owner.id, req.params.id);
    db.prepare("UPDATE properties SET status='archived', archived_at=datetime('now') WHERE id=?").run(property.id);
    logAudit(db, { actorType: 'owner', actorId: owner.id, action: 'archive', entityType: 'property', entityId: property.id });
    sendJson(res, 200, { ok: true });
  });

  router.post('/api/properties/:id/unarchive', async (req, res) => {
    const owner = requireAuth(db, req);
    const property = getOwnedPropertyOr404(db, owner.id, req.params.id);
    db.prepare("UPDATE properties SET status='active', archived_at=NULL WHERE id=?").run(property.id);
    logAudit(db, { actorType: 'owner', actorId: owner.id, action: 'unarchive', entityType: 'property', entityId: property.id });
    sendJson(res, 200, { ok: true });
  });

  // Cover photo is sent as a base64 data URL in JSON (simplest reliable upload
  // path without adding a multipart-parsing dependency). Reposition just saves
  // a focal point used by the frontend's CSS object-position.
  router.post('/api/properties/:id/cover-photo', async (req, res) => {
    const owner = requireAuth(db, req);
    const property = getOwnedPropertyOr404(db, owner.id, req.params.id);
    const { dataUrl } = req.body;
    if (!dataUrl) throw apiError(400, 'No image data received');

    const destDir = path.join(UPLOADS_DIR, 'properties', String(property.id));
    const filename = saveBase64Image(dataUrl, destDir, 'cover');

    if (property.cover_photo_path) {
      const oldPath = path.join(destDir, property.cover_photo_path);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }

    db.prepare("UPDATE properties SET cover_photo_path=?, cover_focal_x=50, cover_focal_y=50, updated_at=datetime('now') WHERE id=?").run(filename, property.id);
    logAudit(db, { actorType: 'owner', actorId: owner.id, action: 'update_cover_photo', entityType: 'property', entityId: property.id });
    sendJson(res, 200, { coverPhotoUrl: `/uploads/properties/${property.id}/${filename}` });
  });

  router.put('/api/properties/:id/cover-focal', async (req, res) => {
    const owner = requireAuth(db, req);
    const property = getOwnedPropertyOr404(db, owner.id, req.params.id);
    const x = Math.max(0, Math.min(100, Number(req.body.x)));
    const y = Math.max(0, Math.min(100, Number(req.body.y)));
    db.prepare('UPDATE properties SET cover_focal_x=?, cover_focal_y=? WHERE id=?').run(x, y, property.id);
    sendJson(res, 200, { x, y });
  });
}

module.exports = { registerPropertyRoutes, serializeProperty, UPLOADS_DIR };

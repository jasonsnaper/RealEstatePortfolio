const { apiError, sendJson } = require('../lib/router');
const { requireAuth, logAudit } = require('../lib/helpers');
const { ensureChargesGenerated } = require('../lib/chargeGenerator');
const { todayInTimezone } = require('../lib/dates');
const { generateStatement, serializeStatement } = require('../lib/statements');
const fs = require('fs');
const path = require('path');
const { UPLOADS_DIR } = require('../db');

const RANGE_TYPES = ['month', 'year', 'lease_to_date', 'custom'];

// Deliberately its own small lookup rather than importing one from
// paymentLinks.js/renterManagement.js — see renterPortal.js's header comment
// on safeCharge/safeLease for why this codebase prefers a few duplicated
// three-line queries over a shared helper that couples unrelated route files.
function getOwnedLeaseWithPropertyOr404(db, ownerId, leaseId) {
  const row = db.prepare(`
    SELECT l.*, p.owner_id AS property_owner_id, p.name AS property_name, p.is_sample AS property_is_sample,
           p.address_line1, p.address_line2, p.city, p.state, p.zip, p.timezone
    FROM leases l JOIN properties p ON p.id = l.property_id
    WHERE l.id = ? AND p.owner_id = ?
  `).get(leaseId, ownerId);
  if (!row) throw apiError(404, 'Lease not found');
  const property = {
    id: row.property_id, name: row.property_name, address_line1: row.address_line1,
    address_line2: row.address_line2, city: row.city, state: row.state, zip: row.zip, timezone: row.timezone,
    is_sample: row.property_is_sample,
  };
  return { lease: row, property };
}

function lastDayOfMonth(year, month) {
  // Day 0 of the next month == the last day of this one; UTC avoids any
  // local-timezone drift shifting the date by a day near midnight.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Turns the owner's simplified range picker input into concrete rangeStart/rangeEnd dates. */
function resolveRange(lease, timezone, body) {
  const rangeType = body.rangeType;
  if (rangeType === 'month') {
    if (!/^\d{4}-\d{2}$/.test(body.month || '')) throw apiError(400, '"month" must be in YYYY-MM format');
    const [y, m] = body.month.split('-').map(Number);
    return { rangeType, rangeStart: `${body.month}-01`, rangeEnd: `${body.month}-${String(lastDayOfMonth(y, m)).padStart(2, '0')}` };
  }
  if (rangeType === 'year') {
    const year = Number(body.year);
    if (!Number.isInteger(year) || year < 1900 || year > 9999) throw apiError(400, '"year" is required');
    return { rangeType, rangeStart: `${year}-01-01`, rangeEnd: `${year}-12-31` };
  }
  if (rangeType === 'lease_to_date') {
    // For an ended lease, "to date" means to the lease's own end date, not
    // to today — charges can exist for periods after move-out (generated
    // while the lease was still active, before the owner got around to
    // recording when it actually ended), and a statement should never
    // present those as part of the tenancy.
    const end = lease.status === 'ended' && lease.end_date ? lease.end_date : todayInTimezone(timezone || 'America/Denver');
    return { rangeType, rangeStart: lease.start_date, rangeEnd: end };
  }
  if (rangeType === 'custom') {
    if (!body.rangeStart || !body.rangeEnd) throw apiError(400, 'rangeStart and rangeEnd are required for a custom range');
    if (body.rangeStart > body.rangeEnd) throw apiError(400, 'rangeStart must not be after rangeEnd');
    return { rangeType, rangeStart: body.rangeStart, rangeEnd: body.rangeEnd };
  }
  throw apiError(400, `rangeType must be one of: ${RANGE_TYPES.join(', ')}`);
}

function registerStatementRoutes(router, { db }) {
  router.get('/api/leases/:id/statements', async (req, res) => {
    const owner = requireAuth(db, req);
    const { lease } = getOwnedLeaseWithPropertyOr404(db, owner.id, req.params.id);
    const rows = db.prepare('SELECT * FROM payment_statements WHERE lease_id = ? ORDER BY created_at DESC').all(lease.id);
    // The renter-facing equivalent (renterPortal.js) already includes this —
    // add it here too so the owner's own statement list can link to a
    // download without the frontend having to reconstruct the upload path
    // itself (property id + file path, same static-file route either way).
    sendJson(res, 200, rows.map((s) => ({ ...serializeStatement(s), url: `/uploads/properties/${lease.property_id}/statements/${s.file_path}` })));
  });

  // Generates a new statement PDF and records it. Never edits or replaces an
  // earlier one — each call is a fresh, independent snapshot (see db.js's
  // payment_statements comment), so re-running this after correcting the
  // ledger deliberately produces a second, more-accurate statement rather
  // than silently rewriting one a renter may already have downloaded.
  router.post('/api/leases/:id/statements', async (req, res) => {
    const owner = requireAuth(db, req);
    const { lease, property } = getOwnedLeaseWithPropertyOr404(db, owner.id, req.params.id);
    if (lease.status === 'active') ensureChargesGenerated(db, lease.id, lease.timezone);
    const { rangeType, rangeStart, rangeEnd } = resolveRange(lease, lease.timezone, req.body || {});

    const statement = generateStatement(db, {
      lease, property, rangeType, rangeStart, rangeEnd,
      generatedBy: 'owner', generatedByRenterId: null, isSample: !!property.is_sample,
    });
    logAudit(db, { actorType: 'owner', actorId: owner.id, action: 'generate_statement', entityType: 'payment_statement', entityId: statement.id, after: { leaseId: lease.id, rangeType, rangeStart, rangeEnd } });
    sendJson(res, 201, serializeStatement(statement));
  });

  // Toggles whether this statement shows up in the renter's own portal —
  // separate from generating it, so an owner can look a statement over
  // before a renter ever sees it exists.
  router.post('/api/statements/:id/share', async (req, res) => {
    const owner = requireAuth(db, req);
    const statement = db.prepare(`
      SELECT ps.* FROM payment_statements ps JOIN leases l ON l.id = ps.lease_id JOIN properties p ON p.id = l.property_id
      WHERE ps.id = ? AND p.owner_id = ?
    `).get(req.params.id, owner.id);
    if (!statement) throw apiError(404, 'Statement not found');
    const shared = req.body.shared !== false;
    db.prepare('UPDATE payment_statements SET shared_with_renter = ? WHERE id = ?').run(shared ? 1 : 0, statement.id);
    logAudit(db, { actorType: 'owner', actorId: owner.id, action: shared ? 'share_statement' : 'unshare_statement', entityType: 'payment_statement', entityId: statement.id });
    sendJson(res, 200, serializeStatement(db.prepare('SELECT * FROM payment_statements WHERE id = ?').get(statement.id)));
  });

  // Same honest stand-in as every other "email" action in this app (see
  // renterAuth.js's forgot-password/invite routes): no email provider is
  // configured, so this logs the notice to the server console/logs instead
  // of actually sending anything, and says so in the response rather than
  // implying a real email went out. Emailing also shares the statement (a
  // renter can't usefully be emailed a link to something their own portal
  // hides), which is a real state change worth being explicit about too.
  router.post('/api/statements/:id/email', async (req, res) => {
    const owner = requireAuth(db, req);
    const statement = db.prepare(`
      SELECT ps.*, l.tenant_name, l.tenant_email FROM payment_statements ps
      JOIN leases l ON l.id = ps.lease_id JOIN properties p ON p.id = l.property_id
      WHERE ps.id = ? AND p.owner_id = ?
    `).get(req.params.id, owner.id);
    if (!statement) throw apiError(404, 'Statement not found');

    const recipients = db.prepare(`
      SELECT DISTINCT r.email FROM lease_renters lr JOIN renters r ON r.id = lr.renter_id
      WHERE lr.lease_id = ? AND r.email IS NOT NULL
    `).all(statement.lease_id).map((r) => r.email);
    const to = req.body.to || recipients[0] || statement.tenant_email;
    if (!to) throw apiError(400, 'No email address on file for this tenant — add one first, or pass "to" explicitly.');

    db.prepare("UPDATE payment_statements SET shared_with_renter = 1, emailed_at = datetime('now'), emailed_to = ? WHERE id = ?").run(to, statement.id);
    console.log(`\n[Statement email] Statement #${statement.id} (${statement.range_start} to ${statement.range_end}) for ${statement.tenant_name} would be emailed to ${to}. No email provider is configured — see README.\n`);
    logAudit(db, { actorType: 'owner', actorId: owner.id, action: 'email_statement', entityType: 'payment_statement', entityId: statement.id, after: { to } });
    sendJson(res, 200, { ok: true, simulated: true, to, statement: serializeStatement(db.prepare('SELECT * FROM payment_statements WHERE id = ?').get(statement.id)) });
  });

  router.delete('/api/statements/:id', async (req, res) => {
    const owner = requireAuth(db, req);
    const statement = db.prepare(`
      SELECT ps.*, l.property_id FROM payment_statements ps JOIN leases l ON l.id = ps.lease_id JOIN properties p ON p.id = l.property_id
      WHERE ps.id = ? AND p.owner_id = ?
    `).get(req.params.id, owner.id);
    if (!statement) throw apiError(404, 'Statement not found');
    const filePath = path.join(UPLOADS_DIR, 'properties', String(statement.property_id), 'statements', statement.file_path);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    db.prepare('DELETE FROM payment_statements WHERE id = ?').run(statement.id);
    logAudit(db, { actorType: 'owner', actorId: owner.id, action: 'delete_statement', entityType: 'payment_statement', entityId: statement.id });
    sendJson(res, 200, { ok: true });
  });
}

module.exports = { registerStatementRoutes, RANGE_TYPES };

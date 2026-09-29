const { apiError, sendJson } = require('../lib/router');
const { requireAuth, getOwnedPropertyOr404, runInTransaction, logAudit } = require('../lib/helpers');
const { createRenterToken } = require('../lib/renterAuth');
const { findOrCreateRenter, serializeRenter } = require('../lib/renters');

const ROLES = ['primary', 'co_renter'];

function getOwnedLeaseOr404(db, ownerId, leaseId) {
  const lease = db.prepare(`
    SELECT l.*, p.owner_id, p.name AS property_name FROM leases l JOIN properties p ON p.id = l.property_id
    WHERE l.id = ? AND p.owner_id = ?
  `).get(leaseId, ownerId);
  if (!lease) throw apiError(404, 'Lease not found');
  return lease;
}

function serializeLeaseRenter(row) {
  return { ...serializeRenter(row), role: row.role, leaseRenterId: row.lease_renter_id };
}

function registerRenterManagementRoutes(router, { db, appBaseUrl }) {
  router.get('/api/leases/:id/renters', async (req, res) => {
    const owner = requireAuth(db, req);
    const lease = getOwnedLeaseOr404(db, owner.id, req.params.id);
    const rows = db.prepare(`
      SELECT r.*, lr.role AS role, lr.id AS lease_renter_id FROM lease_renters lr
      JOIN renters r ON r.id = lr.renter_id WHERE lr.lease_id = ? ORDER BY lr.role, r.name
    `).all(lease.id);
    sendJson(res, 200, rows.map(serializeLeaseRenter));
  });

  // Adds (or links an existing, by-email-matched) renter to this lease. This
  // alone is enough for the owner to track them — a renter identity works
  // fully with password_hash NULL forever; nothing here requires inviting
  // them to the portal. See renters/:id/invite below for that separate step.
  router.post('/api/leases/:id/renters', async (req, res) => {
    const owner = requireAuth(db, req);
    const lease = getOwnedLeaseOr404(db, owner.id, req.params.id);
    const { name, email, phone, role } = req.body;
    if (!name || !name.trim()) throw apiError(400, 'Name is required');
    const chosenRole = ROLES.includes(role) ? role : 'co_renter';

    const renter = findOrCreateRenter(db, owner.id, { name, email, phone });
    const result = db.prepare('INSERT OR IGNORE INTO lease_renters (lease_id, renter_id, role) VALUES (?, ?, ?)').run(lease.id, renter.id, chosenRole);
    if (result.changes === 0) throw apiError(409, `${renter.name} is already on this lease`);

    logAudit(db, { actorType: 'owner', actorId: owner.id, action: 'add_renter', entityType: 'lease_renter', entityId: renter.id, after: { leaseId: lease.id, role: chosenRole } });
    const row = db.prepare(`
      SELECT r.*, lr.role AS role, lr.id AS lease_renter_id FROM lease_renters lr JOIN renters r ON r.id = lr.renter_id
      WHERE lr.lease_id = ? AND lr.renter_id = ?
    `).get(lease.id, renter.id);
    sendJson(res, 201, serializeLeaseRenter(row));
  });

  router.delete('/api/leases/:id/renters/:renterId', async (req, res) => {
    const owner = requireAuth(db, req);
    const lease = getOwnedLeaseOr404(db, owner.id, req.params.id);
    const result = db.prepare('DELETE FROM lease_renters WHERE lease_id = ? AND renter_id = ?').run(lease.id, req.params.renterId);
    if (result.changes === 0) throw apiError(404, 'This renter is not on this lease');
    logAudit(db, { actorType: 'owner', actorId: owner.id, action: 'remove_renter', entityType: 'lease_renter', entityId: Number(req.params.renterId), before: { leaseId: lease.id } });
    sendJson(res, 200, { ok: true });
  });

  // Generates an invitation link the owner copies and sends themselves (no
  // email provider is configured — see README). Refuses to re-invite someone
  // who already has a working login; use forgot-password for "I lost my
  // password", not a fresh invite.
  router.post('/api/leases/:id/renters/:renterId/invite', async (req, res) => {
    const owner = requireAuth(db, req);
    const lease = getOwnedLeaseOr404(db, owner.id, req.params.id);
    const membership = db.prepare(`
      SELECT r.*, lr.role AS role FROM lease_renters lr JOIN renters r ON r.id = lr.renter_id WHERE lr.lease_id = ? AND lr.renter_id = ?
    `).get(lease.id, req.params.renterId);
    if (!membership) throw apiError(404, 'This renter is not on this lease');
    if (membership.password_hash) throw apiError(409, `${membership.name} already has a portal account. Use "resend" only if they haven't set a password yet.`);
    if (!membership.email) throw apiError(400, 'Add an email address for this renter before inviting them — the invitation link needs somewhere to be sent.');

    const token = createRenterToken(db, membership.id, 'invitation', { leaseId: lease.id, role: membership.role });
    const url = `${appBaseUrl}/renter#/accept-invite/${token}`;
    console.log(`\n[Renter invitation] ${membership.name} <${membership.email}> invited to ${lease.property_name}. Link (valid 14 days): ${url}\n`);
    logAudit(db, { actorType: 'owner', actorId: owner.id, action: 'invite_renter', entityType: 'renter', entityId: membership.id, after: { leaseId: lease.id } });
    sendJson(res, 201, { url, expiresInDays: 14 });
  });

  // All of this owner's renters across every property — used for the
  // "Renters" directory and for picking merge candidates. Small portfolios
  // only; no pagination attempted.
  router.get('/api/renters', async (req, res) => {
    const owner = requireAuth(db, req);
    const rows = db.prepare('SELECT * FROM renters WHERE owner_id = ? AND merged_into_renter_id IS NULL ORDER BY name').all(owner.id);
    const withLeases = rows.map((r) => {
      const leases = db.prepare(`
        SELECT l.id, l.status, p.name AS property_name, lr.role FROM lease_renters lr
        JOIN leases l ON l.id = lr.lease_id JOIN properties p ON p.id = l.property_id
        WHERE lr.renter_id = ? ORDER BY l.start_date DESC
      `).all(r.id);
      return { ...serializeRenter(r), leases: leases.map((l) => ({ leaseId: l.id, propertyName: l.property_name, role: l.role, status: l.status })) };
    });
    sendJson(res, 200, withLeases);
  });

  // Merges a duplicate renter identity into another: every lease link the
  // duplicate had is reassigned to the kept renter (skipping any lease the
  // kept renter is already on, rather than erroring, since that's the whole
  // point of a merge), the duplicate's sessions are invalidated, and the
  // duplicate is marked merged_into_renter_id so anything referencing its old
  // id (an old session, an old share) still resolves correctly. Never
  // deletes a row outright — see db.js's schema comment on renters.
  router.post('/api/renters/merge', async (req, res) => {
    const owner = requireAuth(db, req);
    const { keepRenterId, mergeRenterId } = req.body;
    if (!keepRenterId || !mergeRenterId) throw apiError(400, 'Both renters are required');
    if (String(keepRenterId) === String(mergeRenterId)) throw apiError(400, 'Choose two different renters to merge');
    const keep = db.prepare('SELECT * FROM renters WHERE id = ? AND owner_id = ?').get(keepRenterId, owner.id);
    const merge = db.prepare('SELECT * FROM renters WHERE id = ? AND owner_id = ?').get(mergeRenterId, owner.id);
    if (!keep || !merge) throw apiError(404, 'Renter not found');
    if (merge.merged_into_renter_id) throw apiError(409, `${merge.name} was already merged into another renter`);

    runInTransaction(db, () => {
      const memberships = db.prepare('SELECT * FROM lease_renters WHERE renter_id = ?').all(merge.id);
      for (const m of memberships) {
        db.prepare('INSERT OR IGNORE INTO lease_renters (lease_id, renter_id, role) VALUES (?, ?, ?)').run(m.lease_id, keep.id, m.role);
      }
      db.prepare('DELETE FROM lease_renters WHERE renter_id = ?').run(merge.id);
      // Existing shares/statements pointing at the old renter id stay valid —
      // they reference merge.id directly, and requireRenterAuth resolves a
      // merged-away id's session to the kept renter transparently — but any
      // renter-scoped document share is repointed so it shows up for the
      // kept identity going forward rather than an id nothing signs into
      // anymore. Sessions are deliberately left alone (NOT deleted): a merge
      // is the owner tidying up a duplicate identity behind the scenes, not a
      // security event, so a renter mid-session should never be silently
      // logged out by it — requireRenterAuth's merged_into_renter_id check
      // exists specifically to make an old session keep working here.
      db.prepare('UPDATE document_shares SET renter_id = ? WHERE renter_id = ?').run(keep.id, merge.id);
      db.prepare("UPDATE renters SET merged_into_renter_id = ?, updated_at = datetime('now') WHERE id = ?").run(keep.id, merge.id);
    });

    logAudit(db, { actorType: 'owner', actorId: owner.id, action: 'merge_renters', entityType: 'renter', entityId: keep.id, before: { mergedId: merge.id } });
    sendJson(res, 200, serializeRenter(db.prepare('SELECT * FROM renters WHERE id = ?').get(keep.id)));
  });
}

module.exports = { registerRenterManagementRoutes };

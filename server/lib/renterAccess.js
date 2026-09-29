// Authorization + safe-projection helpers shared by the renter portal routes
// (server/routes/renterPortal.js) and the uploaded-file access check
// (server/index.js's authorizeUploadAccess). Everything here answers "is this
// renter allowed to see this X", never "what does the owner see" — see
// server/routes/tenantPortal.js's header comment for why that distinction is
// enforced structurally (explicit allowlists) rather than by convention.

const { apiError } = require('./router');

/** Every lease id this renter currently has (any role, active or ended — historical access is intentional, see README). */
function renterLeaseIds(db, renterId) {
  return db.prepare('SELECT lease_id FROM lease_renters WHERE renter_id = ?').all(renterId).map((r) => r.lease_id);
}

/** Fetch a lease + its property, confirming this renter is actually linked to it. Throws 404 (never 403) so a guessed lease id can't be distinguished from a nonexistent one. */
function getRenterLeaseOr404(db, renterId, leaseId) {
  const lease = db.prepare(`
    SELECT l.*, p.id AS property_id, p.name AS property_name, p.address_line1, p.address_line2, p.city, p.state, p.zip, p.timezone
    FROM leases l
    JOIN properties p ON p.id = l.property_id
    JOIN lease_renters lr ON lr.lease_id = l.id
    WHERE l.id = ? AND lr.renter_id = ?
  `).get(leaseId, renterId);
  if (!lease) throw apiError(404, 'Lease not found');
  return lease;
}

/** True if this renter may see this specific document, via an explicit lease-scoped or renter-scoped share. Never true just because the renter is on SOME lease at the property — sharing is per-document, per-lease/renter, by design (see db.js's document_shares table comment). */
function renterCanSeeDocument(db, renterId, documentId) {
  const leaseIds = renterLeaseIds(db, renterId);
  const row = db.prepare(`
    SELECT ds.id FROM document_shares ds
    WHERE ds.document_id = ? AND (
      ds.renter_id = ? OR ds.lease_id IN (${leaseIds.length ? leaseIds.map(() => '?').join(',') : 'NULL'})
    )
    LIMIT 1
  `).get(documentId, renterId, ...leaseIds);
  return !!row;
}

/** Documents visible to this renter for one specific lease: shared with that lease, or shared with the renter individually (e.g. a former co-renter's own copy kept after the lease's other renter moved on). */
function documentsVisibleForLease(db, renterId, leaseId) {
  return db.prepare(`
    SELECT DISTINCT d.* FROM documents d
    JOIN document_shares ds ON ds.document_id = d.id
    WHERE ds.lease_id = ? OR ds.renter_id = ?
    ORDER BY d.uploaded_at DESC
  `).all(leaseId, renterId);
}

module.exports = { renterLeaseIds, getRenterLeaseOr404, renterCanSeeDocument, documentsVisibleForLease };

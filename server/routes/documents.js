const path = require('path');
const fs = require('fs');
const { apiError, sendJson } = require('../lib/router');
const { requireAuth, getOwnedPropertyOr404, saveBase64Document, logAudit } = require('../lib/helpers');

const { UPLOADS_DIR } = require('../db');
const CATEGORIES = ['lease', 'lease_amendment', 'insurance', 'tax', 'inspection', 'invoice', 'receipt', 'mortgage_statement', 'other'];

// Sharing model: a document is visible to a renter only through an explicit
// row in document_shares, scoped to either a specific lease (every renter
// currently on it) or a specific renter (kept visible to just them, e.g.
// after their co-renter moved out — see db.js's table comment). The old
// documents.is_shared_with_tenant boolean still exists on the row (never
// deleted — some installs may still read it directly) but is no longer the
// enforced source of truth; needs_sharing_review flags a document the v6->v7
// migration couldn't safely carry forward on its own (see db.js).

function serializeDocument(db, doc) {
  const shares = db.prepare(`
    SELECT ds.id, ds.lease_id, ds.renter_id, l.tenant_name AS lease_tenant_name, r.name AS renter_name
    FROM document_shares ds
    LEFT JOIN leases l ON l.id = ds.lease_id
    LEFT JOIN renters r ON r.id = ds.renter_id
    WHERE ds.document_id = ?
  `).all(doc.id);
  return {
    id: doc.id,
    filename: doc.filename,
    url: `/uploads/properties/${doc.property_id}/documents/${doc.file_path}`,
    category: doc.category,
    expirationDate: doc.expiration_date,
    isSharedWithTenant: !!doc.is_shared_with_tenant, // legacy field, kept for anything still reading it directly
    needsSharingReview: !!doc.needs_sharing_review,
    uploadedAt: doc.uploaded_at,
    shares: shares.map((s) => ({
      id: s.id,
      leaseId: s.lease_id || null,
      renterId: s.renter_id || null,
      label: s.lease_id ? (s.lease_tenant_name || 'Lease #' + s.lease_id) : (s.renter_name || 'Renter #' + s.renter_id),
    })),
  };
}

function registerDocumentRoutes(router, { db }) {
  router.get('/api/properties/:id/documents', async (req, res) => {
    const owner = requireAuth(db, req);
    const property = getOwnedPropertyOr404(db, owner.id, req.params.id);
    let rows = db.prepare('SELECT * FROM documents WHERE property_id = ? ORDER BY uploaded_at DESC').all(property.id);
    if (req.query.category) rows = rows.filter((d) => d.category === req.query.category);
    sendJson(res, 200, rows.map((d) => serializeDocument(db, d)));
  });

  // shareWithLeaseIds (optional): share immediately at upload time, so the
  // common case ("here's the new lease amendment, share it with them") is one
  // action instead of two. Omit it (or pass []) to upload privately.
  router.post('/api/properties/:id/documents', async (req, res) => {
    const owner = requireAuth(db, req);
    const property = getOwnedPropertyOr404(db, owner.id, req.params.id);
    const { dataUrl, filename, category, expirationDate, shareWithLeaseIds } = req.body;
    if (!dataUrl || !filename) throw apiError(400, 'File data and filename are required');
    if (category && !CATEGORIES.includes(category)) throw apiError(400, `Category must be one of: ${CATEGORIES.join(', ')}`);

    const destDir = path.join(UPLOADS_DIR, 'properties', String(property.id), 'documents');
    const storedName = saveBase64Document(dataUrl, destDir, 'doc');

    const result = db.prepare(`
      INSERT INTO documents (property_id, file_path, filename, category, expiration_date, is_shared_with_tenant)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(property.id, storedName, filename, category || 'other', expirationDate || null, Array.isArray(shareWithLeaseIds) && shareWithLeaseIds.length > 0 ? 1 : 0);
    const docId = result.lastInsertRowid;

    if (Array.isArray(shareWithLeaseIds)) {
      applyShares(db, property.id, docId, shareWithLeaseIds, []);
    }

    logAudit(db, { actorType: 'owner', actorId: owner.id, action: 'upload_document', entityType: 'document', entityId: docId, after: { filename, category } });
    sendJson(res, 201, serializeDocument(db, db.prepare('SELECT * FROM documents WHERE id = ?').get(docId)));
  });

  router.put('/api/documents/:id', async (req, res) => {
    const owner = requireAuth(db, req);
    const doc = db.prepare(`
      SELECT d.* FROM documents d JOIN properties p ON p.id = d.property_id WHERE d.id = ? AND p.owner_id = ?
    `).get(req.params.id, owner.id);
    if (!doc) throw apiError(404, 'Document not found');
    const { category, expirationDate } = req.body;
    db.prepare('UPDATE documents SET category=?, expiration_date=? WHERE id=?').run(
      category && CATEGORIES.includes(category) ? category : doc.category,
      expirationDate !== undefined ? expirationDate : doc.expiration_date,
      doc.id
    );
    logAudit(db, { actorType: 'owner', actorId: owner.id, action: 'update_document', entityType: 'document', entityId: doc.id, before: doc, after: req.body });
    sendJson(res, 200, serializeDocument(db, db.prepare('SELECT * FROM documents WHERE id = ?').get(doc.id)));
  });

  // Replaces this document's ENTIRE share list atomically — the explicit
  // "which lease(s)/renter(s) can see this" picker that supersedes the old
  // single is_shared_with_tenant checkbox. Also clears needs_sharing_review:
  // once the owner has explicitly set sharing (even to "nobody"), there's
  // nothing left to review.
  router.put('/api/documents/:id/shares', async (req, res) => {
    const owner = requireAuth(db, req);
    const doc = db.prepare(`
      SELECT d.* FROM documents d JOIN properties p ON p.id = d.property_id WHERE d.id = ? AND p.owner_id = ?
    `).get(req.params.id, owner.id);
    if (!doc) throw apiError(404, 'Document not found');
    const leaseIds = Array.isArray(req.body.leaseIds) ? req.body.leaseIds : [];
    const renterIds = Array.isArray(req.body.renterIds) ? req.body.renterIds : [];

    // Every lease/renter named must actually belong to this document's
    // property/owner — never trust ids from the client blindly.
    for (const leaseId of leaseIds) {
      const ok = db.prepare('SELECT 1 FROM leases WHERE id = ? AND property_id = ?').get(leaseId, doc.property_id);
      if (!ok) throw apiError(400, `Lease ${leaseId} does not belong to this property`);
    }
    for (const renterId of renterIds) {
      const ok = db.prepare('SELECT 1 FROM renters WHERE id = ? AND owner_id = ?').get(renterId, owner.id);
      if (!ok) throw apiError(400, `Renter ${renterId} not found`);
    }

    applyShares(db, doc.property_id, doc.id, leaseIds, renterIds);
    db.prepare('UPDATE documents SET is_shared_with_tenant = ?, needs_sharing_review = 0 WHERE id = ?')
      .run(leaseIds.length > 0 || renterIds.length > 0 ? 1 : 0, doc.id);

    logAudit(db, { actorType: 'owner', actorId: owner.id, action: 'set_document_shares', entityType: 'document', entityId: doc.id, after: { leaseIds, renterIds } });
    sendJson(res, 200, serializeDocument(db, db.prepare('SELECT * FROM documents WHERE id = ?').get(doc.id)));
  });

  router.delete('/api/documents/:id', async (req, res) => {
    const owner = requireAuth(db, req);
    const doc = db.prepare(`
      SELECT d.* FROM documents d JOIN properties p ON p.id = d.property_id WHERE d.id = ? AND p.owner_id = ?
    `).get(req.params.id, owner.id);
    if (!doc) throw apiError(404, 'Document not found');
    const filePath = path.join(UPLOADS_DIR, 'properties', String(doc.property_id), 'documents', doc.file_path);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    db.prepare('DELETE FROM documents WHERE id = ?').run(doc.id);
    logAudit(db, { actorType: 'owner', actorId: owner.id, action: 'delete_document', entityType: 'document', entityId: doc.id });
    sendJson(res, 200, { ok: true });
  });
}

function applyShares(db, propertyId, docId, leaseIds, renterIds) {
  db.prepare('DELETE FROM document_shares WHERE document_id = ?').run(docId);
  const insert = db.prepare('INSERT INTO document_shares (document_id, lease_id, renter_id) VALUES (?, ?, ?)');
  for (const leaseId of leaseIds) insert.run(docId, leaseId, null);
  for (const renterId of renterIds) insert.run(docId, null, renterId);
}

module.exports = { registerDocumentRoutes, serializeDocument, CATEGORIES };

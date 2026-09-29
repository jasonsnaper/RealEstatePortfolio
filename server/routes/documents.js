const path = require('path');
const fs = require('fs');
const { apiError, sendJson } = require('../lib/router');
const { requireAuth, getOwnedPropertyOr404, saveBase64Document, logAudit } = require('../lib/helpers');

const { UPLOADS_DIR } = require('../db');
const CATEGORIES = ['lease', 'lease_amendment', 'insurance', 'tax', 'inspection', 'invoice', 'receipt', 'mortgage_statement', 'other'];

function serializeDocument(doc) {
  return {
    id: doc.id,
    filename: doc.filename,
    url: `/uploads/properties/${doc.property_id}/documents/${doc.file_path}`,
    category: doc.category,
    expirationDate: doc.expiration_date,
    isSharedWithTenant: !!doc.is_shared_with_tenant,
    uploadedAt: doc.uploaded_at,
  };
}

function registerDocumentRoutes(router, { db }) {
  router.get('/api/properties/:id/documents', async (req, res) => {
    const owner = requireAuth(db, req);
    const property = getOwnedPropertyOr404(db, owner.id, req.params.id);
    let rows = db.prepare('SELECT * FROM documents WHERE property_id = ? ORDER BY uploaded_at DESC').all(property.id);
    if (req.query.category) rows = rows.filter((d) => d.category === req.query.category);
    sendJson(res, 200, rows.map(serializeDocument));
  });

  router.post('/api/properties/:id/documents', async (req, res) => {
    const owner = requireAuth(db, req);
    const property = getOwnedPropertyOr404(db, owner.id, req.params.id);
    const { dataUrl, filename, category, expirationDate, isSharedWithTenant } = req.body;
    if (!dataUrl || !filename) throw apiError(400, 'File data and filename are required');
    if (category && !CATEGORIES.includes(category)) throw apiError(400, `Category must be one of: ${CATEGORIES.join(', ')}`);

    const destDir = path.join(UPLOADS_DIR, 'properties', String(property.id), 'documents');
    const storedName = saveBase64Document(dataUrl, destDir, 'doc');

    const result = db.prepare(`
      INSERT INTO documents (property_id, file_path, filename, category, expiration_date, is_shared_with_tenant)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(property.id, storedName, filename, category || 'other', expirationDate || null, isSharedWithTenant ? 1 : 0);

    logAudit(db, { actorType: 'owner', actorId: owner.id, action: 'upload_document', entityType: 'document', entityId: result.lastInsertRowid, after: { filename, category } });
    sendJson(res, 201, serializeDocument(db.prepare('SELECT * FROM documents WHERE id = ?').get(result.lastInsertRowid)));
  });

  router.put('/api/documents/:id', async (req, res) => {
    const owner = requireAuth(db, req);
    const doc = db.prepare(`
      SELECT d.* FROM documents d JOIN properties p ON p.id = d.property_id WHERE d.id = ? AND p.owner_id = ?
    `).get(req.params.id, owner.id);
    if (!doc) throw apiError(404, 'Document not found');
    const { category, expirationDate, isSharedWithTenant } = req.body;
    db.prepare('UPDATE documents SET category=?, expiration_date=?, is_shared_with_tenant=? WHERE id=?').run(
      category && CATEGORIES.includes(category) ? category : doc.category,
      expirationDate !== undefined ? expirationDate : doc.expiration_date,
      isSharedWithTenant != null ? (isSharedWithTenant ? 1 : 0) : doc.is_shared_with_tenant,
      doc.id
    );
    logAudit(db, { actorType: 'owner', actorId: owner.id, action: 'update_document', entityType: 'document', entityId: doc.id, before: doc, after: req.body });
    sendJson(res, 200, serializeDocument(db.prepare('SELECT * FROM documents WHERE id = ?').get(doc.id)));
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

module.exports = { registerDocumentRoutes, serializeDocument, CATEGORIES };

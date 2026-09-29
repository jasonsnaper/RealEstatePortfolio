const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { apiError, sendJson } = require('../lib/router');
const { requireAuth, getOwnedPropertyOr404, saveBase64Image, logAudit } = require('../lib/helpers');

const UPLOADS_DIR = path.join(__dirname, '..', '..', 'public', 'uploads');
const ALBUMS = ['move-in', 'move-out', 'inspection', 'repair', 'receipt', 'general'];

function serializePhoto(photo) {
  return {
    id: photo.id,
    url: `/uploads/properties/${photo.property_id}/photos/${photo.file_path}`,
    caption: photo.caption,
    album: photo.album,
    beforeAfterGroupId: photo.before_after_group_id,
    beforeAfterRole: photo.before_after_role,
    takenAt: photo.taken_at,
    uploadedAt: photo.uploaded_at,
  };
}

function registerPhotoRoutes(router, { db }) {
  router.get('/api/properties/:id/photos', async (req, res) => {
    const owner = requireAuth(db, req);
    const property = getOwnedPropertyOr404(db, owner.id, req.params.id);
    let rows = db.prepare('SELECT * FROM photos WHERE property_id = ? ORDER BY COALESCE(taken_at, uploaded_at) DESC, id DESC').all(property.id);
    if (req.query.album) rows = rows.filter((p) => p.album === req.query.album);
    sendJson(res, 200, rows.map(serializePhoto));
  });

  // Accepts one or more base64 images per call (phone camera uploads often
  // come through one at a time; desktop multi-select comes through as a batch).
  router.post('/api/properties/:id/photos', async (req, res) => {
    const owner = requireAuth(db, req);
    const property = getOwnedPropertyOr404(db, owner.id, req.params.id);
    const { images, caption, album, takenAt, beforeAfterGroupId, beforeAfterRole } = req.body;
    const dataUrls = Array.isArray(images) ? images : [req.body.dataUrl].filter(Boolean);
    if (dataUrls.length === 0) throw apiError(400, 'No image data received');

    const destDir = path.join(UPLOADS_DIR, 'properties', String(property.id), 'photos');
    const groupId = beforeAfterGroupId || (req.body.markBeforeAfter ? crypto.randomBytes(6).toString('hex') : null);
    const created = [];

    dataUrls.forEach((dataUrl, i) => {
      const filename = saveBase64Image(dataUrl, destDir, 'photo');
      const result = db.prepare(`
        INSERT INTO photos (property_id, file_path, caption, album, before_after_group_id, before_after_role, taken_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        property.id, filename, caption || null, album && ALBUMS.includes(album) ? album : 'general',
        groupId, groupId ? (beforeAfterRole || (i === 0 ? 'before' : 'after')) : null,
        takenAt || new Date().toISOString().slice(0, 10)
      );
      created.push(db.prepare('SELECT * FROM photos WHERE id = ?').get(result.lastInsertRowid));
    });

    logAudit(db, { actorType: 'owner', actorId: owner.id, action: 'upload_photos', entityType: 'property', entityId: property.id, after: { count: created.length, album } });
    sendJson(res, 201, created.map(serializePhoto));
  });

  router.put('/api/photos/:id', async (req, res) => {
    const owner = requireAuth(db, req);
    const photo = db.prepare(`
      SELECT ph.* FROM photos ph JOIN properties p ON p.id = ph.property_id WHERE ph.id = ? AND p.owner_id = ?
    `).get(req.params.id, owner.id);
    if (!photo) throw apiError(404, 'Photo not found');
    const { caption, album, takenAt } = req.body;
    db.prepare('UPDATE photos SET caption=?, album=?, taken_at=? WHERE id=?').run(
      caption ?? photo.caption, album && ALBUMS.includes(album) ? album : photo.album, takenAt ?? photo.taken_at, photo.id
    );
    sendJson(res, 200, serializePhoto(db.prepare('SELECT * FROM photos WHERE id = ?').get(photo.id)));
  });

  router.delete('/api/photos/:id', async (req, res) => {
    const owner = requireAuth(db, req);
    const photo = db.prepare(`
      SELECT ph.* FROM photos ph JOIN properties p ON p.id = ph.property_id WHERE ph.id = ? AND p.owner_id = ?
    `).get(req.params.id, owner.id);
    if (!photo) throw apiError(404, 'Photo not found');
    const filePath = path.join(UPLOADS_DIR, 'properties', String(photo.property_id), 'photos', photo.file_path);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    db.prepare('DELETE FROM photos WHERE id = ?').run(photo.id);
    logAudit(db, { actorType: 'owner', actorId: owner.id, action: 'delete_photo', entityType: 'photo', entityId: photo.id });
    sendJson(res, 200, { ok: true });
  });
}

module.exports = { registerPhotoRoutes, serializePhoto, ALBUMS };

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { apiError } = require('./router');

const SESSION_COOKIE = 'session_token';
const SESSION_DAYS = 30;

/** Look up the logged-in owner from the session cookie. Throws 401 if absent/expired. */
function requireAuth(db, req) {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) throw apiError(401, 'Not signed in');
  const session = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!session) throw apiError(401, 'Session expired — please sign in again');
  if (new Date(session.expires_at + 'Z').getTime() < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    throw apiError(401, 'Session expired — please sign in again');
  }
  const owner = db.prepare('SELECT id, name, email FROM owners WHERE id = ?').get(session.owner_id);
  if (!owner) throw apiError(401, 'Not signed in');
  return owner;
}

function createSession(db, ownerId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 19);
  db.prepare('INSERT INTO sessions (token, owner_id, expires_at) VALUES (?, ?, ?)').run(token, ownerId, expires);
  return token;
}

// The Secure flag would break local http://localhost development (browsers
// drop Secure cookies over plain HTTP), so it's added only when APP_BASE_URL
// says this instance is actually served over https — e.g. behind a real TLS
// terminating proxy in production. See README.md "Before you deploy this
// beyond your own machine" for why this matters and how to set it.
function cookieIsSecureContext() {
  return String(process.env.APP_BASE_URL || '').startsWith('https://');
}

function setSessionCookie(res, token) {
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  const secure = cookieIsSecureContext() ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`);
}

function clearSessionCookie(res) {
  const secure = cookieIsSecureContext() ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`);
}

/** Fetch a property and confirm it belongs to this owner — every property/financial route calls this. */
function getOwnedPropertyOr404(db, ownerId, propertyId) {
  const property = db.prepare('SELECT * FROM properties WHERE id = ? AND owner_id = ?').get(propertyId, ownerId);
  if (!property) throw apiError(404, 'Property not found');
  return property;
}

// node:sqlite's DatabaseSync has no better-sqlite3-style db.transaction(fn)
// sugar, so this is the one place that wraps BEGIN/COMMIT/ROLLBACK by hand.
// Use this for any multi-statement change that must not be left partially
// applied — e.g. replacing which properties a bank account is linked to: if
// ownership validation fails partway through, every write fn made so far
// (including ones earlier in the SAME call) is undone, not just skipped from
// that point on.
function runInTransaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function logAudit(db, { actorType, actorId, action, entityType, entityId, before, after }) {
  db.prepare(`
    INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, before_json, after_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    actorType, actorId ?? null, action, entityType, entityId ?? null,
    before ? JSON.stringify(before) : null,
    after ? JSON.stringify(after) : null
  );
}

const ALLOWED_IMAGE_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

/** Decode a data: URL image the browser sent as JSON, validate it, and write it to disk. Returns the public path. */
function saveBase64Image(dataUrl, destDir, baseName) {
  const match = /^data:(image\/[a-zA-Z+]+);base64,(.+)$/.exec(dataUrl || '');
  if (!match) throw apiError(400, 'Expected an image file');
  const mimeType = match[1];
  const ext = ALLOWED_IMAGE_TYPES[mimeType];
  if (!ext) throw apiError(400, `Unsupported image type: ${mimeType}`);
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > MAX_IMAGE_BYTES) throw apiError(400, 'Image is too large (12MB max)');
  fs.mkdirSync(destDir, { recursive: true });
  const filename = `${baseName}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(destDir, filename), buffer);
  return filename;
}

const ALLOWED_DOC_TYPES = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'text/plain': 'txt',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};
const MAX_DOC_BYTES = 25 * 1024 * 1024;

/** Same idea as saveBase64Image but for the broader set of document types the app accepts. */
function saveBase64Document(dataUrl, destDir, baseName) {
  const match = /^data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(dataUrl || '');
  if (!match) throw apiError(400, 'Expected a file');
  const mimeType = match[1];
  const ext = ALLOWED_DOC_TYPES[mimeType];
  if (!ext) throw apiError(400, `Unsupported file type: ${mimeType}`);
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > MAX_DOC_BYTES) throw apiError(400, 'File is too large (25MB max)');
  fs.mkdirSync(destDir, { recursive: true });
  const filename = `${baseName}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(destDir, filename), buffer);
  return filename;
}

module.exports = {
  requireAuth, createSession, setSessionCookie, clearSessionCookie,
  getOwnedPropertyOr404, logAudit, saveBase64Image, saveBase64Document, SESSION_COOKIE,
  runInTransaction,
};

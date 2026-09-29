// Renter-facing session/token handling. Deliberately separate from
// server/lib/helpers.js's owner-session machinery (different cookie name,
// different table) so a renter session can never be confused for an owner
// session even if the same code accidentally ran the wrong check, and so an
// owner previewing their own site and a renter can each be signed in from
// the same browser without clobbering each other's cookie.

const crypto = require('crypto');
const { apiError } = require('./router');

const RENTER_SESSION_COOKIE = 'renter_session';
const RENTER_SESSION_DAYS = 30;
const TOKEN_TTL_MS = {
  verify_email: 24 * 60 * 60 * 1000,
  reset_password: 30 * 60 * 1000,
  invitation: 14 * 24 * 60 * 60 * 1000,
};

/** Look up the logged-in renter from the renter session cookie. Throws 401 if absent/expired. */
function requireRenterAuth(db, req) {
  const token = req.cookies[RENTER_SESSION_COOKIE];
  if (!token) throw apiError(401, 'Not signed in');
  const session = db.prepare('SELECT * FROM renter_sessions WHERE token = ?').get(token);
  if (!session) throw apiError(401, 'Session expired — please sign in again');
  if (new Date(session.expires_at + 'Z').getTime() < Date.now()) {
    db.prepare('DELETE FROM renter_sessions WHERE token = ?').run(token);
    throw apiError(401, 'Session expired — please sign in again');
  }
  let renter = db.prepare('SELECT * FROM renters WHERE id = ?').get(session.renter_id);
  if (!renter) throw apiError(401, 'Not signed in');
  // A merged-away identity's old session still works — it just resolves to
  // whichever renter it was merged into, transparently.
  if (renter.merged_into_renter_id) {
    renter = db.prepare('SELECT * FROM renters WHERE id = ?').get(renter.merged_into_renter_id) || renter;
  }
  return renter;
}

function createRenterSession(db, renterId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + RENTER_SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 19);
  db.prepare('INSERT INTO renter_sessions (token, renter_id, expires_at) VALUES (?, ?, ?)').run(token, renterId, expires);
  return token;
}

function cookieIsSecureContext() {
  return String(process.env.APP_BASE_URL || '').startsWith('https://');
}

function setRenterSessionCookie(res, token) {
  const maxAge = RENTER_SESSION_DAYS * 24 * 60 * 60;
  const secure = cookieIsSecureContext() ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${RENTER_SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`);
}

function clearRenterSessionCookie(res) {
  const secure = cookieIsSecureContext() ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${RENTER_SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`);
}

/** Issue a single-use renter_tokens row for the given purpose. Invalidates any earlier unused token of the SAME purpose for the same renter first, so only the most recently sent link/code ever works. */
function createRenterToken(db, renterId, purpose, { leaseId = null, role = null } = {}) {
  db.prepare("DELETE FROM renter_tokens WHERE renter_id = ? AND purpose = ? AND used_at IS NULL").run(renterId, purpose);
  const token = crypto.randomBytes(24).toString('hex');
  const ttl = TOKEN_TTL_MS[purpose] || 30 * 60 * 1000;
  const expiresAt = new Date(Date.now() + ttl).toISOString().slice(0, 19);
  db.prepare(`
    INSERT INTO renter_tokens (token, renter_id, purpose, lease_id, role, expires_at) VALUES (?, ?, ?, ?, ?, ?)
  `).run(token, renterId, purpose, leaseId, role, expiresAt);
  return token;
}

/** Look up a still-valid, unused token of the given purpose. Returns null (never throws) so callers can give a uniform "invalid or expired" message without leaking which case it was. */
function findValidRenterToken(db, token, purpose) {
  const row = db.prepare('SELECT * FROM renter_tokens WHERE token = ? AND purpose = ?').get(token, purpose);
  if (!row) return null;
  if (row.used_at) return null;
  if (new Date(row.expires_at + 'Z').getTime() < Date.now()) return null;
  return row;
}

function consumeRenterToken(db, tokenRow) {
  db.prepare("UPDATE renter_tokens SET used_at = datetime('now') WHERE id = ?").run(tokenRow.id);
}

module.exports = {
  RENTER_SESSION_COOKIE,
  requireRenterAuth, createRenterSession, setRenterSessionCookie, clearRenterSessionCookie,
  createRenterToken, findValidRenterToken, consumeRenterToken,
};

// Renter-facing session/token handling. Deliberately separate from
// server/lib/helpers.js's owner-session machinery (different cookie name,
// different table) so a renter session can never be confused for an owner
// session even if the same code accidentally ran the wrong check, and so an
// owner previewing their own site and a renter can each be signed in from
// the same browser without clobbering each other's cookie.
//
// ---------------------------------------------------------------------------
// Session model — no "Remember Me", a real inactivity timeout, and an
// honest definition of "a new visit" (see the spec this was built against):
//
// The renter_session cookie carries no Max-Age/Expires, so it's a browser
// SESSION cookie: most browsers discard it once every window/tab for this
// browser profile is actually closed. That's a real property of the cookie,
// but it is NOT what this app relies on or claims to guarantee — plenty of
// mainstream browsers and mobile OSs restore tabs (and their cookies) across
// what looks to the person like "closing the browser" (session-restore on
// relaunch, iOS/Android backgrounding an app instead of ever truly quitting
// it, etc.), so treating "browser closed" as a reliable sign-out would be a
// claim this app cannot actually test or stand behind.
//
// What IS enforced here, on every single request, is a SLIDING INACTIVITY
// TIMEOUT: renter_sessions.last_seen_at moves forward to "now" every time
// requireRenterAuth accepts the session, and the session is rejected the
// moment more than RENTER_IDLE_TIMEOUT_MS has elapsed since it last moved.
// That is this app's actual, tested definition of "a new visit": as long as
// the renter keeps doing anything (browsing, paying, signing) with gaps
// shorter than the timeout, the session stays alive exactly as the spec
// requires; the first gap longer than that ends it, and the very next
// request 401s with a message telling them to sign in again. Explicit Sign
// Out (POST /api/renter/logout) ends it immediately either way.
//
// renter_sessions.expires_at is kept as a separate, much longer outer bound
// (RENTER_SESSION_MAX_DAYS) purely as database hygiene — insurance against a
// row lingering forever if something odd happened to a clock — it is not
// the mechanism a real visit ever actually runs into, since the inactivity
// timeout above is always far shorter.
// ---------------------------------------------------------------------------

const crypto = require('crypto');
const { apiError } = require('./router');

const RENTER_SESSION_COOKIE = 'renter_session';
const RENTER_SESSION_MAX_DAYS = 30; // outer hygiene bound only — see header comment
const RENTER_IDLE_TIMEOUT_MINUTES = Number(process.env.RENTER_SESSION_IDLE_TIMEOUT_MINUTES) || 30;
const RENTER_IDLE_TIMEOUT_MS = RENTER_IDLE_TIMEOUT_MINUTES * 60 * 1000;
const TOKEN_TTL_MS = {
  verify_email: 24 * 60 * 60 * 1000,
  reset_password: 30 * 60 * 1000,
  invitation: 14 * 24 * 60 * 60 * 1000,
};

/** Look up the logged-in renter from the renter session cookie. Throws 401
 * (with a message distinguishing "never signed in"/"signed out" from "timed
 * out from inactivity") if absent, expired, or idle too long. On success,
 * slides the session's activity window forward — this one call is both the
 * auth check AND the "keep this visit alive" heartbeat; nothing else needs
 * to separately ping the server to stay signed in during normal use. */
function requireRenterAuth(db, req) {
  const token = req.cookies[RENTER_SESSION_COOKIE];
  if (!token) throw apiError(401, 'Not signed in');
  const session = db.prepare('SELECT * FROM renter_sessions WHERE token = ?').get(token);
  if (!session) throw apiError(401, 'Not signed in');
  if (new Date(session.expires_at + 'Z').getTime() < Date.now()) {
    db.prepare('DELETE FROM renter_sessions WHERE token = ?').run(token);
    throw apiError(401, 'Your session has expired. Please sign in again.');
  }
  const idleMs = Date.now() - new Date(session.last_seen_at + 'Z').getTime();
  if (idleMs > RENTER_IDLE_TIMEOUT_MS) {
    db.prepare('DELETE FROM renter_sessions WHERE token = ?').run(token);
    throw apiError(401, `You’ve been signed out after ${RENTER_IDLE_TIMEOUT_MINUTES} minutes of inactivity. Please sign in again.`);
  }
  let renter = db.prepare('SELECT * FROM renters WHERE id = ?').get(session.renter_id);
  if (!renter) throw apiError(401, 'Not signed in');
  // A merged-away identity's old session still works — it just resolves to
  // whichever renter it was merged into, transparently.
  if (renter.merged_into_renter_id) {
    renter = db.prepare('SELECT * FROM renters WHERE id = ?').get(renter.merged_into_renter_id) || renter;
  }
  db.prepare("UPDATE renter_sessions SET last_seen_at = datetime('now') WHERE token = ?").run(token);
  return renter;
}

function createRenterSession(db, renterId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + RENTER_SESSION_MAX_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 19);
  db.prepare('INSERT INTO renter_sessions (token, renter_id, expires_at) VALUES (?, ?, ?)').run(token, renterId, expires);
  return token;
}

function cookieIsSecureContext() {
  return String(process.env.APP_BASE_URL || '').startsWith('https://');
}

/** No Max-Age/Expires on purpose — see header comment: this is a browser
 * session cookie, one (honestly-described) layer of "no Remember Me", not
 * the mechanism that actually enforces it. The inactivity timeout in
 * requireRenterAuth is what's actually guaranteed and tested. */
function setRenterSessionCookie(res, token) {
  const secure = cookieIsSecureContext() ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${RENTER_SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/${secure}`);
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
  RENTER_SESSION_COOKIE, RENTER_IDLE_TIMEOUT_MINUTES,
  requireRenterAuth, createRenterSession, setRenterSessionCookie, clearRenterSessionCookie,
  createRenterToken, findValidRenterToken, consumeRenterToken,
};

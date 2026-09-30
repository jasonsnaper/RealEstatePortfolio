const { apiError, sendJson } = require('../lib/router');
const { hashPassword, verifyPassword } = require('../lib/auth');
const { requireAuth, createSession, setSessionCookie, clearSessionCookie, logAudit } = require('../lib/helpers');
const { getOrCreateConnectionCode, regenerateConnectionCode } = require('../lib/connectionCode');

function registerAuthRoutes(router, { db }) {
  // First-run only: creates the single owner account. Refuses once an owner exists,
  // so this endpoint can't be used later to add a stranger as a second owner.
  router.post('/api/setup', async (req, res) => {
    const existing = db.prepare('SELECT COUNT(*) AS n FROM owners').get();
    if (existing.n > 0) throw apiError(409, 'Setup has already been completed. Please sign in.');

    const { name, email, password } = req.body;
    if (!name || !email || !password) throw apiError(400, 'Name, email, and password are all required');
    if (String(password).length < 8) throw apiError(400, 'Password must be at least 8 characters');

    const passwordHash = hashPassword(password);
    const result = db.prepare('INSERT INTO owners (name, email, password_hash) VALUES (?, ?, ?)').run(name, email.toLowerCase().trim(), passwordHash);
    logAudit(db, { actorType: 'owner', actorId: result.lastInsertRowid, action: 'create', entityType: 'owner', entityId: result.lastInsertRowid });

    const token = createSession(db, result.lastInsertRowid);
    setSessionCookie(res, token);
    sendJson(res, 201, { id: result.lastInsertRowid, name, email });
  });

  router.get('/api/setup/status', async (req, res) => {
    const existing = db.prepare('SELECT COUNT(*) AS n FROM owners').get();
    sendJson(res, 200, { needsSetup: existing.n === 0 });
  });

  router.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) throw apiError(400, 'Email and password are required');
    const owner = db.prepare('SELECT * FROM owners WHERE email = ?').get(String(email).toLowerCase().trim());
    // Same generic error whether the email is unknown or the password is wrong,
    // so a login attempt can't be used to discover which emails have accounts.
    if (!owner || !verifyPassword(password, owner.password_hash)) {
      throw apiError(401, 'Incorrect email or password');
    }
    const token = createSession(db, owner.id);
    setSessionCookie(res, token);
    sendJson(res, 200, { id: owner.id, name: owner.name, email: owner.email });
  });

  router.post('/api/logout', async (req, res) => {
    const token = req.cookies.session_token;
    if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    clearSessionCookie(res);
    sendJson(res, 200, { ok: true });
  });

  router.get('/api/me', async (req, res) => {
    const owner = requireAuth(db, req);
    // Lazily minted the first time anything actually asks for it, rather than
    // backfilled for every owner up front — see server/lib/connectionCode.js.
    owner.connection_code = getOrCreateConnectionCode(db, owner.id);
    sendJson(res, 200, owner);
  });

  // Lets the owner rotate their connection code (server/lib/connectionCode.js)
  // if it's ever shared more widely than intended — e.g. posted somewhere
  // public by mistake. The old code stops working for sign-up immediately;
  // anyone already signed up keeps their account regardless.
  router.post('/api/connection-code/regenerate', async (req, res) => {
    const owner = requireAuth(db, req);
    const code = regenerateConnectionCode(db, owner.id);
    logAudit(db, { actorType: 'owner', actorId: owner.id, action: 'regenerate_connection_code', entityType: 'owner', entityId: owner.id });
    sendJson(res, 200, { connectionCode: code });
  });

  // Password reset without an email provider configured: issues a one-time
  // reset code that's printed to the server console (owner has shell access
  // to their own server). This is a deliberate stand-in — see README for how
  // to wire up a real email provider so this becomes an emailed link instead.
  router.post('/api/forgot-password', async (req, res) => {
    const { email } = req.body;
    const owner = db.prepare('SELECT * FROM owners WHERE email = ?').get(String(email || '').toLowerCase().trim());
    // Always return the same response whether or not the email matches, so
    // this endpoint can't be used to enumerate accounts.
    if (owner) {
      const crypto = require('crypto');
      const code = crypto.randomBytes(4).toString('hex');
      const expires = new Date(Date.now() + 30 * 60 * 1000).toISOString().slice(0, 19);
      db.prepare('DELETE FROM sessions WHERE token LIKE ?').run('reset:%'); // clear stale reset tokens
      db.prepare('INSERT INTO sessions (token, owner_id, expires_at) VALUES (?, ?, ?)').run(`reset:${code}`, owner.id, expires);
      console.log(`\n[Password reset] Requested for ${owner.email}. Reset code (valid 30 min): ${code}\n`);
    }
    sendJson(res, 200, { message: 'If that email has an account, a reset code has been generated (check the server console/logs).' });
  });

  router.post('/api/reset-password', async (req, res) => {
    const { email, code, newPassword } = req.body;
    if (!email || !code || !newPassword) throw apiError(400, 'Email, code, and new password are required');
    if (String(newPassword).length < 8) throw apiError(400, 'Password must be at least 8 characters');
    const session = db.prepare('SELECT * FROM sessions WHERE token = ?').get(`reset:${code}`);
    const owner = db.prepare('SELECT * FROM owners WHERE email = ?').get(String(email).toLowerCase().trim());
    if (!session || !owner || session.owner_id !== owner.id || new Date(session.expires_at + 'Z').getTime() < Date.now()) {
      throw apiError(400, 'That reset code is invalid or has expired');
    }
    db.prepare('UPDATE owners SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), owner.id);
    db.prepare('DELETE FROM sessions WHERE token = ?').run(`reset:${code}`);
    logAudit(db, { actorType: 'owner', actorId: owner.id, action: 'password_reset', entityType: 'owner', entityId: owner.id });
    sendJson(res, 200, { message: 'Password updated. Please sign in.' });
  });
}

module.exports = { registerAuthRoutes };

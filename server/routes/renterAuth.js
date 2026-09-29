const { apiError, sendJson } = require('../lib/router');
const { hashPassword, verifyPassword } = require('../lib/auth');
const { logAudit } = require('../lib/helpers');
const {
  RENTER_SESSION_COOKIE, requireRenterAuth, createRenterSession, setRenterSessionCookie, clearRenterSessionCookie,
  createRenterToken, findValidRenterToken, consumeRenterToken,
} = require('../lib/renterAuth');
const { serializeRenter } = require('../lib/renters');

// ---------------------------------------------------------------------------
// Renter accounts are never self-service-created out of thin air — every
// renter row is created by the owner (server/routes/renterManagement.js),
// either directly or via the pre-existing-tenant backfill migration. What's
// self-service is everything AFTER that: accepting an invitation (setting a
// password for the first time), signing in, and resetting a forgotten
// password. There is deliberately no POST /api/renter/signup here.
// ---------------------------------------------------------------------------

function registerRenterAuthRoutes(router, { db }) {
  // Public: lets renter.html show "You've been invited to <property> as
  // <role>" BEFORE the renter has typed anything, and tell a stale/used link
  // apart from a good one without requiring a password attempt first.
  router.get('/api/renter/invite/:token', async (req, res) => {
    const tokenRow = findValidRenterToken(db, req.params.token, 'invitation');
    if (!tokenRow) throw apiError(410, 'This invitation link is invalid, already used, or has expired. Ask your landlord to send a new one.');
    const renter = db.prepare('SELECT * FROM renters WHERE id = ?').get(tokenRow.renter_id);
    const lease = db.prepare(`
      SELECT l.id, p.name AS property_name FROM leases l JOIN properties p ON p.id = l.property_id WHERE l.id = ?
    `).get(tokenRow.lease_id);
    sendJson(res, 200, {
      renterName: renter.name,
      renterEmail: renter.email,
      alreadyHasAccount: !!renter.password_hash,
      leaseId: tokenRow.lease_id,
      role: tokenRow.role,
      propertyName: lease ? lease.property_name : null,
    });
  });

  router.post('/api/renter/accept-invite', async (req, res) => {
    const { token, password } = req.body;
    if (!token || !password) throw apiError(400, 'A password is required');
    if (String(password).length < 8) throw apiError(400, 'Password must be at least 8 characters');
    const tokenRow = findValidRenterToken(db, token, 'invitation');
    if (!tokenRow) throw apiError(410, 'This invitation link is invalid, already used, or has expired. Ask your landlord to send a new one.');

    const renter = db.prepare('SELECT * FROM renters WHERE id = ?').get(tokenRow.renter_id);
    if (!renter) throw apiError(404, 'Renter account not found');

    db.prepare(`
      UPDATE renters SET password_hash = ?, email_verified_at = COALESCE(email_verified_at, datetime('now')), updated_at = datetime('now') WHERE id = ?
    `).run(hashPassword(password), renter.id);

    // The invite always names a specific lease/role; make sure that link
    // still exists (it normally does already — invites are sent for renters
    // already added to the lease — but this is cheap insurance against the
    // owner having removed and re-added them in between).
    if (tokenRow.lease_id) {
      db.prepare('INSERT OR IGNORE INTO lease_renters (lease_id, renter_id, role) VALUES (?, ?, ?)').run(tokenRow.lease_id, renter.id, tokenRow.role || 'primary');
    }
    consumeRenterToken(db, tokenRow);
    logAudit(db, { actorType: 'renter', actorId: renter.id, action: 'accept_invite', entityType: 'renter', entityId: renter.id });

    const session = createRenterSession(db, renter.id);
    setRenterSessionCookie(res, session);
    sendJson(res, 200, { renter: serializeRenter(renter), leaseId: tokenRow.lease_id || null });
  });

  router.post('/api/renter/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) throw apiError(400, 'Email and password are required');
    const renter = db.prepare('SELECT * FROM renters WHERE email IS NOT NULL AND lower(email) = lower(?)').get(String(email).trim());
    // Same generic error whether the email is unknown, has no password set
    // yet (owner added them but never invited), or the password is wrong.
    if (!renter || !verifyPassword(password, renter.password_hash || '')) {
      throw apiError(401, 'Incorrect email or password');
    }
    const resolved = renter.merged_into_renter_id ? db.prepare('SELECT * FROM renters WHERE id = ?').get(renter.merged_into_renter_id) : renter;
    const session = createRenterSession(db, resolved.id);
    setRenterSessionCookie(res, session);
    sendJson(res, 200, { renter: serializeRenter(resolved) });
  });

  router.post('/api/renter/logout', async (req, res) => {
    const token = req.cookies[RENTER_SESSION_COOKIE];
    if (token) db.prepare('DELETE FROM renter_sessions WHERE token = ?').run(token);
    clearRenterSessionCookie(res);
    sendJson(res, 200, { ok: true });
  });

  router.get('/api/renter/me', async (req, res) => {
    const renter = requireRenterAuth(db, req);
    sendJson(res, 200, serializeRenter(renter));
  });

  // Same honest stand-in as the owner's forgot-password: no email provider is
  // configured, so the reset link is printed to the server console/logs
  // instead of emailed. See README for wiring up a real provider.
  router.post('/api/renter/forgot-password', async (req, res) => {
    const { email, appBaseUrl } = req.body;
    const renter = db.prepare('SELECT * FROM renters WHERE email IS NOT NULL AND lower(email) = lower(?)').get(String(email || '').trim());
    if (renter) {
      const token = createRenterToken(db, renter.id, 'reset_password');
      const base = process.env.APP_BASE_URL || appBaseUrl || '';
      console.log(`\n[Renter password reset] Requested for ${renter.email}. Link (valid 30 min): ${base}/renter#/reset-password/${token}\n`);
    }
    sendJson(res, 200, { message: 'If that email has a renter account, a reset link has been generated (check the server console/logs).' });
  });

  router.post('/api/renter/reset-password', async (req, res) => {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) throw apiError(400, 'Reset token and new password are required');
    if (String(newPassword).length < 8) throw apiError(400, 'Password must be at least 8 characters');
    const tokenRow = findValidRenterToken(db, token, 'reset_password');
    if (!tokenRow) throw apiError(400, 'That reset link is invalid or has expired');
    db.prepare("UPDATE renters SET password_hash = ?, updated_at = datetime('now') WHERE id = ?").run(hashPassword(newPassword), tokenRow.renter_id);
    consumeRenterToken(db, tokenRow);
    logAudit(db, { actorType: 'renter', actorId: tokenRow.renter_id, action: 'password_reset', entityType: 'renter', entityId: tokenRow.renter_id });
    sendJson(res, 200, { message: 'Password updated. Please sign in.' });
  });
}

module.exports = { registerRenterAuthRoutes };

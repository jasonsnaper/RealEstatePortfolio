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
    const { token, password, name, phone } = req.body;
    if (!token || !password) throw apiError(400, 'A password is required');
    if (String(password).length < 8) throw apiError(400, 'Password must be at least 8 characters');
    const tokenRow = findValidRenterToken(db, token, 'invitation');
    if (!tokenRow) throw apiError(410, 'This invitation link is invalid, already used, or has expired. Ask your landlord to send a new one.');

    const renter = db.prepare('SELECT * FROM renters WHERE id = ?').get(tokenRow.renter_id);
    if (!renter) throw apiError(404, 'Renter account not found');

    // A generic (lease-less) invite often starts from just an email — the
    // owner may not have known the renter's name or phone yet. Accepting the
    // invite is the renter's one chance to fill those in themselves as part
    // of "creating their account"; a LEASE invite already has real values
    // from the owner, so an explicit name/phone here only overwrites them if
    // the renter actually typed something (never silently blanked).
    const finalName = (name && name.trim()) ? name.trim() : renter.name;
    const finalPhone = phone !== undefined ? (String(phone).trim() || null) : renter.phone;

    db.prepare(`
      UPDATE renters SET password_hash = ?, name = ?, phone = ?,
             email_verified_at = COALESCE(email_verified_at, datetime('now')), updated_at = datetime('now') WHERE id = ?
    `).run(hashPassword(password), finalName, finalPhone, renter.id);

    // The invite always names a specific lease/role; make sure that link
    // still exists (it normally does already — invites are sent for renters
    // already added to the lease — but this is cheap insurance against the
    // owner having removed and re-added them in between). A GENERIC invite
    // (tokenRow.lease_id is null, see server/routes/renterManagement.js's
    // POST /api/renters/invite) has nothing to link here — the renter simply
    // ends up with an account and no lease yet, which is exactly what
    // "Unassigned Renters" means.
    if (tokenRow.lease_id) {
      db.prepare('INSERT OR IGNORE INTO lease_renters (lease_id, renter_id, role) VALUES (?, ?, ?)').run(tokenRow.lease_id, renter.id, tokenRow.role || 'primary');
    }
    consumeRenterToken(db, tokenRow);
    logAudit(db, { actorType: 'renter', actorId: renter.id, action: 'accept_invite', entityType: 'renter', entityId: renter.id });

    const updated = db.prepare('SELECT * FROM renters WHERE id = ?').get(renter.id);
    const session = createRenterSession(db, updated.id);
    setRenterSessionCookie(res, session);
    sendJson(res, 200, { renter: serializeRenter(updated), leaseId: tokenRow.lease_id || null });
  });

  // "Enter and update their contact details" — editable independently of any
  // invitation, any time, by a signed-in renter. Changing the email address
  // (the renter's login identifier) re-arms email verification: it clears
  // email_verified_at and issues a fresh verify_email token the same
  // simulated way as everything else that would be an email in production
  // (see forgot-password above) — this is the concrete reason the dormant
  // verify_email token purpose exists (accepting an invitation already
  // counts as verifying whatever address it was sent to, so THIS is the
  // moment a not-yet-proven address actually shows up).
  router.put('/api/renter/me', async (req, res) => {
    const renter = requireRenterAuth(db, req);
    const { name, phone, email } = req.body;
    if (name !== undefined && !String(name).trim()) throw apiError(400, 'Name cannot be blank');

    let newEmail = renter.email;
    let emailChanged = false;
    if (email !== undefined && String(email).trim()) {
      const cleanEmail = String(email).trim().toLowerCase();
      if (cleanEmail !== String(renter.email || '').toLowerCase()) {
        const collision = db.prepare('SELECT id FROM renters WHERE owner_id = ? AND id != ? AND email IS NOT NULL AND lower(email) = lower(?)').get(renter.owner_id, renter.id, cleanEmail);
        if (collision) throw apiError(409, 'Another renter on this account already uses that email address.');
        newEmail = cleanEmail;
        emailChanged = true;
      }
    }

    const finalName = name !== undefined && name.trim() ? name.trim() : renter.name;
    const finalPhone = phone !== undefined ? (String(phone).trim() || null) : renter.phone;

    db.prepare(`
      UPDATE renters SET name = ?, phone = ?, email = ?, email_verified_at = ?, updated_at = datetime('now') WHERE id = ?
    `).run(finalName, finalPhone, newEmail, emailChanged ? null : renter.email_verified_at, renter.id);
    logAudit(db, { actorType: 'renter', actorId: renter.id, action: 'update_contact_details', entityType: 'renter', entityId: renter.id });

    const updated = db.prepare('SELECT * FROM renters WHERE id = ?').get(renter.id);
    if (emailChanged) {
      const verifyToken = createRenterToken(db, updated.id, 'verify_email');
      const base = process.env.APP_BASE_URL || '';
      console.log(`\n[Renter email verification] ${updated.name} changed their email to ${updated.email}. Verify link (valid 24h): ${base}/renter#/verify-email/${verifyToken}\n`);
    }
    sendJson(res, 200, serializeRenter(updated));
  });

  // Lets a signed-in renter re-trigger verification manually (e.g. they
  // missed the console-logged link, or want to confirm their address is
  // proven) without having to change their email to get a new token.
  router.post('/api/renter/verify-email/request', async (req, res) => {
    const renter = requireRenterAuth(db, req);
    if (renter.email_verified_at) return sendJson(res, 200, { message: 'Your email is already verified.', alreadyVerified: true });
    if (!renter.email) throw apiError(400, 'Add an email address first.');
    const verifyToken = createRenterToken(db, renter.id, 'verify_email');
    const base = process.env.APP_BASE_URL || '';
    console.log(`\n[Renter email verification] Requested for ${renter.email}. Link (valid 24h): ${base}/renter#/verify-email/${verifyToken}\n`);
    sendJson(res, 200, { message: 'A verification link has been generated (check the server console/logs). No email provider is configured — see README.' });
  });

  router.post('/api/renter/verify-email/confirm', async (req, res) => {
    const { token } = req.body;
    if (!token) throw apiError(400, 'A verification token is required');
    const tokenRow = findValidRenterToken(db, token, 'verify_email');
    if (!tokenRow) throw apiError(400, 'That verification link is invalid or has expired — request a new one from your account page.');
    db.prepare("UPDATE renters SET email_verified_at = datetime('now') WHERE id = ?").run(tokenRow.renter_id);
    consumeRenterToken(db, tokenRow);
    logAudit(db, { actorType: 'renter', actorId: tokenRow.renter_id, action: 'verify_email', entityType: 'renter', entityId: tokenRow.renter_id });
    sendJson(res, 200, { message: 'Email verified.' });
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

// Coverage for the renter-workflow update layered on top of the pre-existing
// renter-accounts / lease-signing feature set (test/renterPortal.test.js and
// test/leaseAgreements.test.js cover that older surface and must keep
// passing unmodified alongside this file): SMS invitations
// (server/lib/smsProvider.js, server/routes/smsWebhooks.js), a real
// inactivity-timeout renter session model (server/lib/renterAuth.js), and
// self-serve sign-up via a landlord connection code
// (server/lib/connectionCode.js). This exercises the feature spec's own
// 10-point verification list everywhere it's server-testable; the
// collapsible Unassigned Renters panel, the phone/country-code widget, and
// other purely-visual pieces are covered by the Playwright pass instead (see
// README's "Manual/visual verification" section).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const http = require('http');
const crypto = require('crypto');

// See test/renterPortal.test.js's identical comment: both DATA_DIR and
// UPLOADS_DIR are read at module-load time by server/db.js, so these MUST be
// set before requiring server/index.js below, or this file would touch the
// real project directories every run.
process.env.UPLOADS_DIR = path.join(os.tmpdir(), `rental-app-renterworkflow-test-uploads-${Date.now()}-${process.pid}`);
process.env.DATA_DIR = path.join(os.tmpdir(), `rental-app-renterworkflow-test-datadir-${Date.now()}-${process.pid}`);

const { createApp } = require('../server/index');
const { openDatabase } = require('../server/db');
const { createSession } = require('../server/lib/helpers');

let server, db, baseUrl, port;
let ownerCookie, ownerId;

async function api(method, urlPath, body, cookie) {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { json = text; }
  return { status: res.status, body: json, cookie: setCookie ? setCookie.split(';')[0] : null, hasSetCookie: !!setCookie };
}

function tokenFromInviteUrl(url) {
  return url.split('/').pop();
}

/** Sets/deletes each of `vars` for the duration of `fn`, then always restores
 * whatever was there before — the same per-test env-var discipline
 * test/bankAccounts.test.js uses for PLAID_CLIENT_ID/PLAID_SECRET, so tests
 * stay independent of declaration order and of each other. `undefined`
 * deletes the var (used to force the "not configured" state). */
async function withEnv(vars, fn) {
  const previous = {};
  for (const k of Object.keys(vars)) {
    previous[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k];
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (previous[k] === undefined) delete process.env[k]; else process.env[k] = previous[k];
    }
  }
}

/** Twilio's own documented status-callback signing algorithm (see
 * server/lib/smsProvider.js's verifyStatusCallback doc comment), reimplemented
 * independently here rather than imported, so these tests actually exercise
 * whether the production code still matches that spec — sorting, the exact
 * concatenation shape, and the base64 encoding — not just whether it agrees
 * with itself. */
function signTwilioParams(url, params, authToken) {
  let data = url;
  for (const key of Object.keys(params).sort()) data += key + params[key];
  return crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}

before(async () => {
  const tmpFile = path.join(os.tmpdir(), `rental-app-renterworkflow-test-${Date.now()}.db`);
  db = openDatabase(tmpFile);
  db.prepare("INSERT INTO owners (name, email, password_hash) VALUES ('Landlord','landlord@renterworkflow.test','h')").run();
  ownerId = db.prepare("SELECT id FROM owners WHERE email = 'landlord@renterworkflow.test'").get().id;
  ownerCookie = `session_token=${createSession(db, ownerId)}`;

  port = 51000 + Math.floor(Math.random() * 3000);
  const app = createApp({ db, port });
  server = http.createServer((req, res) => {
    app(req, res).catch((e) => { console.error(e); res.writeHead(500).end('{}'); });
  });
  await new Promise((resolve) => server.listen(port, resolve));
  baseUrl = `http://localhost:${port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
});

async function createActiveLease(overrides = {}) {
  const property = await api('POST', '/api/properties', { name: `Workflow Test House ${Math.random()}`, timezone: 'UTC' }, ownerCookie);
  const lease = await api('POST', `/api/properties/${property.body.id}/leases`, { tenantName: 'Placeholder Tenant', startDate: '2026-01-01', rent: '1500', ...overrides }, ownerCookie);
  return { propertyId: property.body.id, leaseId: lease.body.id };
}

function getConnectionCode() {
  return api('GET', '/api/me', null, ownerCookie).then((me) => me.body.connection_code);
}

// ---------------------------------------------------------------------------
// 1. SMS invitations — honest states, never a fabricated "Sent"; Copy Link
//    untouched; owner-scoped.
// ---------------------------------------------------------------------------

test('Copy Link keeps working exactly as before: a generic invite always returns a plain URL, unconditionally', async () => {
  const invite = await api('POST', '/api/renters/invite', { name: 'Cammy Copy', email: 'cammy.copy@example.com' }, ownerCookie);
  assert.equal(invite.status, 201);
  assert.ok(invite.body.url.includes('/renter#/accept-invite/'));
  assert.equal(invite.body.expiresInDays, 14);
});

test('sending the invite by SMS with no provider configured records an honest not_configured status, never a fake "Sent"', () => withEnv(
  { TWILIO_ACCOUNT_SID: undefined, TWILIO_AUTH_TOKEN: undefined, TWILIO_FROM_NUMBER: undefined, TWILIO_MESSAGING_SERVICE_SID: undefined },
  async () => {
    const invite = await api('POST', '/api/renters/invite', { name: 'Sam SMS', email: 'sam.sms@example.com', phone: '+15005550006' }, ownerCookie);
    const renterId = invite.body.renter.id;
    const message = `You're invited to set up your renter portal account: ${invite.body.url}`;

    const send = await api('POST', `/api/renters/${renterId}/send-invite-sms`, { phone: '+15005550006', message }, ownerCookie);
    assert.equal(send.status, 200, 'an honest "not configured" outcome is a successful request, not a server error');
    assert.equal(send.body.sms.status, 'not_configured');
    assert.notEqual(send.body.sms.status, 'sent', 'must never show a fabricated "sent"/"delivered" when nothing was actually sent');
    assert.equal(send.body.provider.mode, 'unconfigured');
    assert.ok(send.body.provider.notice && send.body.provider.notice.length > 0, 'must explain what to configure, not just fail silently');

    const fetched = await api('GET', `/api/sms-messages/${send.body.sms.id}`, null, ownerCookie);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.status, 'not_configured');
    assert.equal(fetched.body.toPhone, '+15005550006');
  }
));

test('send-invite-sms validates the phone number and requires the actual invitation link to still be present in the message', async () => {
  const invite = await api('POST', '/api/renters/invite', { name: 'Val Idation', email: 'val.idation@example.com' }, ownerCookie);
  const renterId = invite.body.renter.id;

  const badPhone = await api('POST', `/api/renters/${renterId}/send-invite-sms`, { phone: 'not-a-phone-number', message: `Link: ${invite.body.url}` }, ownerCookie);
  assert.equal(badPhone.status, 400);

  const strippedLink = await api('POST', `/api/renters/${renterId}/send-invite-sms`, { phone: '+15005550006', message: 'Come make an account!' }, ownerCookie);
  assert.equal(strippedLink.status, 400);
  assert.match(strippedLink.body.error, /must include the invitation link/i);
});

test('send-invite-sms refuses once the renter already has a portal account, and refuses when no invitation has been generated yet', async () => {
  const { leaseId } = await createActiveLease();
  // Added directly to a lease, never invited — so there is no invitation
  // token at all yet, the other 409 this route can return.
  const added = await api('POST', `/api/leases/${leaseId}/renters`, { name: 'No Invite Yet', email: 'no.invite.yet@example.com' }, ownerCookie);
  const neverInvited = await api('POST', `/api/renters/${added.body.id}/send-invite-sms`, { phone: '+15005550006', message: 'placeholder' }, ownerCookie);
  assert.equal(neverInvited.status, 409);
  assert.match(neverInvited.body.error, /generate the invitation link first/i);

  const invite = await api('POST', '/api/renters/invite', { name: 'Already Onboarded', email: 'already.onboarded@example.com' }, ownerCookie);
  await api('POST', '/api/renter/accept-invite', { token: tokenFromInviteUrl(invite.body.url), password: 'has-a-password-1' });
  const alreadyHasAccount = await api('POST', `/api/renters/${invite.body.renter.id}/send-invite-sms`, { phone: '+15005550006', message: `Link: ${invite.body.url}` }, ownerCookie);
  assert.equal(alreadyHasAccount.status, 409);
  assert.match(alreadyHasAccount.body.error, /already has a portal account/i);
});

test('send-invite-sms and the SMS status endpoint are owner-scoped — a different owner gets 404 for both', async () => {
  db.prepare("INSERT INTO owners (name, email, password_hash) VALUES ('Other Landlord','other.landlord@renterworkflow.test','h')").run();
  const otherOwnerId = db.prepare("SELECT id FROM owners WHERE email = 'other.landlord@renterworkflow.test'").get().id;
  const otherOwnerCookie = `session_token=${createSession(db, otherOwnerId)}`;

  const invite = await api('POST', '/api/renters/invite', { name: 'Owner Scoped', email: 'owner.scoped@example.com' }, ownerCookie);
  const crossSend = await api('POST', `/api/renters/${invite.body.renter.id}/send-invite-sms`, { phone: '+15005550006', message: `Link: ${invite.body.url}` }, otherOwnerCookie);
  assert.equal(crossSend.status, 404);

  const ownSend = await withEnv({ TWILIO_ACCOUNT_SID: undefined }, () =>
    api('POST', `/api/renters/${invite.body.renter.id}/send-invite-sms`, { phone: '+15005550006', message: `Link: ${invite.body.url}` }, ownerCookie));
  const crossStatus = await api('GET', `/api/sms-messages/${ownSend.body.sms.id}`, null, otherOwnerCookie);
  assert.equal(crossStatus.status, 404);
});

// ---------------------------------------------------------------------------
// 2. Separate renter login/portal — an owner session and a renter session
//    never substitute for each other, and previewing an invite never signs
//    anyone in.
// ---------------------------------------------------------------------------

test('an owner session cannot use renter-portal routes, and a renter session cannot use owner routes', async () => {
  const invite = await api('POST', '/api/renters/invite', { name: 'Separate Portals', email: 'separate.portals@example.com' }, ownerCookie);
  const accept = await api('POST', '/api/renter/accept-invite', { token: tokenFromInviteUrl(invite.body.url), password: 'a-real-password-1' });

  const ownerTriesRenterRoute = await api('GET', '/api/renter/me', null, ownerCookie);
  assert.equal(ownerTriesRenterRoute.status, 401);

  const renterTriesOwnerRoute = await api('GET', '/api/me', null, accept.cookie);
  assert.equal(renterTriesOwnerRoute.status, 401);
});

test('previewing an invitation link is read-only — it never sets a session cookie or exposes a password state before acceptance', async () => {
  const invite = await api('POST', '/api/renters/invite', { name: 'Preview Only', email: 'preview.only@example.com' }, ownerCookie);
  const preview = await api('GET', `/api/renter/invite/${tokenFromInviteUrl(invite.body.url)}`);
  assert.equal(preview.status, 200);
  assert.equal(preview.hasSetCookie, false, 'merely previewing an invitation must never sign anyone in');
  assert.equal(preview.body.alreadyHasAccount, false);
});

// ---------------------------------------------------------------------------
// 3. Self-serve account creation via a landlord connection code — mandatory
//    fields, password rules, and (the security-critical case) never exposing
//    or handing over an existing identity before its email is verified.
// ---------------------------------------------------------------------------

test('GET /api/me lazily mints a connection code for the owner, and regenerating it retires the old one', async () => {
  const me = await api('GET', '/api/me', null, ownerCookie);
  assert.equal(me.status, 200);
  assert.match(me.body.connection_code, /^[A-Z0-9]{8}$/);

  const regen = await api('POST', '/api/connection-code/regenerate', {}, ownerCookie);
  assert.equal(regen.status, 200);
  assert.notEqual(regen.body.connectionCode, me.body.connection_code);

  const staleAttempt = await api('POST', '/api/renter/signup', {
    name: 'Stale Code User', phone: '+15005550006', email: 'stale.code@example.com',
    password: 'plainlowercase', confirmPassword: 'plainlowercase', connectionCode: me.body.connection_code,
  });
  assert.equal(staleAttempt.status, 400, 'a superseded connection code must stop working for new sign-ups immediately');
});

test('signup requires every mandatory field and enforces only a length rule on the password', async () => {
  const code = await getConnectionCode();
  const base = { name: 'Rule Checker', phone: '+15005550006', email: 'rule.checker@example.com', password: 'longenough1', confirmPassword: 'longenough1', connectionCode: code };

  assert.equal((await api('POST', '/api/renter/signup', { ...base, name: '' })).status, 400);
  assert.equal((await api('POST', '/api/renter/signup', { ...base, email: 'not-an-email' })).status, 400);
  assert.equal((await api('POST', '/api/renter/signup', { ...base, phone: '5551234' })).status, 400, 'a phone with no country code must be rejected');
  assert.equal((await api('POST', '/api/renter/signup', { ...base, password: 'short1' })).status, 400);
  assert.equal((await api('POST', '/api/renter/signup', { ...base, confirmPassword: 'somethingelse1' })).status, 400);
  assert.equal((await api('POST', '/api/renter/signup', { ...base, connectionCode: '' })).status, 400);
  assert.equal((await api('POST', '/api/renter/signup', { ...base, connectionCode: 'NOTREAL1' })).status, 400);

  // No character-class requirement beyond length — plain lowercase letters,
  // long enough, must be accepted (the spec's "no unnecessarily restrictive
  // character rules").
  const ok = await api('POST', '/api/renter/signup', base);
  assert.equal(ok.status, 201);
  assert.equal(ok.body.requiresVerification, true);
  assert.equal(ok.hasSetCookie, false, 'signup must never issue a session immediately');
});

test('signing up with an email that already belongs to an unverified/no-password renter never exposes their data, and cannot be logged into until verified', async () => {
  // The owner already knows this person (e.g. added them to a lease
  // directly) but never invited them — a real identity, with no password,
  // that self-serve signup could otherwise silently take over.
  const { leaseId } = await createActiveLease();
  const existing = await api('POST', `/api/leases/${leaseId}/renters`, { name: 'Existing Tenant', email: 'existing.tenant@example.com', phone: '+15005550001' }, ownerCookie);
  assert.equal(existing.body.hasAccount, false);

  const code = await getConnectionCode();
  const takeover = await api('POST', '/api/renter/signup', {
    name: 'Attacker Chosen Name', phone: '+15005550009', email: 'EXISTING.TENANT@example.com', // case-insensitive match on purpose
    password: 'attackerpassword1', confirmPassword: 'attackerpassword1', connectionCode: code,
  });
  assert.equal(takeover.status, 201);
  assert.equal(takeover.hasSetCookie, false);
  // The response must carry nothing about the (possibly real) identity this
  // resolved to — no name, no id, no lease info, just the generic message.
  assert.deepEqual(Object.keys(takeover.body).sort(), ['message', 'requiresVerification']);

  const loginBeforeVerify = await api('POST', '/api/renter/login', { email: 'existing.tenant@example.com', password: 'attackerpassword1' });
  assert.equal(loginBeforeVerify.status, 403, 'a correct password from an unverified self-signup must not be enough to sign in');
  assert.equal(loginBeforeVerify.hasSetCookie, false);

  const verifyToken = db.prepare(`
    SELECT t.token FROM renter_tokens t JOIN renters r ON r.id = t.renter_id
    WHERE r.email = 'existing.tenant@example.com' AND t.purpose = 'verify_email' AND t.used_at IS NULL ORDER BY t.id DESC LIMIT 1
  `).get();
  assert.ok(verifyToken, 'signup must have issued a verify_email token');
  const confirm = await api('POST', '/api/renter/verify-email/confirm', { token: verifyToken.token });
  assert.equal(confirm.status, 200);

  const loginAfterVerify = await api('POST', '/api/renter/login', { email: 'existing.tenant@example.com', password: 'attackerpassword1' });
  assert.equal(loginAfterVerify.status, 200);
  assert.ok(loginAfterVerify.cookie);
});

test('signing up again for an email that already has a working password is refused, not silently overwritten', async () => {
  const code = await getConnectionCode();
  const first = await api('POST', '/api/renter/signup', {
    name: 'Original Owner Of Account', phone: '+15005550002', email: 'has.password.already@example.com',
    password: 'firstpassword1', confirmPassword: 'firstpassword1', connectionCode: code,
  });
  assert.equal(first.status, 201);

  const second = await api('POST', '/api/renter/signup', {
    name: 'Someone Else', phone: '+15005550003', email: 'has.password.already@example.com',
    password: 'secondpassword1', confirmPassword: 'secondpassword1', connectionCode: code,
  });
  assert.equal(second.status, 409);
});

test('the public verify-email resend endpoint needs no session and never reveals whether an email has an account', async () => {
  const unknown = await api('POST', '/api/renter/verify-email/resend', { email: 'nobody-at-all@example.com' });
  const code = await getConnectionCode();
  await api('POST', '/api/renter/signup', {
    name: 'Needs Resend', phone: '+15005550004', email: 'needs.resend@example.com',
    password: 'needsresend1', confirmPassword: 'needsresend1', connectionCode: code,
  });
  const known = await api('POST', '/api/renter/verify-email/resend', { email: 'needs.resend@example.com' });
  assert.equal(unknown.status, 200);
  assert.equal(known.status, 200);
  assert.equal(unknown.body.message, known.body.message, 'the response must not differ based on whether the email exists');

  const verifyToken = db.prepare(`
    SELECT t.token FROM renter_tokens t JOIN renters r ON r.id = t.renter_id
    WHERE r.email = 'needs.resend@example.com' AND t.purpose = 'verify_email' AND t.used_at IS NULL ORDER BY t.id DESC LIMIT 1
  `).get();
  assert.ok(verifyToken, 'resend must issue a fresh usable token for a real, unverified email');
});

test('an expired invitation never blocks an existing, already-onboarded renter from signing in via the plain email+password login', async () => {
  const invite = await api('POST', '/api/renters/invite', { name: 'Long Time Renter', email: 'long.time.renter@example.com' }, ownerCookie);
  await api('POST', '/api/renter/accept-invite', { token: tokenFromInviteUrl(invite.body.url), password: 'real-password-123' });

  // A separate, stale invitation for this SAME already-onboarded renter —
  // representing some earlier re-send they never clicked — now expired.
  db.prepare(`
    INSERT INTO renter_tokens (token, renter_id, purpose, expires_at) VALUES (?, ?, 'invitation', datetime('now', '-1 day'))
  `).run('expired-test-token-0001', invite.body.renter.id);

  const expiredPreview = await api('GET', '/api/renter/invite/expired-test-token-0001');
  assert.equal(expiredPreview.status, 410, 'the stale token itself should correctly read as expired');

  const login = await api('POST', '/api/renter/login', { email: 'long.time.renter@example.com', password: 'real-password-123' });
  assert.equal(login.status, 200, 'an unrelated expired invitation must never block normal login for an existing account');
});

// ---------------------------------------------------------------------------
// 4. Unassigned Renters listing — the exact fields the dashboard panel
//    renders, correct after assignment, and owner-scoped.
// ---------------------------------------------------------------------------

test('the unassigned list carries full name, phone, email, signup date, and account/verification state, and drops a renter once assigned', async () => {
  const code = await getConnectionCode();
  const signup = await api('POST', '/api/renter/signup', {
    name: 'Unassigned Lister', phone: '+15005550005', email: 'unassigned.lister@example.com',
    password: 'unassignedpw1', confirmPassword: 'unassignedpw1', connectionCode: code,
  });
  assert.equal(signup.status, 201);

  const list = await api('GET', '/api/renters/unassigned', null, ownerCookie);
  assert.equal(list.status, 200);
  const row = list.body.find((r) => r.email === 'unassigned.lister@example.com');
  assert.ok(row, 'a fresh self-signup must appear in Unassigned Renters right away');
  assert.equal(row.name, 'Unassigned Lister');
  assert.equal(row.phone, '+15005550005');
  assert.equal(row.hasAccount, true);
  assert.equal(row.emailVerified, false, 'pending verification must be visible, not silently true');
  assert.ok(row.createdAt, 'a signup date is required for the dashboard column');

  const { propertyId } = await createActiveLease({ startDate: '2027-01-01' });
  // createActiveLease already put an active lease on that property, so use a
  // fresh one instead for this specific assignment.
  const freshProperty = await api('POST', '/api/properties', { name: `Assign Target ${Math.random()}`, timezone: 'UTC' }, ownerCookie);
  const assign = await api('POST', `/api/renters/${row.id}/assign`, { propertyId: freshProperty.body.id, startDate: '2026-06-01' }, ownerCookie);
  assert.equal(assign.status, 201);

  const listAfter = await api('GET', '/api/renters/unassigned', null, ownerCookie);
  assert.ok(!listAfter.body.some((r) => r.id === row.id), 'must disappear from Unassigned Renters once assigned to a property');
});

test('Unassigned Renters is owner-scoped — one owner never sees another owner’s unassigned renters', async () => {
  db.prepare("INSERT INTO owners (name, email, password_hash) VALUES ('Third Landlord','third.landlord@renterworkflow.test','h')").run();
  const thirdOwnerId = db.prepare("SELECT id FROM owners WHERE email = 'third.landlord@renterworkflow.test'").get().id;
  const thirdOwnerCookie = `session_token=${createSession(db, thirdOwnerId)}`;

  await api('POST', '/api/renters/invite', { name: 'Belongs To Owner A', email: 'belongs.to.owner.a@example.com' }, ownerCookie);
  const thirdOwnerList = await api('GET', '/api/renters/unassigned', null, thirdOwnerCookie);
  assert.ok(!thirdOwnerList.body.some((r) => r.email === 'belongs.to.owner.a@example.com'));
});

// ---------------------------------------------------------------------------
// 5. Waiting-on-assignment data contract — what the renter portal's lease
//    list actually returns for a not-yet-assigned renter, a draft (pending)
//    tenancy, and an existing renter whose OTHER lease must stay visible
//    while a new one is pending.
// ---------------------------------------------------------------------------

test('a renter with no lease yet gets an empty lease list, a newly-assigned renter gets exactly one draft lease', async () => {
  const invite = await api('POST', '/api/renters/invite', { name: 'Waiting Renter', email: 'waiting.renter@example.com' }, ownerCookie);
  const accept = await api('POST', '/api/renter/accept-invite', { token: tokenFromInviteUrl(invite.body.url), password: 'waiting-password-1' });

  const before = await api('GET', '/api/renter/leases', null, accept.cookie);
  assert.deepEqual(before.body, [], 'no lease_renters row at all must mean an empty list, never an error or a fabricated entry');

  const property = await api('POST', '/api/properties', { name: `Waiting Target ${Math.random()}`, timezone: 'UTC' }, ownerCookie);
  await api('POST', `/api/renters/${invite.body.renter.id}/assign`, { propertyId: property.body.id, startDate: '2026-06-01' }, ownerCookie);

  const after = await api('GET', '/api/renter/leases', null, accept.cookie);
  assert.equal(after.body.length, 1);
  assert.equal(after.body[0].status, 'draft', 'a freshly-assigned tenancy must read as draft until a lease agreement is signed');
});

test('an existing renter with an active lease keeps seeing it once a second, pending tenancy is assigned to them', async () => {
  const invite = await api('POST', '/api/renters/invite', { name: 'Dual Tenancy Renter', email: 'dual.tenancy@example.com' }, ownerCookie);
  const accept = await api('POST', '/api/renter/accept-invite', { token: tokenFromInviteUrl(invite.body.url), password: 'dual-tenancy-pw-1' });
  const { leaseId: activeLeaseId } = await createActiveLease();
  // POST /api/leases/:id/renters has no "existing renter id" field — it
  // dedups by email via findOrCreateRenter, so matching the same email is
  // what links this SAME renter identity to a second lease.
  const linked = await api('POST', `/api/leases/${activeLeaseId}/renters`, { name: 'Dual Tenancy Renter', email: 'dual.tenancy@example.com', role: 'primary' }, ownerCookie);
  assert.equal(linked.body.id, invite.body.renter.id, 'must reuse the existing renter identity, never create a duplicate one');

  const newProperty = await api('POST', '/api/properties', { name: `Second Tenancy ${Math.random()}`, timezone: 'UTC' }, ownerCookie);
  await api('POST', `/api/renters/${invite.body.renter.id}/assign`, { propertyId: newProperty.body.id, startDate: '2026-08-01' }, ownerCookie);

  const leases = await api('GET', '/api/renter/leases', null, accept.cookie);
  assert.equal(leases.body.length, 2, 'the existing lease must never be hidden just because a new one is pending');
  assert.ok(leases.body.some((l) => l.id === activeLeaseId && l.status === 'active'));
  assert.ok(leases.body.some((l) => l.status === 'draft'));
});

// ---------------------------------------------------------------------------
// 6. Renter session model — sliding inactivity timeout is what actually
//    enforces "a new visit," not the cookie shape; explicit sign-out is
//    immediate.
// ---------------------------------------------------------------------------

test('a renter session idle for longer than the timeout is rejected and removed; one still within the window slides forward instead', async () => {
  const invite = await api('POST', '/api/renters/invite', { name: 'Idle Timeout', email: 'idle.timeout@example.com' }, ownerCookie);
  const accept = await api('POST', '/api/renter/accept-invite', { token: tokenFromInviteUrl(invite.body.url), password: 'idle-timeout-pw-1' });
  const token = accept.cookie.split('=')[1];

  const active = await api('GET', '/api/renter/me', null, accept.cookie);
  assert.equal(active.status, 200);

  db.prepare("UPDATE renter_sessions SET last_seen_at = datetime('now', '-10 minutes') WHERE token = ?").run(token);
  const stillWithinWindow = await api('GET', '/api/renter/me', null, accept.cookie);
  assert.equal(stillWithinWindow.status, 200, 'well within the default 30-minute idle timeout, the session must still work');
  const slid = db.prepare('SELECT last_seen_at FROM renter_sessions WHERE token = ?').get(token);
  assert.ok(Date.now() - new Date(slid.last_seen_at + 'Z').getTime() < 60 * 1000, 'a successful authenticated request must slide last_seen_at forward, not leave it stale');

  db.prepare("UPDATE renter_sessions SET last_seen_at = datetime('now', '-31 minutes') WHERE token = ?").run(token);
  const timedOut = await api('GET', '/api/renter/me', null, accept.cookie);
  assert.equal(timedOut.status, 401);
  assert.match(timedOut.body.error, /minutes of inactivity/i);
  assert.equal(db.prepare('SELECT 1 FROM renter_sessions WHERE token = ?').get(token), undefined, 'a timed-out session row must be removed, not just refused once');

  const reusedAfterTimeout = await api('GET', '/api/renter/me', null, accept.cookie);
  assert.equal(reusedAfterTimeout.status, 401, 'the same now-deleted cookie must not work on a second try either');
});

test('explicit sign-out ends the session immediately, and the same cookie cannot be reused afterward', async () => {
  const invite = await api('POST', '/api/renters/invite', { name: 'Signs Out', email: 'signs.out@example.com' }, ownerCookie);
  const accept = await api('POST', '/api/renter/accept-invite', { token: tokenFromInviteUrl(invite.body.url), password: 'signs-out-pw-1' });

  const logout = await api('POST', '/api/renter/logout', {}, accept.cookie);
  assert.equal(logout.status, 200);

  const reused = await api('GET', '/api/renter/me', null, accept.cookie);
  assert.equal(reused.status, 401);
});

// ---------------------------------------------------------------------------
// 8. Twilio delivery-status webhook — correct signature required, unknown or
//    duplicate callbacks are a no-op rather than an error, and a terminal
//    status is never regressed by an out-of-order retry.
// ---------------------------------------------------------------------------

test('a correctly-signed Twilio status callback updates the matching sms_messages row', () => withEnv({ TWILIO_AUTH_TOKEN: 'webhook-test-auth-token' }, async () => {
  const row = db.prepare(`
    INSERT INTO sms_messages (owner_id, purpose, to_phone, body, provider_message_id, status) VALUES (?, 'invitation', '+15005550006', 'test body', 'SMtest0001', 'sent')
  `).run(ownerId);
  const smsId = row.lastInsertRowid;

  const webhookUrl = `${baseUrl}/api/webhooks/twilio-sms`;
  const params = { MessageSid: 'SMtest0001', MessageStatus: 'delivered' };
  const signature = signTwilioParams(webhookUrl, params, 'webhook-test-auth-token');
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': signature },
    body: new URLSearchParams(params).toString(),
  });
  assert.equal(res.status, 200);

  const fetched = await api('GET', `/api/sms-messages/${smsId}`, null, ownerCookie);
  assert.equal(fetched.body.status, 'delivered');
}));

test('a tampered or missing Twilio signature is rejected and never updates the row', () => withEnv({ TWILIO_AUTH_TOKEN: 'webhook-test-auth-token' }, async () => {
  const row = db.prepare(`
    INSERT INTO sms_messages (owner_id, purpose, to_phone, body, provider_message_id, status) VALUES (?, 'invitation', '+15005550006', 'test body', 'SMtest0002', 'sent')
  `).run(ownerId);
  const smsId = row.lastInsertRowid;
  const webhookUrl = `${baseUrl}/api/webhooks/twilio-sms`;
  const params = { MessageSid: 'SMtest0002', MessageStatus: 'delivered' };
  const body = new URLSearchParams(params).toString();

  const tampered = await fetch(webhookUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': 'not-the-real-signature' }, body,
  });
  assert.equal(tampered.status, 400);

  const missing = await fetch(webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  assert.equal(missing.status, 400);

  const fetched = await api('GET', `/api/sms-messages/${smsId}`, null, ownerCookie);
  assert.equal(fetched.body.status, 'sent', 'an unverified callback must never change the recorded status');
}));

test('an out-of-order callback can never regress a terminal status back to an earlier one', () => withEnv({ TWILIO_AUTH_TOKEN: 'webhook-test-auth-token' }, async () => {
  const row = db.prepare(`
    INSERT INTO sms_messages (owner_id, purpose, to_phone, body, provider_message_id, status) VALUES (?, 'invitation', '+15005550006', 'test body', 'SMtest0003', 'delivered')
  `).run(ownerId);
  const smsId = row.lastInsertRowid;
  const webhookUrl = `${baseUrl}/api/webhooks/twilio-sms`;
  const params = { MessageSid: 'SMtest0003', MessageStatus: 'sent' }; // a late retry of an earlier status
  const signature = signTwilioParams(webhookUrl, params, 'webhook-test-auth-token');
  const res = await fetch(webhookUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': signature }, body: new URLSearchParams(params).toString(),
  });
  assert.equal(res.status, 200);

  const fetched = await api('GET', `/api/sms-messages/${smsId}`, null, ownerCookie);
  assert.equal(fetched.body.status, 'delivered', 'a terminal status must never be moved backward by a late/duplicate callback');
}));

test('a callback for an unrecognized MessageSid is a harmless no-op, not an error', () => withEnv({ TWILIO_AUTH_TOKEN: 'webhook-test-auth-token' }, async () => {
  const webhookUrl = `${baseUrl}/api/webhooks/twilio-sms`;
  const params = { MessageSid: 'SMdoes-not-exist', MessageStatus: 'delivered' };
  const signature = signTwilioParams(webhookUrl, params, 'webhook-test-auth-token');
  const res = await fetch(webhookUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': signature }, body: new URLSearchParams(params).toString(),
  });
  assert.equal(res.status, 200);
}));

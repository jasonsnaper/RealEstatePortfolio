// End-to-end coverage for the renter-accounts feature set: owner-provisioned
// renter identities and invitations (server/routes/renterManagement.js,
// renterAuth.js), the authenticated renter portal itself
// (server/routes/renterPortal.js), explicit per-lease/renter document
// sharing (server/routes/documents.js), paying a not-yet-due period early
// (chargeGenerator.ensureNextPeriodCharge), and owner-generated payment
// statements (server/routes/statements.js). Each of these was designed to
// layer on top of the pre-existing token-based tenant portal without
// changing its behavior — test/integration.test.js's tenant-portal tests
// cover that older path and must keep passing unmodified alongside this file.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const http = require('http');

const { createApp } = require('../server/index');
const { openDatabase } = require('../server/db');
const { createSession } = require('../server/lib/helpers');
const { createRenterSession } = require('../server/lib/renterAuth');
const { todayInTimezone } = require('../server/lib/dates');

let server, db, baseUrl, port;
let ownerCookie;

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
  return { status: res.status, body: json, cookie: setCookie ? setCookie.split(';')[0] : null };
}

function tokenFromInviteUrl(url) {
  return url.split('/').pop();
}

const TODAY = todayInTimezone('UTC');

before(async () => {
  const tmpFile = path.join(os.tmpdir(), `rental-app-renterportal-test-${Date.now()}.db`);
  db = openDatabase(tmpFile);
  db.prepare("INSERT INTO owners (name, email, password_hash) VALUES ('Landlord','landlord@x.com','h')").run();
  ownerCookie = `session_token=${createSession(db, 1)}`;

  port = 47000 + Math.floor(Math.random() * 3000);
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

async function createActiveLease({ rent = '1500.00', tenantName = 'Riley Tenant', tenantEmail = 'riley@example.com' } = {}) {
  const property = await api('POST', '/api/properties', { name: `Renter Portal Test House ${Math.random()}`, timezone: 'UTC' }, ownerCookie);
  const lease = await api('POST', `/api/properties/${property.body.id}/leases`, { tenantName, tenantEmail, startDate: TODAY, rent }, ownerCookie);
  return { propertyId: property.body.id, leaseId: lease.body.id, chargeId: lease.body.charges[0].id };
}

// --- Owner-facing renter management + invitation --------------------------

test('owner adds a renter to a lease, invites them, and the invite can be previewed before acceptance', async () => {
  const { leaseId } = await createActiveLease();
  const add = await api('POST', `/api/leases/${leaseId}/renters`, { name: 'Riley Tenant', email: 'riley@example.com', role: 'primary' }, ownerCookie);
  assert.equal(add.status, 201);
  assert.equal(add.body.hasAccount, false);

  const invite = await api('POST', `/api/leases/${leaseId}/renters/${add.body.id}/invite`, {}, ownerCookie);
  assert.equal(invite.status, 201);
  assert.ok(invite.body.url.includes('/renter#/accept-invite/'));

  const token = tokenFromInviteUrl(invite.body.url);
  const preview = await api('GET', `/api/renter/invite/${token}`);
  assert.equal(preview.status, 200);
  assert.equal(preview.body.renterName, 'Riley Tenant');
  assert.equal(preview.body.alreadyHasAccount, false);
});

test('inviting a renter with no email on file is refused with a clear error', async () => {
  const { leaseId } = await createActiveLease();
  const add = await api('POST', `/api/leases/${leaseId}/renters`, { name: 'No Email Renter' }, ownerCookie);
  assert.equal(add.status, 201);
  const invite = await api('POST', `/api/leases/${leaseId}/renters/${add.body.id}/invite`, {}, ownerCookie);
  assert.equal(invite.status, 400);
});

test('adding the same email twice to different leases links the SAME renter identity, not a duplicate', async () => {
  const leaseA = await createActiveLease();
  const leaseB = await createActiveLease();
  const first = await api('POST', `/api/leases/${leaseA.leaseId}/renters`, { name: 'Dana Dual-Lease', email: 'dana@example.com' }, ownerCookie);
  const second = await api('POST', `/api/leases/${leaseB.leaseId}/renters`, { name: 'Dana D.', email: 'DANA@Example.com' }, ownerCookie);
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(first.body.id, second.body.id, 'case-insensitive email match should resolve to the same renter row');
});

// --- Accepting an invite + signing in ---------------------------------------

async function inviteAndAccept(leaseId, { name = 'Riley Tenant', email = 'riley@example.com', password = 'correct-horse-battery' } = {}) {
  const add = await api('POST', `/api/leases/${leaseId}/renters`, { name, email, role: 'primary' }, ownerCookie);
  const invite = await api('POST', `/api/leases/${leaseId}/renters/${add.body.id}/invite`, {}, ownerCookie);
  const token = tokenFromInviteUrl(invite.body.url);
  const accept = await api('POST', '/api/renter/accept-invite', { token, password });
  return { renterId: add.body.id, accept };
}

test('accepting an invite sets a password, links the lease, and signs the renter in immediately', async () => {
  const { leaseId } = await createActiveLease();
  const { accept } = await inviteAndAccept(leaseId);
  assert.equal(accept.status, 200);
  assert.ok(accept.cookie, 'accept-invite should set the renter_session cookie');
  assert.equal(accept.body.leaseId, leaseId);

  const me = await api('GET', '/api/renter/me', null, accept.cookie);
  assert.equal(me.status, 200);
  assert.equal(me.body.hasAccount, true);
});

test('using an invite token a second time fails (single use)', async () => {
  const { leaseId } = await createActiveLease();
  const add = await api('POST', `/api/leases/${leaseId}/renters`, { name: 'One Time', email: 'onetime@example.com' }, ownerCookie);
  const invite = await api('POST', `/api/leases/${leaseId}/renters/${add.body.id}/invite`, {}, ownerCookie);
  const token = tokenFromInviteUrl(invite.body.url);
  const first = await api('POST', '/api/renter/accept-invite', { token, password: 'first-password-1' });
  assert.equal(first.status, 200);
  const second = await api('POST', '/api/renter/accept-invite', { token, password: 'second-password-1' });
  assert.equal(second.status, 410);
});

test('login rejects a wrong password and an unknown email with the same generic message (no user enumeration)', async () => {
  const { leaseId } = await createActiveLease();
  await inviteAndAccept(leaseId, { email: 'realuser@example.com', password: 'the-real-password-1' });

  const wrongPassword = await api('POST', '/api/renter/login', { email: 'realuser@example.com', password: 'nope' });
  const unknownEmail = await api('POST', '/api/renter/login', { email: 'nobody-here@example.com', password: 'nope' });
  assert.equal(wrongPassword.status, 401);
  assert.equal(unknownEmail.status, 401);
  assert.equal(wrongPassword.body.error, unknownEmail.body.error);

  const right = await api('POST', '/api/renter/login', { email: 'realuser@example.com', password: 'the-real-password-1' });
  assert.equal(right.status, 200);
  assert.ok(right.cookie);
});

test('forgot-password issues a working single-use reset token; the old password stops working after reset', async () => {
  const { leaseId } = await createActiveLease();
  await inviteAndAccept(leaseId, { email: 'forgetful@example.com', password: 'original-password-1' });

  await api('POST', '/api/renter/forgot-password', { email: 'forgetful@example.com' });
  const tokenRow = db.prepare("SELECT * FROM renter_tokens WHERE purpose = 'reset_password' ORDER BY id DESC LIMIT 1").get();
  assert.ok(tokenRow, 'a reset_password token should have been created');

  const reset = await api('POST', '/api/renter/reset-password', { token: tokenRow.token, newPassword: 'brand-new-password-1' });
  assert.equal(reset.status, 200);

  const oldLogin = await api('POST', '/api/renter/login', { email: 'forgetful@example.com', password: 'original-password-1' });
  assert.equal(oldLogin.status, 401);
  const newLogin = await api('POST', '/api/renter/login', { email: 'forgetful@example.com', password: 'brand-new-password-1' });
  assert.equal(newLogin.status, 200);

  const reused = await api('POST', '/api/renter/reset-password', { token: tokenRow.token, newPassword: 'another-one-1' });
  assert.equal(reused.status, 400, 'a reset token must not be usable twice');
});

test('logout clears the renter session so /api/renter/me stops working', async () => {
  const { leaseId } = await createActiveLease();
  const { accept } = await inviteAndAccept(leaseId, { email: 'logout-test@example.com' });
  const before = await api('GET', '/api/renter/me', null, accept.cookie);
  assert.equal(before.status, 200);
  await api('POST', '/api/renter/logout', {}, accept.cookie);
  const after1 = await api('GET', '/api/renter/me', null, accept.cookie);
  assert.equal(after1.status, 401);
});

// --- The renter portal itself ----------------------------------------------

test('a signed-in renter sees their lease with the correct outstanding balance, and nothing from another owner', async () => {
  const { leaseId } = await createActiveLease({ rent: '1200.00' });
  const { accept } = await inviteAndAccept(leaseId, { email: 'balance-check@example.com' });

  const leases = await api('GET', '/api/renter/leases', null, accept.cookie);
  assert.equal(leases.status, 200);
  assert.equal(leases.body.length, 1);
  assert.equal(leases.body[0].outstandingCents, 120000);
  assert.equal(leases.body[0].status, 'active', 'the LEASE lifecycle status must survive, not be overwritten by the rent-status summary');
  assert.equal(leases.body[0].rentStatus, 'late', 'the rent-status summary should be under its own key (matches properties.js\'s rentStatus convention)');

  const detail = await api('GET', `/api/renter/leases/${leaseId}`, null, accept.cookie);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.tenantName, 'Riley Tenant');

  const otherLease = await createActiveLease();
  const wrongLease = await api('GET', `/api/renter/leases/${otherLease.leaseId}`, null, accept.cookie);
  assert.equal(wrongLease.status, 404, 'a renter must never be able to fetch a lease they are not linked to');
});

test('renter portal requires a session at all — no cookie is a 401, not a leak', async () => {
  const { leaseId } = await createActiveLease();
  const res = await api('GET', `/api/renter/leases/${leaseId}`, null, null);
  assert.equal(res.status, 401);
});

test('document sharing is explicit and lease-scoped: only shared docs appear, and never to a renter on a different lease', async () => {
  const { propertyId, leaseId } = await createActiveLease();
  const other = await createActiveLease();
  const { accept: renterA } = await inviteAndAccept(leaseId, { email: 'doc-viewer-a@example.com' });
  const { accept: renterB } = await inviteAndAccept(other.leaseId, { email: 'doc-viewer-b@example.com' });

  const unshared = await api('POST', `/api/properties/${propertyId}/documents`, {
    dataUrl: 'data:text/plain;base64,' + Buffer.from('private').toString('base64'), filename: 'private.txt', category: 'other',
  }, ownerCookie);
  const shared = await api('POST', `/api/properties/${propertyId}/documents`, {
    dataUrl: 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4 fake').toString('base64'), filename: 'lease.pdf', category: 'lease',
    shareWithLeaseIds: [leaseId],
  }, ownerCookie);
  assert.equal(unshared.status, 201);
  assert.equal(shared.status, 201);

  const docsA = await api('GET', `/api/renter/leases/${leaseId}/documents`, null, renterA.cookie);
  assert.equal(docsA.status, 200);
  assert.equal(docsA.body.length, 1);
  assert.equal(docsA.body[0].filename, 'lease.pdf');

  const docsB = await api('GET', `/api/renter/leases/${other.leaseId}/documents`, null, renterB.cookie);
  assert.equal(docsB.status, 200);
  assert.equal(docsB.body.length, 0, 'a document shared with lease A must not leak to a renter on lease B at a different property');

  // Re-sharing (replacing the whole share list) can also target a renter
  // directly rather than a lease, and un-sharing removes visibility again.
  const renterAId = (await api('GET', '/api/renters', null, ownerCookie)).body.find((r) => r.email === 'doc-viewer-a@example.com').id;
  const reshared = await api('PUT', `/api/documents/${shared.body.id}/shares`, { leaseIds: [], renterIds: [renterAId] }, ownerCookie);
  assert.equal(reshared.status, 200);
  const stillVisible = await api('GET', `/api/renter/leases/${leaseId}/documents`, null, renterA.cookie);
  assert.equal(stillVisible.body.length, 1, 'a renter-scoped share should keep the document visible even after the lease-scoped share is removed');

  const unsharedNow = await api('PUT', `/api/documents/${shared.body.id}/shares`, { leaseIds: [], renterIds: [] }, ownerCookie);
  assert.equal(unsharedNow.status, 200);
  const goneNow = await api('GET', `/api/renter/leases/${leaseId}/documents`, null, renterA.cookie);
  assert.equal(goneNow.body.length, 0);
});

test('a renter can file a maintenance request through the portal, and the owner sees it attributed to the right lease', async () => {
  const { leaseId } = await createActiveLease();
  const { accept } = await inviteAndAccept(leaseId, { email: 'maint-renter@example.com' });

  const filed = await api('POST', `/api/renter/leases/${leaseId}/maintenance`, { title: 'Leaky faucet', description: 'Kitchen sink drips constantly' }, accept.cookie);
  assert.equal(filed.status, 201);

  const list = await api('GET', `/api/renter/leases/${leaseId}/maintenance`, null, accept.cookie);
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].title, 'Leaky faucet');
});

test('a renter can pay a future period early via advance-charge + checkout with an explicit chargeId', async () => {
  const { leaseId, chargeId } = await createActiveLease({ rent: '1000.00' });
  const { accept } = await inviteAndAccept(leaseId, { email: 'early-payer@example.com' });

  const advanced = await api('POST', `/api/renter/leases/${leaseId}/advance-charge`, {}, accept.cookie);
  assert.equal(advanced.status, 200);
  assert.notEqual(advanced.body.id, chargeId, 'advance-charge should create the NEXT period, not touch the current one');

  const checkout = await api('POST', `/api/renter/leases/${leaseId}/checkout`, { chargeId: advanced.body.id }, accept.cookie);
  assert.equal(checkout.status, 201);
  assert.equal(checkout.body.amountCents, 100000);

  // Complete the simulated payment end to end, proving the renter-portal
  // checkout (which mints its own payment link under the hood — see
  // paymentLinks.js's getOrCreateActiveLinkForLease) settles money exactly
  // like the token-based tenant portal's checkout does.
  const simulate = await api('POST', `/api/mock-checkout/${checkout.body.sessionId}/simulate`, { outcome: 'success' });
  assert.equal(simulate.status, 200);
  const status = await api('GET', `/api/renter/leases/${leaseId}/sessions/${checkout.body.sessionId}`, null, accept.cookie);
  assert.equal(status.body.status, 'succeeded');

  const detail = await api('GET', `/api/renter/leases/${leaseId}`, null, accept.cookie);
  const advancedCharge = detail.body.charges.find((c) => c.id === advanced.body.id);
  assert.equal(advancedCharge.status, 'paid');
});

test('a checkout for an already-fully-paid charge is refused with 409', async () => {
  const { leaseId, chargeId } = await createActiveLease({ rent: '800.00' });
  const { accept } = await inviteAndAccept(leaseId, { email: 'double-pay@example.com' });
  const checkout1 = await api('POST', `/api/renter/leases/${leaseId}/checkout`, { chargeId }, accept.cookie);
  await api('POST', `/api/mock-checkout/${checkout1.body.sessionId}/simulate`, { outcome: 'success' });
  const checkout2 = await api('POST', `/api/renter/leases/${leaseId}/checkout`, { chargeId }, accept.cookie);
  assert.equal(checkout2.status, 409);
});

test('an ended lease is still visible to its renter (historical access), but maintenance and checkout are refused', async () => {
  const { leaseId } = await createActiveLease({ rent: '900.00' });
  const { accept } = await inviteAndAccept(leaseId, { email: 'moved-out@example.com' });
  const end = await api('POST', `/api/leases/${leaseId}/end`, { endDate: TODAY, depositDisposition: 'Returned in full' }, ownerCookie);
  assert.equal(end.status, 200, JSON.stringify(end.body));

  const stillVisible = await api('GET', `/api/renter/leases/${leaseId}`, null, accept.cookie);
  assert.equal(stillVisible.status, 200);
  assert.equal(stillVisible.body.status, 'ended');

  const maint = await api('POST', `/api/renter/leases/${leaseId}/maintenance`, { title: 'too late' }, accept.cookie);
  assert.equal(maint.status, 409);
  const checkout = await api('POST', `/api/renter/leases/${leaseId}/checkout`, {}, accept.cookie);
  assert.equal(checkout.status, 409);
});

// Same root cause as statementsRoutes.test.js's ended-lease regression:
// ensureChargesGenerated backfills every elapsed period for an ACTIVE lease
// up through today, so a lease started well in the past accumulates many
// months of charges immediately. If the owner then ends it with a backdated
// end date, those already-generated post-move-out charges must not show up
// as part of what the renter "owes" — both in the lease list summary and
// the full per-lease charges table.
test('an ended lease\'s charges (list summary and per-lease detail) exclude periods after the end date', async () => {
  const twoYearsAgo = `${Number(TODAY.slice(0, 4)) - 2}-01-01`;
  // createActiveLease always starts the lease "today" (see its definition
  // above), which never backfills more than one charge — build this one
  // directly so its start date is far enough in the past to reproduce the
  // backfill.
  const property = await api('POST', '/api/properties', { name: `Backdated Renter Test ${Math.random()}`, timezone: 'UTC' }, ownerCookie);
  const oldLease = await api('POST', `/api/properties/${property.body.id}/leases`, {
    tenantName: 'Departed Renter', tenantEmail: 'departed@example.com', startDate: twoYearsAgo, rent: '1100.00',
  }, ownerCookie);
  const oldLeaseId = oldLease.body.id;
  assert.ok(oldLease.body.charges.length > 12, 'test setup should have backfilled well over a year of charges');

  const { accept } = await inviteAndAccept(oldLeaseId, { email: 'departed@example.com' });
  const endedSixMonthsAgo = (() => {
    const [y, m] = TODAY.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1, 1));
    d.setUTCMonth(d.getUTCMonth() - 6);
    return d.toISOString().slice(0, 10);
  })();
  const end = await api('POST', `/api/leases/${oldLeaseId}/end`, { endDate: endedSixMonthsAgo, depositDisposition: 'Returned in full' }, ownerCookie);
  assert.equal(end.status, 200);

  const detail = await api('GET', `/api/renter/leases/${oldLeaseId}`, null, accept.cookie);
  assert.equal(detail.status, 200);
  assert.ok(detail.body.charges.length > 0);
  for (const c of detail.body.charges) {
    assert.ok(c.periodStart <= endedSixMonthsAgo, `charge for ${c.periodStart} is after end date ${endedSixMonthsAgo}`);
  }

  const list = await api('GET', '/api/renter/leases', null, accept.cookie);
  assert.equal(list.status, 200);
  const summary = list.body.find((l) => l.id === oldLeaseId);
  assert.ok(summary, 'the ended lease should still appear in the list (historical access)');
  // With every post-move-out charge correctly excluded, the only charges
  // left (all from well before the end date) should already be fully late
  // — nothing "upcoming" bleeding in from beyond the tenancy.
  assert.notEqual(summary.rentStatus, 'upcoming');
});

test('merging a duplicate renter reassigns lease access and resolves the old session transparently', async () => {
  const leaseA = await createActiveLease();
  const leaseB = await createActiveLease();
  const keep = await api('POST', `/api/leases/${leaseA.leaseId}/renters`, { name: 'Jordan Primary', email: 'jordan.primary@example.com' }, ownerCookie);
  const dupe = await api('POST', `/api/leases/${leaseB.leaseId}/renters`, { name: 'Jordan Alt Email', email: 'jordan.alt@example.com' }, ownerCookie);
  const dupeSessionToken = createRenterSession(db, dupe.body.id);

  const merge = await api('POST', '/api/renters/merge', { keepRenterId: keep.body.id, mergeRenterId: dupe.body.id }, ownerCookie);
  assert.equal(merge.status, 200);

  const meViaOldSession = await api('GET', '/api/renter/me', null, `renter_session=${dupeSessionToken}`);
  assert.equal(meViaOldSession.status, 200);
  assert.equal(meViaOldSession.body.id, keep.body.id, "the merged-away renter's old session must resolve to the kept identity");

  const leasesNow = await api('GET', `/api/leases/${leaseB.leaseId}/renters`, null, ownerCookie);
  assert.ok(leasesNow.body.some((r) => r.id === keep.body.id), 'the kept renter should now be linked to the merged renter\'s lease too');
});

// --- Payment statements ------------------------------------------------

test('a statement is invisible to the renter until the owner shares it, then visible and downloadable', async () => {
  const { leaseId } = await createActiveLease({ rent: '1500.00' });
  const { accept } = await inviteAndAccept(leaseId, { email: 'statement-viewer@example.com' });

  const generate = await api('POST', `/api/leases/${leaseId}/statements`, { rangeType: 'lease_to_date' }, ownerCookie);
  assert.equal(generate.status, 201);
  assert.equal(generate.body.sharedWithRenter, false);

  const beforeShare = await api('GET', `/api/renter/leases/${leaseId}/statements`, null, accept.cookie);
  assert.equal(beforeShare.status, 200);
  assert.equal(beforeShare.body.length, 0);

  const share = await api('POST', `/api/statements/${generate.body.id}/share`, { shared: true }, ownerCookie);
  assert.equal(share.status, 200);
  assert.equal(share.body.sharedWithRenter, true);

  const afterShare = await api('GET', `/api/renter/leases/${leaseId}/statements`, null, accept.cookie);
  assert.equal(afterShare.status, 200);
  assert.equal(afterShare.body.length, 1);
  assert.ok(afterShare.body[0].url.includes('/statements/'));

  const download = await fetch(`${baseUrl}${afterShare.body[0].url}`, { headers: { Cookie: accept.cookie } });
  assert.equal(download.status, 200);
  const buf = Buffer.from(await download.arrayBuffer());
  assert.equal(buf.slice(0, 5).toString('ascii'), '%PDF-', 'the downloaded file should actually be a PDF');
});

test('a statement belonging to a different owner cannot be shared, emailed, or deleted', async () => {
  db.prepare("INSERT INTO owners (name, email, password_hash) VALUES ('Other Owner','other@x.com','h')").run();
  const otherOwnerCookie = `session_token=${createSession(db, db.prepare("SELECT id FROM owners WHERE email='other@x.com'").get().id)}`;
  const { leaseId } = await createActiveLease();
  const generate = await api('POST', `/api/leases/${leaseId}/statements`, { rangeType: 'lease_to_date' }, ownerCookie);

  const share = await api('POST', `/api/statements/${generate.body.id}/share`, { shared: true }, otherOwnerCookie);
  assert.equal(share.status, 404);
  const email = await api('POST', `/api/statements/${generate.body.id}/email`, {}, otherOwnerCookie);
  assert.equal(email.status, 404);
  const del = await api('DELETE', `/api/statements/${generate.body.id}`, null, otherOwnerCookie);
  assert.equal(del.status, 404);
});

test('emailing a statement simulates sending (no real provider), records who it was "sent" to, and shares it as a side effect', async () => {
  const { leaseId } = await createActiveLease();
  await api('POST', `/api/leases/${leaseId}/renters`, { name: 'Riley Tenant', email: 'riley@example.com' }, ownerCookie);
  const generate = await api('POST', `/api/leases/${leaseId}/statements`, { rangeType: 'lease_to_date' }, ownerCookie);

  const email = await api('POST', `/api/statements/${generate.body.id}/email`, {}, ownerCookie);
  assert.equal(email.status, 200);
  assert.equal(email.body.simulated, true);
  assert.equal(email.body.to, 'riley@example.com');
  assert.equal(email.body.statement.sharedWithRenter, true, 'emailing should also share the statement, or the renter could never open the link they were "sent"');
  assert.ok(email.body.statement.emailedAt);
});

test('generating a statement with an invalid range is rejected with 400', async () => {
  const { leaseId } = await createActiveLease();
  const badType = await api('POST', `/api/leases/${leaseId}/statements`, { rangeType: 'whenever' }, ownerCookie);
  assert.equal(badType.status, 400);
  const badCustomRange = await api('POST', `/api/leases/${leaseId}/statements`, { rangeType: 'custom', rangeStart: '2025-06-01', rangeEnd: '2025-01-01' }, ownerCookie);
  assert.equal(badCustomRange.status, 400);
});

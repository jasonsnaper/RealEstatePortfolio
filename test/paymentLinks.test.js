// Focused tests for "Get payment link" generation (server/routes/paymentLinks.js)
// and every handled failure state named in the bug report: missing/ended
// lease, no outstanding balance, and — since the reported symptom was the
// *client* hanging forever — this file makes sure the *server* side already
// answers every one of these cases promptly and unambiguously (a fast, clear
// 404/409/201 for the client to render), which is what public/js/api.js's
// timeout/error handling (see test/apiClient.test.js) and property.js's
// modal logic build on. It also proves the link itself is reachable with a
// bare token and no owner session at all, and that a deployed APP_BASE_URL
// (not "localhost") is what actually gets baked into the link's URL.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const http = require('http');

const { createApp } = require('../server/index');
const { openDatabase } = require('../server/db');
const { createSession } = require('../server/lib/helpers');
const { todayInTimezone } = require('../server/lib/dates');

let server, db, baseUrl, port;
let ownerACookie, ownerBCookie;

async function api(method, urlPath, body, cookie) {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { json = text; }
  return { status: res.status, body: json };
}

// A lease whose start date is "today" generates exactly one charge (see
// chargeGenerator.js: periods run from start_date through today inclusive),
// which keeps every test's "outstanding balance" state exact and legible
// instead of depending on how many months have elapsed since a fixed date.
const TODAY = todayInTimezone('UTC');

async function createLeaseWithOutstandingBalance(cookie, rent = '1200.00') {
  const property = await api('POST', '/api/properties', { name: `Payment Link Test House ${Math.random()}`, timezone: 'UTC' }, cookie);
  const lease = await api('POST', `/api/properties/${property.body.id}/leases`, {
    tenantName: 'Riley Tenant', tenantEmail: 'riley@example.com', startDate: TODAY, rent,
  }, cookie);
  return { propertyId: property.body.id, leaseId: lease.body.id, chargeId: lease.body.charges[0].id };
}

before(async () => {
  const tmpFile = path.join(os.tmpdir(), `rental-app-paymentlinks-test-${Date.now()}.db`);
  db = openDatabase(tmpFile);
  db.prepare("INSERT INTO owners (name, email, password_hash) VALUES ('Owner A','plA@x.com','h')").run();
  db.prepare("INSERT INTO owners (name, email, password_hash) VALUES ('Owner B','plB@x.com','h')").run();
  ownerACookie = `session_token=${createSession(db, 1)}`;
  ownerBCookie = `session_token=${createSession(db, 2)}`;

  port = 44000 + Math.floor(Math.random() * 3000);
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

test('generating a link for a lease with an outstanding balance succeeds, is honestly labeled as simulated, and points at this app', async () => {
  const { leaseId } = await createLeaseWithOutstandingBalance(ownerACookie);
  const res = await api('POST', `/api/leases/${leaseId}/payment-links`, {}, ownerACookie);
  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'active');
  assert.match(res.body.token, /^[0-9a-f]{64}$/, 'token should be 32 random bytes, hex-encoded, not derivable from the lease id');
  assert.equal(res.body.url, `${baseUrl}/pay/link/${res.body.token}`);
  assert.ok(res.body.expiresAt);
  // Never let the UI claim real money moves when only the simulator is wired up.
  assert.equal(res.body.provider.mode, 'test');
  assert.match(res.body.provider.notice, /no real (payment provider|money)/i);
});

test('asking again while the link is still valid returns the SAME link (200, not a fresh 201) rather than invalidating one already sent to the tenant', async () => {
  const { leaseId } = await createLeaseWithOutstandingBalance(ownerACookie);
  const first = await api('POST', `/api/leases/${leaseId}/payment-links`, {}, ownerACookie);
  assert.equal(first.status, 201);
  const second = await api('POST', `/api/leases/${leaseId}/payment-links`, {}, ownerACookie);
  assert.equal(second.status, 200, 're-requesting a still-active link is a lookup, not a new resource');
  assert.equal(second.body.token, first.body.token);
  assert.equal(second.body.id, first.body.id);
});

test('a lease with no outstanding balance is rejected with a clear 409, never a silent fake link', async () => {
  const { leaseId, chargeId } = await createLeaseWithOutstandingBalance(ownerACookie, '900.00');
  const pay = await api('POST', `/api/charges/${chargeId}/payments`, { amount: '900.00', method: 'check', paidAt: TODAY }, ownerACookie);
  assert.equal(pay.body.outstandingCents, 0);

  const res = await api('POST', `/api/leases/${leaseId}/payment-links`, {}, ownerACookie);
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'This tenant has no outstanding balance to collect right now');
});

test('a lease id that does not exist returns 404 promptly, not a hang', async () => {
  const res = await api('POST', '/api/leases/9999999/payment-links', {}, ownerACookie);
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'Lease not found');
});

test('an ended lease is rejected with a 409 distinct from the "no balance" case', async () => {
  const { leaseId } = await createLeaseWithOutstandingBalance(ownerACookie);
  const ended = await api('POST', `/api/leases/${leaseId}/end`, { endDate: TODAY }, ownerACookie);
  assert.equal(ended.status, 200);

  const res = await api('POST', `/api/leases/${leaseId}/payment-links`, {}, ownerACookie);
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'Cannot create a payment link for a lease that has ended');
});

test('an owner cannot generate (or even see) a payment link for another owner\'s lease', async () => {
  const { leaseId } = await createLeaseWithOutstandingBalance(ownerBCookie);
  const create = await api('POST', `/api/leases/${leaseId}/payment-links`, {}, ownerACookie);
  assert.equal(create.status, 404, "Owner A must not be able to create a link on Owner B's lease");
  const list = await api('GET', `/api/leases/${leaseId}/payment-links`, null, ownerACookie);
  assert.equal(list.status, 404, "Owner A must not be able to list Owner B's lease's links either");
});

test('the generated link opens the correct tenant\'s bill with a bare token and NO owner session at all', async () => {
  const { leaseId } = await createLeaseWithOutstandingBalance(ownerACookie);
  const link = await api('POST', `/api/leases/${leaseId}/payment-links`, {}, ownerACookie);

  // Deliberately no Cookie header — this is exactly what the tenant's browser
  // does after clicking the copied link.
  const portalRes = await fetch(`${baseUrl}/api/portal/${link.body.token}`);
  assert.equal(portalRes.status, 200);
  const portal = await portalRes.json();
  assert.equal(portal.lease.tenantName, 'Riley Tenant');
  assert.ok(portal.charges.some((c) => c.id));

  // A guessed/garbage token must not leak anything either.
  const bogus = await fetch(`${baseUrl}/api/portal/not-a-real-token-${Date.now()}`);
  assert.equal(bogus.status, 404);
});

test('revoking a link and then asking again mints a genuinely different token, not the revoked one', async () => {
  const { leaseId } = await createLeaseWithOutstandingBalance(ownerACookie);
  const first = await api('POST', `/api/leases/${leaseId}/payment-links`, {}, ownerACookie);
  const listBefore = await api('GET', `/api/leases/${leaseId}/payment-links`, null, ownerACookie);
  const linkId = listBefore.body.find((l) => l.token === first.body.token).id;

  const revoke = await api('POST', `/api/payment-links/${linkId}/revoke`, {}, ownerACookie);
  assert.equal(revoke.status, 200);

  const second = await api('POST', `/api/leases/${leaseId}/payment-links`, {}, ownerACookie);
  assert.equal(second.status, 201);
  assert.notEqual(second.body.token, first.body.token);

  // And the old, revoked link must stop working for the tenant too.
  const oldPortal = await fetch(`${baseUrl}/api/portal/${first.body.token}`);
  assert.equal(oldPortal.status, 410);
});

test('the history endpoint lists every link ever issued for a lease, each disclosing the provider honestly', async () => {
  const { leaseId } = await createLeaseWithOutstandingBalance(ownerACookie);
  await api('POST', `/api/leases/${leaseId}/payment-links`, {}, ownerACookie);
  const list = await api('GET', `/api/leases/${leaseId}/payment-links`, null, ownerACookie);
  assert.equal(list.status, 200);
  assert.ok(list.body.length >= 1);
  for (const link of list.body) {
    assert.ok(link.provider && link.provider.mode, 'every listed link must disclose whether it is live or simulated');
  }
});

test('when APP_BASE_URL is configured, a deployed app bakes that host into the link instead of localhost', async () => {
  const tmpFile2 = path.join(os.tmpdir(), `rental-app-paymentlinks-baseurl-test-${Date.now()}.db`);
  const db2 = openDatabase(tmpFile2);
  db2.prepare("INSERT INTO owners (name, email, password_hash) VALUES ('Owner C','plC@x.com','h')").run();
  const cookie2 = `session_token=${createSession(db2, 1)}`;

  const previous = process.env.APP_BASE_URL;
  process.env.APP_BASE_URL = 'https://myrentals.example.com';
  let server2, baseUrl2;
  try {
    const port2 = 47000 + Math.floor(Math.random() * 2000);
    const app2 = createApp({ db: db2, port: port2 });
    server2 = http.createServer((req, res) => {
      app2(req, res).catch((e) => { console.error(e); res.writeHead(500).end('{}'); });
    });
    await new Promise((resolve) => server2.listen(port2, resolve));
    baseUrl2 = `http://localhost:${port2}`;

    async function api2(method, urlPath, body) {
      const res = await fetch(`${baseUrl2}${urlPath}`, {
        method,
        headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), Cookie: cookie2 },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, body: await res.json() };
    }

    const property = await api2('POST', '/api/properties', { name: 'Deployed House', timezone: 'UTC' });
    const lease = await api2('POST', `/api/properties/${property.body.id}/leases`, { tenantName: 'Deployed Tenant', startDate: TODAY, rent: '1000.00' });
    const link = await api2('POST', `/api/leases/${lease.body.id}/payment-links`, {});
    assert.equal(link.status, 201);
    assert.equal(link.body.url, `https://myrentals.example.com/pay/link/${link.body.token}`);
    assert.ok(!link.body.url.includes('localhost'), 'a configured APP_BASE_URL must fully replace localhost, not just prefix it');
  } finally {
    if (previous === undefined) delete process.env.APP_BASE_URL; else process.env.APP_BASE_URL = previous;
    if (server2) await new Promise((resolve) => server2.close(resolve));
    db2.close();
  }
});

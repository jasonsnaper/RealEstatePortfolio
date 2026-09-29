// HTTP-level coverage for the owner-facing payment-statement routes
// (server/routes/statements.js): generating, listing, sharing, emailing and
// deleting a statement, plus cross-owner isolation. The renter-facing side
// (viewing statements shared with them) is covered in renterPortal.test.js;
// the pure PDF-content math (totals, refunds, immutability) is covered in
// statements.test.js. This file is the missing middle layer: did the owner
// actually reach that logic through the real HTTP routes with the right
// auth and 404 checks.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const http = require('http');

// Generating a statement writes a real PDF under UPLOADS_DIR, and booting
// the app touches DATA_DIR (it lazily creates a webhook-secret file there).
// Both are read once, at module-load time, by server/db.js — so these
// overrides MUST be set here, before the requires below pull that module
// in. See integration.test.js's own copy of this comment for the bug this
// avoids: without it, every run of this file wrote real statement PDFs
// straight into the project's REAL public/uploads directory.
process.env.UPLOADS_DIR = path.join(os.tmpdir(), `rental-app-statements-routes-test-uploads-${Date.now()}-${process.pid}`);
process.env.DATA_DIR = path.join(os.tmpdir(), `rental-app-statements-routes-test-datadir-${Date.now()}-${process.pid}`);

const { createApp } = require('../server/index');
const { openDatabase } = require('../server/db');
const { createSession } = require('../server/lib/helpers');
const { todayInTimezone } = require('../server/lib/dates');

let server, db, baseUrl;
let ownerCookie, otherOwnerCookie;

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

const TODAY = todayInTimezone('UTC');

before(async () => {
  const tmpFile = path.join(os.tmpdir(), `rental-app-statements-routes-test-${Date.now()}.db`);
  db = openDatabase(tmpFile);
  db.prepare("INSERT INTO owners (name, email, password_hash) VALUES ('Landlord','landlord@x.com','h')").run();
  db.prepare("INSERT INTO owners (name, email, password_hash) VALUES ('Other Landlord','other@x.com','h')").run();
  ownerCookie = `session_token=${createSession(db, 1)}`;
  otherOwnerCookie = `session_token=${createSession(db, 2)}`;

  const port = 47000 + Math.floor(Math.random() * 3000);
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

async function createActiveLease({ rent = '1500.00', startDate = TODAY, cookie = ownerCookie } = {}) {
  const property = await api('POST', '/api/properties', { name: `Statements Test House ${Math.random()}`, timezone: 'UTC' }, cookie);
  const lease = await api('POST', `/api/properties/${property.body.id}/leases`, {
    tenantName: 'Riley Tenant', tenantEmail: 'riley@example.com', startDate, rent,
  }, cookie);
  return { propertyId: property.body.id, leaseId: lease.body.id };
}

test('owner generates a lease_to_date statement and it is listed afterward', async () => {
  const { leaseId } = await createActiveLease();
  const gen = await api('POST', `/api/leases/${leaseId}/statements`, { rangeType: 'lease_to_date' }, ownerCookie);
  assert.equal(gen.status, 201);
  assert.equal(gen.body.rangeType, 'lease_to_date');
  assert.equal(gen.body.sharedWithRenter, false);

  const list = await api('GET', `/api/leases/${leaseId}/statements`, null, ownerCookie);
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].id, gen.body.id);
  assert.ok(list.body[0].url && list.body[0].url.includes('/uploads/properties/'), 'the owner-facing list should include a downloadable url, same as the renter-facing one does');

  const download = await fetch(`${baseUrl}${list.body[0].url}`); // no cookie forwarding needed here — fetch already carries none by default, confirming this isn't accidentally left open
  assert.equal(download.status, 401, 'the file route itself must still require an authenticated request');
});

test('a month statement uses the calendar month as its range regardless of today', async () => {
  const { leaseId } = await createActiveLease({ startDate: '2024-01-01' });
  const gen = await api('POST', `/api/leases/${leaseId}/statements`, { rangeType: 'month', month: '2024-02' }, ownerCookie);
  assert.equal(gen.status, 201);
  assert.equal(gen.body.rangeStart, '2024-02-01');
  assert.equal(gen.body.rangeEnd, '2024-02-29'); // 2024 is a leap year
});

test('generating a statement for another owner\'s lease is refused', async () => {
  const { leaseId } = await createActiveLease();
  const gen = await api('POST', `/api/leases/${leaseId}/statements`, { rangeType: 'lease_to_date' }, otherOwnerCookie);
  assert.equal(gen.status, 404);
});

test('share toggles whether a statement is visible to the renter, without emailing anything', async () => {
  const { leaseId } = await createActiveLease();
  const gen = await api('POST', `/api/leases/${leaseId}/statements`, { rangeType: 'lease_to_date' }, ownerCookie);

  const shared = await api('POST', `/api/statements/${gen.body.id}/share`, { shared: true }, ownerCookie);
  assert.equal(shared.status, 200);
  assert.equal(shared.body.sharedWithRenter, true);

  const unshared = await api('POST', `/api/statements/${gen.body.id}/share`, { shared: false }, ownerCookie);
  assert.equal(unshared.body.sharedWithRenter, false);
});

test('emailing a statement simulates sending, records who it was sent to, and auto-shares it', async () => {
  const { leaseId } = await createActiveLease();
  const gen = await api('POST', `/api/leases/${leaseId}/statements`, { rangeType: 'lease_to_date' }, ownerCookie);

  const emailed = await api('POST', `/api/statements/${gen.body.id}/email`, {}, ownerCookie);
  assert.equal(emailed.status, 200);
  assert.equal(emailed.body.simulated, true);
  assert.equal(emailed.body.to, 'riley@example.com'); // falls back to the lease's tenant_email
  assert.equal(emailed.body.statement.sharedWithRenter, true);
  assert.ok(emailed.body.statement.emailedAt);
});

test('deleting a statement removes it from the list', async () => {
  const { leaseId } = await createActiveLease();
  const gen = await api('POST', `/api/leases/${leaseId}/statements`, { rangeType: 'lease_to_date' }, ownerCookie);
  const del = await api('DELETE', `/api/statements/${gen.body.id}`, null, ownerCookie);
  assert.equal(del.status, 200);

  const list = await api('GET', `/api/leases/${leaseId}/statements`, null, ownerCookie);
  assert.equal(list.body.length, 0);
});

// --- Move-out auto-generates a closing statement (server/routes/leases.js's
// POST /api/leases/:id/end) so there's always at least one on file the
// moment a lease ends, without relying on the owner to remember to make one
// by hand from the Tenant & Lease tab. -----------------------------------
test('ending a lease auto-generates a closing statement, but does not share it with the renter', async () => {
  const { leaseId } = await createActiveLease({ startDate: '2025-01-01' });
  const beforeList = await api('GET', `/api/leases/${leaseId}/statements`, null, ownerCookie);
  assert.equal(beforeList.body.length, 0, 'sanity check: nothing generated yet');

  const endDate = '2025-08-15';
  const end = await api('POST', `/api/leases/${leaseId}/end`, { endDate, depositDisposition: 'Returned in full.' }, ownerCookie);
  assert.equal(end.status, 200);
  assert.ok(end.body.finalStatementId, 'the end-lease response should report the id of the statement it generated');

  const afterList = await api('GET', `/api/leases/${leaseId}/statements`, null, ownerCookie);
  assert.equal(afterList.body.length, 1, 'ending the lease should have generated exactly one statement');
  const statement = afterList.body[0];
  assert.equal(statement.id, end.body.finalStatementId);
  assert.equal(statement.rangeType, 'lease_to_date');
  assert.equal(statement.rangeStart, '2025-01-01');
  assert.equal(statement.rangeEnd, endDate);
  assert.equal(statement.sharedWithRenter, false, 'a closing statement should not be shared automatically — the owner reviews it first, same as any other statement');
});

test('correcting an already-ended lease\'s end date generates a fresh closing statement rather than erroring or replacing the old one', async () => {
  const { leaseId } = await createActiveLease({ startDate: '2025-01-01' });
  await api('POST', `/api/leases/${leaseId}/end`, { endDate: '2025-06-01' }, ownerCookie);
  const corrected = await api('POST', `/api/leases/${leaseId}/end`, { endDate: '2025-07-01' }, ownerCookie);
  assert.equal(corrected.status, 200);
  assert.ok(corrected.body.finalStatementId);

  const list = await api('GET', `/api/leases/${leaseId}/statements`, null, ownerCookie);
  assert.equal(list.body.length, 2, 'each end-lease call generates its own immutable snapshot (see db.js\'s payment_statements comment) rather than replacing the earlier one');
  const latest = list.body.find((s) => s.id === corrected.body.finalStatementId);
  assert.equal(latest.rangeEnd, '2025-07-01');
});

test('ending another owner\'s lease is refused and never generates a statement for it', async () => {
  const { leaseId } = await createActiveLease();
  const end = await api('POST', `/api/leases/${leaseId}/end`, { endDate: TODAY }, otherOwnerCookie);
  assert.equal(end.status, 404);
  const list = await api('GET', `/api/leases/${leaseId}/statements`, null, ownerCookie);
  assert.equal(list.body.length, 0);
});

// --- Regression: an ended lease's "to date" statement must stop at the
// lease's own end date, not at today. ----------------------------------
//
// ensureChargesGenerated backfills every elapsed monthly period for an
// ACTIVE lease up through today, including if the lease's start date is
// long in the past. If an owner later ends that lease with a backdated
// end date (recording a move-out that already happened), the charges
// table can already contain rows for periods after the real move-out —
// generated on some earlier day while the lease was still active, before
// the owner got around to recording when it actually ended. A "lease to
// date" statement must never present those post-move-out periods as part
// of the tenancy, so its range has to be clamped to end_date once the
// lease has ended.
test('a lease_to_date statement for an ended lease stops at the lease end date, not today', async () => {
  // Start the lease far enough in the past that ensureChargesGenerated
  // (triggered by creating it "today") backfills several months, some of
  // which will fall after the end date we set below.
  const twoYearsAgo = `${Number(TODAY.slice(0, 4)) - 2}-01-01`;
  const { leaseId } = await createActiveLease({ startDate: twoYearsAgo });

  const endedLastMonth = (() => {
    const [y, m] = TODAY.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1, 1));
    d.setUTCMonth(d.getUTCMonth() - 1);
    return d.toISOString().slice(0, 10);
  })();
  const end = await api('POST', `/api/leases/${leaseId}/end`, { endDate: endedLastMonth, depositDisposition: 'Returned in full.' }, ownerCookie);
  assert.equal(end.status, 200);

  // Charges for periods after the end date must still exist in the ledger
  // (this test isn't asserting anything about cleaning those up) — this
  // reproduces the exact scenario: charges exist past end_date because
  // they were generated before the lease was ended.
  const chargesAfterEnd = db.prepare('SELECT COUNT(*) AS n FROM charges WHERE lease_id = ? AND period_start > ?').get(leaseId, endedLastMonth);
  assert.ok(chargesAfterEnd.n > 0, 'test setup should have produced charges after the end date, or this test proves nothing');

  const gen = await api('POST', `/api/leases/${leaseId}/statements`, { rangeType: 'lease_to_date' }, ownerCookie);
  assert.equal(gen.status, 201);
  assert.equal(gen.body.rangeEnd, endedLastMonth, 'rangeEnd should be the lease\'s end date, not today');
  assert.ok(gen.body.rangeEnd < TODAY, 'sanity check: the end date used must actually be before today in this scenario');
});

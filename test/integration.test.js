const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// This file writes uploaded files (cover photos, documents) to disk, and
// booting the app touches DATA_DIR too (it lazily creates a webhook-secret
// file there). Both env vars are read once, at module-load time, by
// server/db.js — so these overrides MUST be set here, before the requires
// below pull that module in. Without this, every run of this test file
// resolved to the project's REAL public/uploads directory and wrote
// throwaway fixture files (a tiny PNG, a fake PDF/txt) straight into the
// real properties folders, colliding with the real seeded property IDs.
// Pointing both at a fresh temp dir keeps every test run fully isolated
// from the user's actual photos, documents, and data files. Every other
// test file that writes real files (statements.test.js,
// statementsRoutes.test.js, renterPortal.test.js) copies this same pattern
// at the top of the file, before its own requires — if you add a new test
// file that uploads anything or boots the app, it needs this too.
process.env.UPLOADS_DIR = path.join(os.tmpdir(), `rental-app-test-uploads-${Date.now()}-${process.pid}`);
process.env.DATA_DIR = path.join(os.tmpdir(), `rental-app-test-datadir-${Date.now()}-${process.pid}`);

const { createApp } = require('../server/index');
const { openDatabase, UPLOADS_DIR } = require('../server/db');

let server, db, baseUrl, port;
let cookie = '';

function withCookie(headers = {}) {
  return cookie ? { ...headers, Cookie: cookie } : headers;
}

async function api(method, urlPath, body) {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: withCookie(body ? { 'Content-Type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  let json = null;
  const text = await res.text();
  try { json = text ? JSON.parse(text) : null; } catch (e) { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}

before(async () => {
  const tmpFile = path.join(os.tmpdir(), `rental-app-test-${Date.now()}.db`);
  db = openDatabase(tmpFile);
  port = 41000 + Math.floor(Math.random() * 5000);
  const app = createApp({ db, port });
  server = require('http').createServer((req, res) => {
    app(req, res).catch((e) => { console.error(e); res.writeHead(500).end('{}'); });
  });
  await new Promise((resolve) => server.listen(port, resolve));
  baseUrl = `http://localhost:${port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
});

test('setup requires all fields and creates the owner account, then blocks a second setup', async () => {
  const bad = await api('POST', '/api/setup', { name: 'Jamie' });
  assert.equal(bad.status, 400);

  const ok = await api('POST', '/api/setup', { name: 'Jamie Owner', email: 'jamie@example.com', password: 'correcthorse123' });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.email, 'jamie@example.com');

  const second = await api('POST', '/api/setup', { name: 'Intruder', email: 'evil@example.com', password: 'whatever123' });
  assert.equal(second.status, 409);
});

test('login rejects wrong password with a generic error and accepts the right one', async () => {
  cookie = '';
  const wrong = await api('POST', '/api/login', { email: 'jamie@example.com', password: 'wrongpassword' });
  assert.equal(wrong.status, 401);
  const right = await api('POST', '/api/login', { email: 'jamie@example.com', password: 'correcthorse123' });
  assert.equal(right.status, 200);
});

let propertyId, leaseId;

test('creating a property persists it and it appears in the dashboard list', async () => {
  const created = await api('POST', '/api/properties', { name: '412 Birchwood Ave', city: 'Denver', state: 'CO', timezone: 'America/Denver' });
  assert.equal(created.status, 201);
  propertyId = created.body.id;
  assert.equal(created.body.occupancyStatus, 'vacant');

  const list = await api('GET', '/api/properties');
  assert.equal(list.status, 200);
  assert.ok(list.body.some((p) => p.id === propertyId));
});

test('editing a property updates it without losing its id/history', async () => {
  const updated = await api('PUT', `/api/properties/${propertyId}`, { name: '412 Birchwood Ave Unit A', city: 'Denver', state: 'CO' });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.name, '412 Birchwood Ave Unit A');
  assert.equal(updated.body.id, propertyId);
});

test('archiving a property removes it from the active list but keeps its data reachable', async () => {
  const arch = await api('POST', `/api/properties/${propertyId}/archive`);
  assert.equal(arch.status, 200);
  const activeList = await api('GET', '/api/properties');
  assert.ok(!activeList.body.some((p) => p.id === propertyId));
  const archivedList = await api('GET', '/api/properties?status=archived');
  assert.ok(archivedList.body.some((p) => p.id === propertyId));
  const single = await api('GET', `/api/properties/${propertyId}`);
  assert.equal(single.status, 200); // still fully readable, not deleted
  const unarch = await api('POST', `/api/properties/${propertyId}/unarchive`);
  assert.equal(unarch.status, 200);
});

test('replacing a cover photo stores a new file and updates the URL; old file is removed', async () => {
  const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const first = await api('POST', `/api/properties/${propertyId}/cover-photo`, { dataUrl: tinyPng });
  assert.equal(first.status, 200);
  assert.ok(first.body.coverPhotoUrl.includes(`/properties/${propertyId}/`));

  const propAfterFirst = await api('GET', `/api/properties/${propertyId}`);
  const firstFilename = propAfterFirst.body.coverPhotoUrl.split('/').pop();

  const second = await api('POST', `/api/properties/${propertyId}/cover-photo`, { dataUrl: tinyPng });
  assert.equal(second.status, 200);
  assert.notEqual(second.body.coverPhotoUrl, first.body.coverPhotoUrl);

  // UPLOADS_DIR comes from server/db.js, which resolves the isolated temp
  // directory set at the top of this file — NOT the real project's
  // public/uploads. Checking a hardcoded public/uploads path here would
  // pass vacuously (the file was never written there in the first place)
  // regardless of whether the deletion logic actually works.
  const uploadsDir = path.join(UPLOADS_DIR, 'properties', String(propertyId));
  assert.ok(!fs.existsSync(path.join(uploadsDir, firstFilename)), 'old cover photo file should have been deleted');
});

test('rejects a cover photo upload disguised with the wrong declared type', async () => {
  const fakeSvg = 'data:image/svg+xml;base64,' + Buffer.from('<svg onload="alert(1)"></svg>').toString('base64');
  const res = await api('POST', `/api/properties/${propertyId}/cover-photo`, { dataUrl: fakeSvg });
  assert.equal(res.status, 400);
});

test('creating a lease sets initial rent and generates the first charge', async () => {
  const created = await api('POST', `/api/properties/${propertyId}/leases`, {
    tenantName: 'Alex Rivera', tenantEmail: 'alex@example.com', startDate: '2026-01-01',
    rent: '1500.00', depositRequired: '1500', depositHeld: '1500', dueDay: 1, lateAfterDays: 5,
  });
  assert.equal(created.status, 201);
  leaseId = created.body.id;
  assert.equal(created.body.currentRentCents, 150000);
  assert.ok(created.body.charges.length >= 1);
});

test('a second active lease on the same property is rejected until the first ends', async () => {
  const dup = await api('POST', `/api/properties/${propertyId}/leases`, { tenantName: 'Someone Else', startDate: '2026-01-01', rent: '1000' });
  assert.equal(dup.status, 409);
});

test('changing future rent does not alter the amount already charged for past periods', async () => {
  const before = await api('GET', `/api/leases/${leaseId}`);
  const firstChargeAmount = before.body.charges.find((c) => c.periodStart === '2026-01-01').amountCents;
  assert.equal(firstChargeAmount, 150000);

  const changed = await api('POST', `/api/leases/${leaseId}/rent-change`, { rent: '1650', effectiveDate: '2099-01-01' });
  assert.equal(changed.status, 200);
  const stillOld = changed.body.charges.find((c) => c.periodStart === '2026-01-01');
  assert.equal(stillOld.amountCents, 150000, 'January charge must be unaffected by a rent change effective decades later');
});

let firstChargeId;

test('recording a partial payment reduces the balance, and a second payment completes it to paid', async () => {
  const lease = await api('GET', `/api/leases/${leaseId}`);
  const charge = lease.body.charges.find((c) => c.periodStart === '2026-01-01');
  firstChargeId = charge.id;

  // Note: this charge's due/late dates are in January 2026, and wall-clock
  // "today" during a real test run is well past that — so its status word
  // reads "late" rather than "due"/"partial" the moment any balance remains.
  // That specific due/partial/late labeling is exhaustively covered against
  // controlled dates in test/unit.test.js; here we only need to confirm the
  // real HTTP+DB stack computes and persists the right AMOUNTS.
  const partial = await api('POST', `/api/charges/${firstChargeId}/payments`, { amount: '500', method: 'check', paidAt: '2026-01-02' });
  assert.equal(partial.status, 201);
  assert.notEqual(partial.body.status, 'paid');
  assert.equal(partial.body.paidCents, 50000);
  assert.equal(partial.body.outstandingCents, 100000);

  const complete = await api('POST', `/api/charges/${firstChargeId}/payments`, { amount: '1000', method: 'check', paidAt: '2026-01-03' });
  assert.equal(complete.status, 201);
  assert.equal(complete.body.status, 'paid'); // date-independent: outstanding<=0 always reads as paid
  assert.equal(complete.body.outstandingCents, 0);
});

test('a manually recorded rent payment is mirrored into the transactions ledger exactly once', async () => {
  const txns = await api('GET', `/api/properties/${propertyId}/transactions`);
  const rentTxns = txns.body.filter((t) => t.type === 'rent_payment');
  assert.equal(rentTxns.length, 2); // the $500 + the $1000 from the previous test
});

test('recording a refund reopens the balance on an already-paid charge', async () => {
  const refund = await api('POST', `/api/charges/${firstChargeId}/payments`, { amount: '1500', type: 'refund', paidAt: '2026-01-10' });
  assert.equal(refund.status, 201);
  assert.notEqual(refund.body.status, 'paid');
  assert.equal(refund.body.outstandingCents, 150000);
  // put it back to paid for the rest of the suite
  const repay = await api('POST', `/api/charges/${firstChargeId}/payments`, { amount: '1500', paidAt: '2026-01-11' });
  assert.equal(repay.body.status, 'paid');
});

test('ending a lease preserves it as historical rather than deleting it', async () => {
  const secondProperty = await api('POST', '/api/properties', { name: 'History Test House' });
  const pid = secondProperty.body.id;
  const l = await api('POST', `/api/properties/${pid}/leases`, { tenantName: 'Old Tenant', startDate: '2025-01-01', rent: '900' });
  const ended = await api('POST', `/api/leases/${l.body.id}/end`, { endDate: '2025-06-01', depositDisposition: 'Returned in full' });
  assert.equal(ended.status, 200);

  const historyList = await api('GET', `/api/properties/${pid}/leases?status=ended`);
  assert.equal(historyList.body.length, 1);
  assert.equal(historyList.body[0].tenantName, 'Old Tenant');
  assert.equal(historyList.body[0].depositDisposition, 'Returned in full');
  // the lease's own charges/payments are untouched, still queryable
  const stillThere = await api('GET', `/api/leases/${l.body.id}`);
  assert.equal(stillThere.status, 200);
});

// ensureChargesGenerated backfills every elapsed monthly period for an
// ACTIVE lease up through today, even when its start date is long in the
// past. Creating a lease that started two years ago therefore generates
// ~24 months of charges immediately, all dated well after any backdated
// end date we then set — reproducing exactly what happens in practice when
// an owner records a move-out sometime after it actually occurred.
test('an ended lease\'s charges list excludes periods after its end date, even though they were already generated', async () => {
  const property = await api('POST', '/api/properties', { name: 'Backdated Move-Out House' });
  const twoYearsAgo = `${new Date().getUTCFullYear() - 2}-01-01`;
  const l = await api('POST', `/api/properties/${property.body.id}/leases`, { tenantName: 'Departed Tenant', startDate: twoYearsAgo, rent: '1200' });
  assert.ok(l.body.charges.length > 12, 'test setup should have backfilled well over a year of charges');

  const endedSixMonthsAgo = (() => {
    const d = new Date();
    d.setUTCMonth(d.getUTCMonth() - 6, 1);
    return d.toISOString().slice(0, 10);
  })();
  const ended = await api('POST', `/api/leases/${l.body.id}/end`, { endDate: endedSixMonthsAgo, depositDisposition: 'Returned in full' });
  assert.equal(ended.status, 200);

  const after = await api('GET', `/api/leases/${l.body.id}`);
  assert.equal(after.status, 200);
  assert.ok(after.body.charges.length > 0, 'charges up through the end date should still be there');
  for (const c of after.body.charges) {
    assert.ok(c.periodStart <= endedSixMonthsAgo, `charge for period ${c.periodStart} is after the lease's end date ${endedSixMonthsAgo} and should not be shown`);
  }
});

test('a bank account shared across two properties is not double-counted in portfolio cash held', async () => {
  const propB = await api('POST', '/api/properties', { name: 'Shared-Account House' });
  const account = await api('POST', '/api/bank-accounts', {
    nickname: 'Joint Checking', balance: '10000', asOf: '2026-01-01', propertyIds: [propertyId, propB.body.id],
  });
  assert.equal(account.status, 201);
  assert.equal(account.body.isShared, true);

  const portfolio = await api('GET', '/api/portfolio');
  assert.equal(portfolio.status, 200);
  assert.equal(portfolio.body.cashHeldCents, 1000000, 'shared $10,000 balance must be counted once, not once per linked property');
});

test('a document with no lease share is invisible to the tenant portal; one shared with the lease is visible', async () => {
  // Sharing is now explicit and lease/renter-scoped (document_shares), not a
  // single is_shared_with_tenant boolean — see server/routes/documents.js and
  // db.js's document_shares comment. shareWithLeaseIds at upload time is the
  // one-step "share with this lease right away" path.
  const privateDoc = await api('POST', `/api/properties/${propertyId}/documents`, {
    dataUrl: 'data:text/plain;base64,' + Buffer.from('private owner notes').toString('base64'),
    filename: 'owner-notes.txt', category: 'other',
  });
  assert.equal(privateDoc.status, 201);
  assert.deepEqual(privateDoc.body.shares, [], 'a document uploaded with no shareWithLeaseIds must start with no shares at all');
  const sharedDoc = await api('POST', `/api/properties/${propertyId}/documents`, {
    dataUrl: 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4 fake').toString('base64'),
    filename: 'lease.pdf', category: 'lease', shareWithLeaseIds: [leaseId],
  });
  assert.equal(sharedDoc.status, 201);
  assert.equal(sharedDoc.body.isSharedWithTenant, true, 'the legacy boolean should stay in sync for anything still reading it directly');

  const link = await api('POST', `/api/leases/${leaseId}/payment-links`);
  assert.equal(link.status, 201);
  const token = link.body.token;

  const portalDocs = await api('GET', `/api/portal/${token}/documents`);
  assert.equal(portalDocs.status, 200);
  assert.equal(portalDocs.body.length, 1);
  assert.equal(portalDocs.body[0].filename, 'lease.pdf');
});

test('the tenant portal payload never contains owner-only fields (bank/mortgage/private notes)', async () => {
  await api('PUT', `/api/leases/${leaseId}`, { ownerNotes: 'SECRET: tenant pays late every month, do not renew' });
  const lease = await api('GET', `/api/leases/${leaseId}`);
  const link = await api('POST', `/api/leases/${leaseId}/payment-links`);
  const token = link.body.token;

  const portal = await api('GET', `/api/portal/${token}`);
  assert.equal(portal.status, 200);
  const raw = JSON.stringify(portal.body);
  assert.ok(!raw.includes('SECRET'), 'owner notes must never reach the tenant portal');
  assert.ok(!('bankAccounts' in portal.body), 'bank account data must never reach the tenant portal');
  assert.ok(!('ownerNotes' in portal.body.lease), 'ownerNotes key must not exist in the tenant-facing lease object at all');
  assert.equal(lease.body.ownerNotes.includes('SECRET'), true); // confirm it really was saved, just not leaked
});

test('an invalid payment-link token is rejected, and a revoked one stops working', async () => {
  const bogus = await api('GET', '/api/portal/not-a-real-token');
  assert.equal(bogus.status, 404);

  const link = await api('POST', `/api/leases/${leaseId}/payment-links`);
  const links = await api('GET', `/api/leases/${leaseId}/payment-links`);
  const linkId = links.body.find((l) => l.token === link.body.token).id;
  const revoke = await api('POST', `/api/payment-links/${linkId}/revoke`);
  assert.equal(revoke.status, 200);
  const afterRevoke = await api('GET', `/api/portal/${link.body.token}`);
  assert.equal(afterRevoke.status, 410);
});

let checkoutSession, activeToken;

test('tenant checkout creates a payment session with a disclosed fee before confirmation', async () => {
  // First bring the current charge's balance back to something outstanding.
  const leaseNow = await api('GET', `/api/leases/${leaseId}`);
  const openCharge = leaseNow.body.charges.find((c) => c.status !== 'paid');
  assert.ok(openCharge, 'expected an outstanding charge to exist for checkout tests');

  const link = await api('POST', `/api/leases/${leaseId}/payment-links`);
  activeToken = link.body.token;
  const checkout = await api('POST', `/api/portal/${activeToken}/checkout`, {});
  assert.equal(checkout.status, 201);
  assert.ok(checkout.body.feeCents > 0);
  assert.equal(checkout.body.totalCents, checkout.body.amountCents + checkout.body.feeCents);
  checkoutSession = checkout.body;
});

test('checkout rejects an amount above the outstanding balance', async () => {
  const res = await api('POST', `/api/portal/${activeToken}/checkout`, { amount: '999999' });
  assert.equal(res.status, 400);
});

test('a webhook with a bad signature is rejected and does not change session status', async () => {
  const rawBody = JSON.stringify({ id: 'evt_fake', type: 'payment_intent.succeeded', data: { sessionId: checkoutSession.sessionId } });
  const res = await fetch(`${baseUrl}/api/webhooks/mock-provider`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-webhook-signature': 'deadbeef'.repeat(8) }, body: rawBody,
  });
  assert.equal(res.status, 400);
  const status = await api('GET', `/api/mock-checkout/${checkoutSession.sessionId}/status`);
  assert.equal(status.body.status, 'created');
});

test('simulating a successful payment marks the charge paid via the webhook, not the browser', async () => {
  const sim = await api('POST', `/api/mock-checkout/${checkoutSession.sessionId}/simulate`, { outcome: 'success' });
  assert.equal(sim.status, 200);

  // Give the loopback webhook HTTP call a moment to land.
  await new Promise((r) => setTimeout(r, 300));

  const status = await api('GET', `/api/mock-checkout/${checkoutSession.sessionId}/status`);
  assert.equal(status.body.status, 'succeeded');

  const portal = await api('GET', `/api/portal/${activeToken}`);
  const paidCharge = portal.body.charges.find((c) => c.id === checkoutSession.chargeId || c.outstandingCents === 0);
  assert.ok(portal.body.charges.some((c) => c.status === 'paid'));
});

test('redelivering the exact same webhook event id a second time is a no-op (no duplicate payment)', async () => {
  const { signPayload, getMockWebhookSecret } = require('../server/lib/paymentProvider');
  const event = { id: 'evt_replay_test_001', type: 'payment_intent.succeeded', data: { sessionId: checkoutSession.sessionId } };
  const rawBody = JSON.stringify(event);
  const signature = signPayload(rawBody, getMockWebhookSecret());

  const first = await fetch(`${baseUrl}/api/webhooks/mock-provider`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-webhook-signature': signature }, body: rawBody,
  });
  assert.equal(first.status, 200);
  const second = await fetch(`${baseUrl}/api/webhooks/mock-provider`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-webhook-signature': signature }, body: rawBody,
  });
  const secondBody = await second.json();
  assert.equal(second.status, 200);
  assert.equal(secondBody.duplicate, true);

  const paymentsForCharge = await api('GET', `/api/leases/${leaseId}`);
  const charge = paymentsForCharge.body.charges.find((c) => c.id === checkoutSession.chargeId);
  // Only ever one payment recorded for this session's charge from this event stream,
  // regardless of how many times the identical event was delivered.
  const cardPayments = charge ? charge.payments.filter((p) => p.method === 'card') : [];
  assert.ok(cardPayments.length <= 1);
});

test('a declined simulated payment marks the session failed without creating a payment', async () => {
  // Dedicated property/lease so this test's outcome never depends on which
  // charges earlier tests happened to already pay off.
  const prop = await api('POST', '/api/properties', { name: 'Decline Flow Test House' });
  const lease = await api('POST', `/api/properties/${prop.body.id}/leases`, { tenantName: 'Decline Tester', startDate: '2026-01-01', rent: '1200' });
  const link = await api('POST', `/api/leases/${lease.body.id}/payment-links`);
  assert.equal(link.status, 201);
  const checkout = await api('POST', `/api/portal/${link.body.token}/checkout`, {});
  assert.equal(checkout.status, 201);

  await api('POST', `/api/mock-checkout/${checkout.body.sessionId}/simulate`, { outcome: 'fail' });
  await new Promise((r) => setTimeout(r, 200));
  const status = await api('GET', `/api/mock-checkout/${checkout.body.sessionId}/status`);
  assert.equal(status.body.status, 'failed');

  const leaseAfter = await api('GET', `/api/leases/${lease.body.id}`);
  const chargeAfter = leaseAfter.body.charges.find((c) => c.id === checkout.body.chargeId) || leaseAfter.body.charges[0];
  assert.equal(chargeAfter.paidCents, 0, 'a declined payment must never create a payment record');
});

test('bank transaction import skips a transaction it has already imported (duplicate ext id)', async () => {
  const propC = await api('POST', '/api/properties', { name: 'Import Test House' });
  const pid = propC.body.id;
  const first = await api('POST', `/api/properties/${pid}/transactions/import`, {
    transactions: [{ extId: 'bank-txn-001', amount: '-45.00', date: '2026-02-01', description: 'Hardware store' }],
  });
  assert.equal(first.body.imported, 1);
  const second = await api('POST', `/api/properties/${pid}/transactions/import`, {
    transactions: [{ extId: 'bank-txn-001', amount: '-45.00', date: '2026-02-01', description: 'Hardware store (redelivered)' }],
  });
  assert.equal(second.body.imported, 0);
  assert.equal(second.body.skippedDuplicates, 1);

  const txns = await api('GET', `/api/properties/${pid}/transactions`);
  assert.equal(txns.body.filter((t) => t.bankTransactionExtId === 'bank-txn-001').length, 1);
});

test('bank import matches an already-manually-recorded transaction instead of creating a second one', async () => {
  const propD = await api('POST', '/api/properties', { name: 'Reconcile Test House' });
  const pid = propD.body.id;
  await api('POST', `/api/properties/${pid}/transactions`, { type: 'expense', amount: '120.00', date: '2026-03-05', direction: 'out', category: 'Repairs' });
  const imported = await api('POST', `/api/properties/${pid}/transactions/import`, {
    transactions: [{ extId: 'bank-txn-777', amount: '-120.00', date: '2026-03-05', description: 'Bank feed: hardware' }],
  });
  assert.equal(imported.body.imported, 0);
  assert.equal(imported.body.details[0].outcome, 'matched_existing');
  const txns = await api('GET', `/api/properties/${pid}/transactions`);
  assert.equal(txns.body.length, 1, 'must still be exactly one transaction, not two');
});

test('tenant can submit a maintenance request through the portal, and the owner sees it', async () => {
  const submit = await api('POST', `/api/portal/${activeToken}/maintenance`, { title: 'Leaky faucet', description: 'Kitchen sink drips constantly' });
  assert.equal(submit.status, 201);
  const ownerView = await api('GET', `/api/properties/${propertyId}/maintenance`);
  assert.ok(ownerView.body.some((m) => m.title === 'Leaky faucet' && m.createdBy === 'tenant'));
});

test('tenant-visible maintenance list never includes vendor or cost fields', async () => {
  await api('POST', `/api/properties/${propertyId}/maintenance`, {
    title: 'Roof inspection', assignedVendor: 'Ace Roofing Co', estimatedCost: '450',
  });
  const portalMaint = await api('GET', `/api/portal/${activeToken}/maintenance`);
  assert.equal(portalMaint.status, 200);
  const raw = JSON.stringify(portalMaint.body);
  assert.ok(!raw.includes('Ace Roofing'), 'vendor name must not leak to the tenant');
  assert.ok(!raw.includes('assignedVendor'));
  assert.ok(!raw.includes('estimatedCostCents'));
});

test('CSV export endpoints respond with CSV content', async () => {
  const res = await fetch(`${baseUrl}/api/properties/${propertyId}/transactions/export.csv`, { headers: withCookie() });
  assert.equal(res.status, 200);
  assert.ok(res.headers.get('content-type').includes('text/csv'));
  const text = await res.text();
  assert.ok(text.startsWith('Date,Type,Direction,Amount'));
});

test('unauthenticated requests to owner endpoints are rejected', async () => {
  const savedCookie = cookie;
  cookie = '';
  const res = await api('GET', '/api/properties');
  assert.equal(res.status, 401);
  cookie = savedCookie;
});

test('a property belonging to a different owner is not reachable (cross-owner isolation)', async () => {
  // /api/setup deliberately refuses to create a second owner account once one
  // exists (single-owner-per-install, matching the spec's V1 scope) — that's
  // the correct behavior, not something to route around via the API. To
  // exercise the underlying per-owner isolation that every property/lease/
  // financial route already enforces (and that a future multi-owner/team
  // feature would build directly on), insert a second owner row and a valid
  // session for them straight into the database, the way a real second
  // install's owner row would look.
  const { hashPassword } = require('../server/lib/auth');
  const crypto = require('crypto');
  const insert = db.prepare('INSERT INTO owners (name, email, password_hash) VALUES (?, ?, ?)').run('Other Owner', 'other@example.com', hashPassword('differentpass123'));
  const otherToken = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 19);
  db.prepare('INSERT INTO sessions (token, owner_id, expires_at) VALUES (?, ?, ?)').run(otherToken, insert.lastInsertRowid, expires);

  const savedCookie = cookie;
  cookie = `session_token=${otherToken}`;
  const res = await api('GET', `/api/properties/${propertyId}`); // Jamie's property, while authenticated as Other Owner
  assert.equal(res.status, 404);
  const list = await api('GET', '/api/properties');
  assert.equal(list.body.length, 0, "other owner's property list must not include Jamie's properties");
  cookie = savedCookie;
});

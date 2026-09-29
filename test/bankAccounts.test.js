const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');

// This file boots the real app (createApp, below), which is enough to
// touch DATA_DIR (it lazily creates a webhook-secret file there) even
// though this file's own tests don't upload anything. Both env vars are
// read once, at module-load time, by server/db.js — so these overrides
// MUST be set here, before the requires below pull that module in. See
// integration.test.js's own copy of this comment for the bug this class of
// omission causes elsewhere in this suite.
process.env.UPLOADS_DIR = path.join(os.tmpdir(), `rental-app-bankaccounts-test-uploads-${Date.now()}-${process.pid}`);
process.env.DATA_DIR = path.join(os.tmpdir(), `rental-app-bankaccounts-test-datadir-${Date.now()}-${process.pid}`);

const { createApp } = require('../server/index');
const { openDatabase } = require('../server/db');
const { createSession } = require('../server/lib/helpers');

// This app's own /api/setup only ever allows ONE owner per install (see
// routes/auth.js), so a second owner never arises from the normal product
// flow. The ownership checks scattered through every bank-account route
// (getOwnedPropertyOr404, `WHERE owner_id = ?`) are still real guards worth
// verifying directly, though, so this seeds a second owner straight into the
// database and mints them a session token the same way createSession()
// always does — bypassing the single-owner HTTP restriction on purpose, only
// to exercise the ownership check itself.
let server, db, baseUrl;
let ownerACookie, ownerBCookie;
let propA, propB, ownerBPropertyId;

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

before(async () => {
  const tmpFile = path.join(os.tmpdir(), `rental-app-bank-test-${Date.now()}.db`);
  db = openDatabase(tmpFile);

  db.prepare("INSERT INTO owners (name, email, password_hash) VALUES ('Owner A','a@x.com','h')").run();
  db.prepare("INSERT INTO owners (name, email, password_hash) VALUES ('Owner B','b@x.com','h')").run();
  db.prepare("INSERT INTO properties (owner_id, name, status) VALUES (1,'A - Prop One','active')").run();
  db.prepare("INSERT INTO properties (owner_id, name, status) VALUES (1,'A - Prop Two','active')").run();
  db.prepare("INSERT INTO properties (owner_id, name, status) VALUES (2,'B - Prop One','active')").run();
  propA = 1; propB = 2; ownerBPropertyId = 3;

  ownerACookie = `session_token=${createSession(db, 1)}`;
  ownerBCookie = `session_token=${createSession(db, 2)}`;

  const port = 42000 + Math.floor(Math.random() * 3000);
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

let sharedAccountId;

test('creating a manual account and linking it to two properties at once makes it "shared"', async () => {
  const created = await api('POST', '/api/bank-accounts', { nickname: 'Shared Checking', balance: '5000.00', asOf: '2026-09-01', propertyIds: [propA, propB] }, ownerACookie);
  assert.equal(created.status, 201);
  sharedAccountId = created.body.id;
  assert.equal(created.body.mode, 'manual');
  assert.equal(created.body.balanceCents, 500000);
  assert.equal(created.body.isShared, true);
  assert.equal(created.body.linkedProperties.length, 2);
});

test('the property page shows ALL linked accounts, not just the first one', async () => {
  const second = await api('POST', '/api/bank-accounts', { nickname: 'Second Account On A', balance: '100.00', propertyIds: [propA] }, ownerACookie);
  assert.equal(second.status, 201);

  const property = await api('GET', `/api/properties/${propA}`, null, ownerACookie);
  assert.equal(property.status, 200);
  assert.equal(property.body.bankAccounts.length, 2, 'both accounts linked to this property must be returned, not just bankAccounts[0]');
  const nicknames = property.body.bankAccounts.map((a) => a.nickname).sort();
  assert.deepEqual(nicknames, ['Second Account On A', 'Shared Checking']);
});

test('editing a manual account updates its balance and keeps its assignments unless told to change them', async () => {
  const updated = await api('PUT', `/api/bank-accounts/${sharedAccountId}`, { balance: '6000.00' }, ownerACookie);
  assert.equal(updated.status, 200);
  assert.equal(updated.body.balanceCents, 600000);
  assert.equal(updated.body.linkedProperties.length, 2, 'omitting propertyIds must leave existing links untouched');
});

test('unlinking from one property keeps the account and its other link intact', async () => {
  const unlinked = await api('DELETE', `/api/properties/${propB}/bank-accounts/${sharedAccountId}`, null, ownerACookie);
  assert.equal(unlinked.status, 200);

  const propBAfter = await api('GET', `/api/properties/${propB}`, null, ownerACookie);
  assert.ok(!propBAfter.body.bankAccounts.some((a) => a.id === sharedAccountId), 'account must no longer show on property B');

  const propAAfter = await api('GET', `/api/properties/${propA}`, null, ownerACookie);
  assert.ok(propAAfter.body.bankAccounts.some((a) => a.id === sharedAccountId), 'account must still be linked to property A');

  const accountList = await api('GET', '/api/bank-accounts', null, ownerACookie);
  assert.ok(accountList.body.some((a) => a.id === sharedAccountId), 'the account itself must still exist, not be deleted');
});

test('reassigning a bank account to a property the owner does not own is rejected, and does not partially apply', async () => {
  const beforeList = await api('GET', '/api/bank-accounts', null, ownerACookie);
  const beforeLinks = beforeList.body.find((a) => a.id === sharedAccountId).linkedProperties.map((p) => p.id).sort();

  // ownerBPropertyId belongs to Owner B, not Owner A — mixed in with a
  // legitimately-owned id so a naive implementation might apply the first
  // and choke on the second, leaving a partial reassignment behind.
  const attempt = await api('PUT', `/api/bank-accounts/${sharedAccountId}`, { propertyIds: [propA, ownerBPropertyId] }, ownerACookie);
  assert.equal(attempt.status, 404);

  const afterList = await api('GET', '/api/bank-accounts', null, ownerACookie);
  const afterLinks = afterList.body.find((a) => a.id === sharedAccountId).linkedProperties.map((p) => p.id).sort();
  assert.deepEqual(afterLinks, beforeLinks, 'a rejected reassignment must leave the account’s existing links completely unchanged, not half-applied');
});

test('an owner cannot link, edit, or unlink another owner\'s bank account or property', async () => {
  const linkAttempt = await api('POST', `/api/properties/${ownerBPropertyId}/bank-accounts/link`, { bankAccountId: sharedAccountId }, ownerACookie);
  assert.equal(linkAttempt.status, 404, 'Owner A must not be able to link their account to Owner B\'s property');

  const ownerBAccount = await api('POST', '/api/bank-accounts', { nickname: "B's account", balance: '10.00', propertyIds: [ownerBPropertyId] }, ownerBCookie);
  assert.equal(ownerBAccount.status, 201);

  const crossEdit = await api('PUT', `/api/bank-accounts/${ownerBAccount.body.id}`, { nickname: 'Hijacked' }, ownerACookie);
  assert.equal(crossEdit.status, 404, 'Owner A must not be able to edit Owner B\'s account');

  const crossUnlink = await api('DELETE', `/api/properties/${ownerBPropertyId}/bank-accounts/${ownerBAccount.body.id}`, null, ownerACookie);
  assert.equal(crossUnlink.status, 404, 'Owner A must not be able to unlink using Owner B\'s property id either');

  const crossDelete = await api('DELETE', `/api/bank-accounts/${ownerBAccount.body.id}`, null, ownerACookie);
  assert.equal(crossDelete.status, 404, 'Owner A must not be able to delete Owner B\'s account');

  const stillThere = await api('GET', '/api/bank-accounts', null, ownerBCookie);
  assert.ok(stillThere.body.some((a) => a.id === ownerBAccount.body.id), "Owner B's account must be untouched by Owner A's attempts");
});

test('a shared bank account is counted once (not once per property) in portfolio cash totals', async () => {
  const portfolio = await api('GET', '/api/portfolio', null, ownerACookie);
  // Re-link property B so it's shared again for this check.
  await api('POST', `/api/properties/${propB}/bank-accounts/link`, { bankAccountId: sharedAccountId }, ownerACookie);
  const portfolioAfterReshare = await api('GET', '/api/portfolio', null, ownerACookie);
  assert.equal(portfolioAfterReshare.body.cashHeldCents, portfolio.body.cashHeldCents, 're-sharing the SAME account across a second property must not change the total (no double count)');
});

test('deleting an account entirely removes it from every property it was linked to', async () => {
  const del = await api('DELETE', `/api/bank-accounts/${sharedAccountId}`, null, ownerACookie);
  assert.equal(del.status, 200);
  const propA2 = await api('GET', `/api/properties/${propA}`, null, ownerACookie);
  const propB2 = await api('GET', `/api/properties/${propB}`, null, ownerACookie);
  assert.ok(!propA2.body.bankAccounts.some((a) => a.id === sharedAccountId));
  assert.ok(!propB2.body.bankAccounts.some((a) => a.id === sharedAccountId));
});

test('bank-connections provider-status reports "unconfigured" when no Plaid credentials are set, and never fakes a live connection', async () => {
  delete process.env.PLAID_CLIENT_ID;
  delete process.env.PLAID_SECRET;
  const status = await api('GET', '/api/bank-connections/provider-status', null, ownerACookie);
  assert.equal(status.status, 200);
  assert.equal(status.body.mode, 'unconfigured');
  assert.ok(status.body.notice, 'must explain why, not just say no');

  const linkToken = await api('POST', '/api/bank-connections/link-token', {}, ownerACookie);
  assert.equal(linkToken.status, 503, 'creating a real Link token with no credentials configured must fail loudly, never return a fake token');
});

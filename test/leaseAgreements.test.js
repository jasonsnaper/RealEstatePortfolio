// End-to-end coverage for the renter-invitation + lease-preparation +
// e-signing workflow: generic (lease-less) invitations and the "Unassigned
// Renters" list (server/routes/renterManagement.js's /api/renters/invite,
// /unassigned, /:renterId/assign), lease templates
// (server/routes/leaseTemplates.js), and the full lease-agreement lifecycle
// (server/routes/leaseAgreements.js + server/lib/leaseAgreements.js) —
// draft -> finalize -> landlord signs & sends -> renter(s) sign/decline/
// request changes -> completed PDF + audit trail -> lease/billing sync.
//
// This exercises the same behaviors as this repo's own scratch smoke test
// (scratchpad/smoke-lease-agreements.js, lib-level only, not committed) but
// at the HTTP layer, following test/renterPortal.test.js's conventions, so
// it's part of the permanent, CI-visible suite.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const http = require('http');

// MUST be set before requiring server/db or server/index — see
// renterPortal.test.js's identical comment for the bug this avoids (writing
// real files into the project's actual public/uploads directory).
process.env.UPLOADS_DIR = path.join(os.tmpdir(), `rental-app-leaseagreements-test-uploads-${Date.now()}-${process.pid}`);
process.env.DATA_DIR = path.join(os.tmpdir(), `rental-app-leaseagreements-test-datadir-${Date.now()}-${process.pid}`);

const { createApp } = require('../server/index');
const { openDatabase } = require('../server/db');
const { createSession } = require('../server/lib/helpers');
const { todayInTimezone } = require('../server/lib/dates');

let server, db, baseUrl;
let ownerCookie;

async function api(method, urlPath, body, cookie) {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    // Truthy check (not `!== undefined`): callers pass `null` explicitly for
    // every GET's unused body param, and undici refuses a GET/HEAD request
    // that has ANY body -- including the string "null" that
    // JSON.stringify(null) would produce if this checked for undefined only.
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { json = text; }
  return { status: res.status, body: json, cookie: setCookie ? setCookie.split(';')[0] : null };
}

/** For binary responses (PDFs) — api() above assumes JSON/text. */
async function rawGet(urlPath, cookie) {
  const res = await fetch(`${baseUrl}${urlPath}`, { headers: cookie ? { Cookie: cookie } : {} });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, contentType: res.headers.get('content-type'), buffer: buf };
}

function tokenFromInviteUrl(url) {
  return url.split('/').pop();
}

const TODAY = todayInTimezone('UTC');
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

before(async () => {
  const tmpFile = path.join(os.tmpdir(), `rental-app-leaseagreements-test-${Date.now()}.db`);
  db = openDatabase(tmpFile);
  db.prepare("INSERT INTO owners (name, email, password_hash) VALUES ('Pat Owner','pat@example.com','h')").run();
  ownerCookie = `session_token=${createSession(db, 1)}`;

  const port = 48000 + Math.floor(Math.random() * 3000);
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

async function createProperty(name) {
  const res = await api('POST', '/api/properties', { name: name || `Test House ${Math.random()}`, timezone: 'UTC' }, ownerCookie);
  assert.equal(res.status, 201);
  return res.body;
}

/** Full happy-path fixture: invite a renter, accept, assign to a fresh property -> draft lease. */
async function inviteAndAssign({ email, name = 'Riley Renter', startDate = TODAY } = {}) {
  email = email || `riley-${Math.random().toString(36).slice(2)}@example.com`;
  const invite = await api('POST', '/api/renters/invite', { name, email }, ownerCookie);
  assert.equal(invite.status, 201);
  const token = tokenFromInviteUrl(invite.body.url);
  const accept = await api('POST', '/api/renter/accept-invite', { token, password: 'renterpass123' });
  assert.equal(accept.status, 200);
  assert.equal(accept.body.leaseId, null, 'a generic invite links no lease on accept');
  const renterCookie = accept.cookie;
  const renterId = invite.body.renter.id;

  const property = await createProperty();
  const assign = await api('POST', `/api/renters/${renterId}/assign`, { propertyId: property.id, startDate }, ownerCookie);
  assert.equal(assign.status, 201);
  assert.equal(assign.body.status, 'draft');
  return { property, lease: assign.body, renterId, renterCookie, email };
}

const COMPLETE_FIELDS = {
  landlordName: 'Pat Owner', landlordContact: 'pat@example.com', propertyAddress: '1 Main St',
  monthlyRent: '1500', securityDeposit: '1500', leaseStartDate: TODAY, monthToMonth: true,
  rentDueDay: 1, gracePeriod: '5-day grace period.', utilitiesResponsibilities: 'Tenant pays all utilities.',
};

async function prepareAndFinalize(leaseId, fieldOverrides) {
  const draft = await api('POST', `/api/leases/${leaseId}/agreements`, {}, ownerCookie);
  assert.equal(draft.status, 201);
  const put = await api('PUT', `/api/lease-agreements/${draft.body.id}`, { fields: { ...COMPLETE_FIELDS, ...(fieldOverrides || {}) } }, ownerCookie);
  assert.equal(put.status, 200);
  const finalize = await api('POST', `/api/lease-agreements/${draft.body.id}/finalize`, {}, ownerCookie);
  assert.equal(finalize.status, 200, JSON.stringify(finalize.body));
  assert.equal(finalize.body.status, 'awaiting_landlord_signature');
  return finalize.body;
}

// ---------------------------------------------------------------------------
// Generic invitation + Unassigned Renters
// ---------------------------------------------------------------------------

test('a generic invite (no property yet) creates an account visible in Unassigned Renters right away, and still there once accepted', async () => {
  const email = `gen-${Math.random()}@example.com`;
  const invite = await api('POST', '/api/renters/invite', { name: 'Gen Renter', email }, ownerCookie);
  assert.equal(invite.status, 201);
  assert.ok(invite.body.url.includes('/renter#/accept-invite/'));

  // The renter row (with no password yet) is created the moment the invite
  // is sent, and "Unassigned Renters" is simply "no lease_renters row at
  // all" -- so it shows up immediately, before the renter has done anything,
  // letting the owner see who they've invited and not yet heard back from.
  const before = await api('GET', '/api/renters/unassigned', null, ownerCookie);
  assert.ok(before.body.some((r) => r.email === email), 'an invited-but-not-yet-accepted renter is already listed as unassigned');

  const token = tokenFromInviteUrl(invite.body.url);
  const accept = await api('POST', '/api/renter/accept-invite', { token, password: 'somepassword1' });
  assert.equal(accept.status, 200);
  assert.equal(accept.body.leaseId, null);

  const after1 = await api('GET', '/api/renters/unassigned', null, ownerCookie);
  assert.ok(after1.body.some((r) => r.email === email), 'renter appears in Unassigned Renters after accepting');
});

test('inviting an email that already has a portal account is refused (409), not silently re-invited', async () => {
  const email = `dup-${Math.random()}@example.com`;
  const invite = await api('POST', '/api/renters/invite', { name: 'Dup Renter', email }, ownerCookie);
  const token = tokenFromInviteUrl(invite.body.url);
  await api('POST', '/api/renter/accept-invite', { token, password: 'somepassword1' });
  const second = await api('POST', '/api/renters/invite', { name: 'Dup Renter', email }, ownerCookie);
  assert.equal(second.status, 409);
});

test('an expired/invalid invitation token is rejected with 410 on both preview and accept', async () => {
  const preview = await api('GET', '/api/renter/invite/not-a-real-token');
  assert.equal(preview.status, 410);
  const accept = await api('POST', '/api/renter/accept-invite', { token: 'not-a-real-token', password: 'somepassword1' });
  assert.equal(accept.status, 410);
});

test('accept-invite fills in name/phone for a generic invite without blanking anything the owner already supplied', async () => {
  const email = `named-${Math.random()}@example.com`;
  const invite = await api('POST', '/api/renters/invite', { name: 'Original Name', email }, ownerCookie);
  const token = tokenFromInviteUrl(invite.body.url);
  const accept = await api('POST', '/api/renter/accept-invite', { token, password: 'somepassword1', name: 'Renter Chosen Name', phone: '555-0000' });
  assert.equal(accept.status, 200);
  assert.equal(accept.body.renter.name, 'Renter Chosen Name');
  assert.equal(accept.body.renter.phone, '555-0000');
});

// ---------------------------------------------------------------------------
// Assign to property -> draft ("Lease Pending") tenancy
// ---------------------------------------------------------------------------

test('assigning an unassigned renter creates a draft lease with no rent history, and removes them from Unassigned Renters', async () => {
  const { property, lease, renterId } = await inviteAndAssign();
  assert.equal(lease.status, 'draft');
  assert.equal(lease.currentRentCents, null, 'a brand-new draft lease has no rent history yet');
  assert.equal(lease.rentHistory.length, 0);

  const unassigned = await api('GET', '/api/renters/unassigned', null, ownerCookie);
  assert.ok(!unassigned.body.some((r) => r.id === renterId), 'no longer unassigned once assigned to a property');

  const allLeases = await api('GET', `/api/properties/${property.id}/leases`, null, ownerCookie);
  assert.equal(allLeases.body.length, 1);
  assert.equal(allLeases.body[0].status, 'draft');

  const properties = await api('GET', '/api/properties', null, ownerCookie);
  const card = properties.body.find((p) => p.id === property.id);
  assert.equal(card.hasNoLeaseYet, true, 'a draft lease is not an active occupancy');
  assert.equal(card.pendingTenant && card.pendingTenant.id, lease.id, 'the portfolio card still surfaces the pending assignment');
});

test('assigning to a property that already has an active-or-draft lease is refused (no duplicate/conflicting tenancy)', async () => {
  const { property } = await inviteAndAssign();
  const invite2 = await api('POST', '/api/renters/invite', { name: 'Second Renter', email: `second-${Math.random()}@example.com` }, ownerCookie);
  const token2 = tokenFromInviteUrl(invite2.body.url);
  await api('POST', '/api/renter/accept-invite', { token: token2, password: 'somepassword1' });
  const conflict = await api('POST', `/api/renters/${invite2.body.renter.id}/assign`, { propertyId: property.id, startDate: TODAY }, ownerCookie);
  assert.equal(conflict.status, 409);
});

test('a manually-entered tenant (no portal invite at all) still works the old way, unaffected by the assignment flow', async () => {
  const property = await createProperty();
  const created = await api('POST', `/api/properties/${property.id}/leases`, { tenantName: 'Manual Tenant', startDate: TODAY, rent: '1200.00' }, ownerCookie);
  assert.equal(created.status, 201);
  assert.equal(created.body.status, 'active');
});

// ---------------------------------------------------------------------------
// Lease templates
// ---------------------------------------------------------------------------

test('a sample template is auto-provisioned, clearly labeled, and cannot be edited or deleted directly', async () => {
  const { lease } = await inviteAndAssign();
  const draft = await api('POST', `/api/leases/${lease.id}/agreements`, {}, ownerCookie);
  const templates = await api('GET', '/api/lease-templates', null, ownerCookie);
  const sample = templates.body.find((t) => t.id === draft.body.templateId);
  assert.ok(sample, 'the draft was assigned a template');
  assert.equal(sample.isSample, true);

  const editAttempt = await api('PUT', `/api/lease-templates/${sample.id}`, { name: 'Hacked', bodyText: 'x' }, ownerCookie);
  assert.equal(editAttempt.status, 409);
  const deleteAttempt = await api('DELETE', `/api/lease-templates/${sample.id}`, null, ownerCookie);
  assert.equal(deleteAttempt.status, 409);
});

test('duplicating the sample template produces an independent, editable copy; owner can create/update/delete their own templates', async () => {
  await inviteAndAssign(); // ensures the sample template exists for this owner
  const templates = await api('GET', '/api/lease-templates', null, ownerCookie);
  const sample = templates.body.find((t) => t.isSample);
  const dup = await api('POST', `/api/lease-templates/${sample.id}/duplicate`, {}, ownerCookie);
  assert.equal(dup.status, 201);
  assert.equal(dup.body.isSample, false);

  const edit = await api('PUT', `/api/lease-templates/${dup.body.id}`, { name: 'My Real Template', jurisdiction: 'Colorado', bodyText: 'Hello {{tenant_names}}' }, ownerCookie);
  assert.equal(edit.status, 200);
  assert.equal(edit.body.name, 'My Real Template');

  const created = await api('POST', '/api/lease-templates', { name: 'Blank', bodyText: 'Body' }, ownerCookie);
  assert.equal(created.status, 201);
  const del = await api('DELETE', `/api/lease-templates/${created.body.id}`, null, ownerCookie);
  assert.equal(del.status, 200);
});

test('the placeholder list is available for the template editor', async () => {
  const res = await api('GET', '/api/lease-templates/placeholders', null, ownerCookie);
  assert.equal(res.status, 200);
  assert.ok(res.body.some((p) => p.token === 'monthly_rent'));
});

// ---------------------------------------------------------------------------
// Lease preparation: draft fields, prefill, validation, preview
// ---------------------------------------------------------------------------

test('starting a lease agreement is idempotent -- repeated clicks reopen the same draft, never a duplicate', async () => {
  const { lease } = await inviteAndAssign();
  const first = await api('POST', `/api/leases/${lease.id}/agreements`, {}, ownerCookie);
  const second = await api('POST', `/api/leases/${lease.id}/agreements`, {}, ownerCookie);
  assert.equal(first.body.id, second.body.id);
  const list = await api('GET', `/api/leases/${lease.id}/agreements`, null, ownerCookie);
  assert.equal(list.body.length, 1);
});

test('a new draft is prefilled from the lease/property/owner records, with the tenant already listed as a required signer', async () => {
  const { lease, renterId } = await inviteAndAssign();
  const draft = await api('POST', `/api/leases/${lease.id}/agreements`, {}, ownerCookie);
  assert.equal(draft.body.fields.landlordName, 'Pat Owner');
  assert.equal(draft.body.fields.landlordContact, 'pat@example.com');
  assert.equal(draft.body.fields.tenants.length, 1);
  assert.equal(draft.body.fields.tenants[0].renterId, renterId);
  const tenantSigner = draft.body.signers.find((s) => s.role !== 'landlord');
  assert.ok(tenantSigner, 'the tenant is already a signer row, before anything is even filled in');
  const landlordSigner = draft.body.signers.find((s) => s.role === 'landlord');
  assert.ok(landlordSigner);
});

test('finalizing an incomplete draft is refused and lists exactly what is missing; never sends unfinished', async () => {
  const { lease } = await inviteAndAssign();
  const draft = await api('POST', `/api/leases/${lease.id}/agreements`, {}, ownerCookie);
  const finalize = await api('POST', `/api/lease-agreements/${draft.body.id}/finalize`, {}, ownerCookie);
  assert.equal(finalize.status, 400);
  assert.ok(finalize.body.error.includes('Monthly rent'), finalize.body.error);
});

test('the draft can be previewed as a PDF at any point, even incomplete, clearly marked PREVIEW and SAMPLE', async () => {
  const { lease } = await inviteAndAssign();
  const draft = await api('POST', `/api/leases/${lease.id}/agreements`, {}, ownerCookie);
  const pdf = await rawGet(`/api/lease-agreements/${draft.body.id}/preview.pdf`, ownerCookie);
  assert.equal(pdf.status, 200);
  assert.ok(pdf.contentType.includes('pdf'));
  assert.ok(pdf.buffer.length > 200);
});

test('finalizing freezes the document -- editing fields afterward is refused; void + a fresh agreement is the only way to change terms', async () => {
  const { lease } = await inviteAndAssign();
  const agreement = await prepareAndFinalize(lease.id);
  assert.ok(agreement.bodySnapshot && agreement.bodySnapshot.length > 50, 'body_snapshot was frozen');

  const editAttempt = await api('PUT', `/api/lease-agreements/${agreement.id}`, { fields: { monthlyRent: '9999' } }, ownerCookie);
  assert.equal(editAttempt.status, 409);

  const voided = await api('POST', `/api/lease-agreements/${agreement.id}/void`, {}, ownerCookie);
  assert.equal(voided.status, 200);
  assert.equal(voided.body.status, 'voided');

  const reopened = await api('POST', `/api/leases/${lease.id}/agreements`, {}, ownerCookie);
  assert.notEqual(reopened.body.id, agreement.id, 'a fresh agreement, not the voided one');
  assert.equal(reopened.body.version, agreement.version + 1);
  assert.equal(reopened.body.replacesAgreementId, agreement.id);
  assert.equal(reopened.body.fields.monthlyRent, agreement.fields.monthlyRent, 'prior terms carried forward for editing, not retyped from scratch');

  const list = await api('GET', `/api/leases/${lease.id}/agreements`, null, ownerCookie);
  assert.equal(list.body.length, 2, 'the voided original is superseded, never modified or deleted');
});

// ---------------------------------------------------------------------------
// Landlord signs & sends
// ---------------------------------------------------------------------------

test('landlord sign requires explicit consent and a typed signature; cannot sign a non-existent/foreign agreement', async () => {
  const { lease } = await inviteAndAssign();
  const agreement = await prepareAndFinalize(lease.id);
  const noConsent = await api('POST', `/api/lease-agreements/${agreement.id}/sign`, { consent: false, signatureText: 'Pat Owner' }, ownerCookie);
  assert.equal(noConsent.status, 400);
  const noName = await api('POST', `/api/lease-agreements/${agreement.id}/sign`, { consent: true, signatureText: '   ' }, ownerCookie);
  assert.equal(noName.status, 400);
});

test('landlord sign+send moves a single-tenant agreement to "awaiting renter signature", records a server timestamp, and cannot be repeated', async () => {
  const { lease } = await inviteAndAssign();
  const agreement = await prepareAndFinalize(lease.id);
  const signed = await api('POST', `/api/lease-agreements/${agreement.id}/sign`, { consent: true, signatureText: 'Pat Owner' }, ownerCookie);
  assert.equal(signed.status, 200);
  assert.equal(signed.body.status, 'awaiting_renter_signature', 'must NOT read as partially_signed just because the landlord alone has signed');
  assert.ok(signed.body.sentAt, 'a server-recorded send timestamp exists');
  const landlordSigner = signed.body.signers.find((s) => s.role === 'landlord');
  assert.equal(landlordSigner.status, 'signed');
  assert.ok(landlordSigner.signedAt);

  const again = await api('POST', `/api/lease-agreements/${agreement.id}/sign`, { consent: true, signatureText: 'Pat Owner' }, ownerCookie);
  assert.equal(again.status, 409);
});

// ---------------------------------------------------------------------------
// Renter reviews / signs / declines / requests a correction
// ---------------------------------------------------------------------------

test('a renter with no signer row on the agreement gets a clean 404 -- signer identity is never client-supplied', async () => {
  const { lease, renterCookie } = await inviteAndAssign();
  const agreement = await prepareAndFinalize(lease.id);
  await api('POST', `/api/lease-agreements/${agreement.id}/sign`, { consent: true, signatureText: 'Pat Owner' }, ownerCookie);

  // A second, unrelated renter (never added to this lease at all).
  const outsider = await inviteAndAssign();
  const foreignFetch = await api('GET', `/api/renter/agreements/${agreement.id}`, null, outsider.renterCookie);
  assert.equal(foreignFetch.status, 404);
  const foreignSign = await api('POST', `/api/renter/agreements/${agreement.id}/sign`, { consent: true, signatureText: 'Someone Else' }, outsider.renterCookie);
  assert.equal(foreignSign.status, 404);

  // The rightful renter, however, can see and sign it.
  const rightful = await api('GET', `/api/renter/agreements/${agreement.id}`, null, renterCookie);
  assert.equal(rightful.status, 200);
});

test('renter sign requires explicit consent and a typed signature, same as the landlord', async () => {
  const { lease, renterCookie } = await inviteAndAssign();
  const agreement = await prepareAndFinalize(lease.id);
  await api('POST', `/api/lease-agreements/${agreement.id}/sign`, { consent: true, signatureText: 'Pat Owner' }, ownerCookie);
  const noConsent = await api('POST', `/api/renter/agreements/${agreement.id}/sign`, { consent: false, signatureText: 'Riley Renter' }, renterCookie);
  assert.equal(noConsent.status, 400);
});

test('single-tenant agreement completes the moment the one tenant signs, generating the final PDF + hash and syncing the lease', async () => {
  const { lease, property, renterCookie } = await inviteAndAssign({ startDate: TODAY });
  const agreement = await prepareAndFinalize(lease.id, { leaseStartDate: TODAY, monthToMonth: true });
  await api('POST', `/api/lease-agreements/${agreement.id}/sign`, { consent: true, signatureText: 'Pat Owner' }, ownerCookie);
  const signed = await api('POST', `/api/renter/agreements/${agreement.id}/sign`, { consent: true, signatureText: 'Riley Renter' }, renterCookie);
  assert.equal(signed.status, 200);
  assert.equal(signed.body.status, 'completed');
  assert.ok(signed.body.completedAt);
  assert.ok(signed.body.documentHash && signed.body.documentHash.length === 64, 'sha256 hex digest stored');
  assert.ok(signed.body.finalPdfUrl);

  const pdf = await rawGet(signed.body.finalPdfUrl, ownerCookie);
  assert.equal(pdf.status, 200);
  assert.ok(pdf.contentType.includes('pdf'));
  assert.ok(pdf.buffer.length > 200);

  // Lease sync: active, rent history recorded exactly once, deposit
  // required set, deposit HELD left untouched, never a duplicated lease row.
  const leaseAfter = await api('GET', `/api/properties/${property.id}/leases`, null, ownerCookie);
  assert.equal(leaseAfter.body.length, 1, 'never duplicates the lease');
  const synced = leaseAfter.body[0];
  assert.equal(synced.id, lease.id);
  assert.equal(synced.status, 'active');
  assert.equal(synced.currentRentCents, 150000);
  assert.equal(synced.rentHistory.length, 1);
  assert.equal(synced.depositRequiredCents, 150000);
  assert.equal(synced.depositHeldCents, 0, 'never marks a deposit as HELD just because it is required');

  // Completing again (defensive replay) must not duplicate the rent-history
  // row or re-run the sync -- recomputeAgreementStatus/completeAgreement are
  // both idempotency-guarded.
  const resignAttempt = await api('POST', `/api/renter/agreements/${agreement.id}/sign`, { consent: true, signatureText: 'Riley Renter' }, renterCookie);
  assert.equal(resignAttempt.status, 409);
  const leaseAfter2 = await api('GET', `/api/properties/${property.id}/leases`, null, ownerCookie);
  assert.equal(leaseAfter2.body[0].rentHistory.length, 1, 'still exactly one rent-history row');
});

test('a future-dated lease start never bills before it starts, even once the agreement completes and the lease goes active', async () => {
  const futureStart = addDays(TODAY, 30);
  const { lease, property, renterCookie } = await inviteAndAssign({ startDate: futureStart });
  const agreement = await prepareAndFinalize(lease.id, { leaseStartDate: futureStart, monthToMonth: true });
  await api('POST', `/api/lease-agreements/${agreement.id}/sign`, { consent: true, signatureText: 'Pat Owner' }, ownerCookie);
  await api('POST', `/api/renter/agreements/${agreement.id}/sign`, { consent: true, signatureText: 'Riley Renter' }, renterCookie);

  const leaseAfter = await api('GET', `/api/properties/${property.id}/leases`, null, ownerCookie);
  const synced = leaseAfter.body[0];
  assert.equal(synced.status, 'active');
  assert.equal(synced.charges.length, 0, 'no charge exists yet for a tenancy that has not started');
});

test('two required signers (primary + co-tenant): partially_signed after one, completed only after both, each in their own field', async () => {
  const { lease, property, renterCookie: primaryCookie, renterId: primaryId } = await inviteAndAssign();
  // Add a co-tenant with their own portal account, linked to the SAME lease.
  const coInvite = await api('POST', '/api/renters/invite', { name: 'Casey Co-Tenant', email: `co-${Math.random()}@example.com` }, ownerCookie);
  const coToken = tokenFromInviteUrl(coInvite.body.url);
  const coAccept = await api('POST', '/api/renter/accept-invite', { token: coToken, password: 'somepassword1' });
  const coCookie = coAccept.cookie;
  const addCoRenter = await api('POST', `/api/leases/${lease.id}/renters`, { name: 'Casey Co-Tenant', email: coInvite.body.renter.email, role: 'co_renter' }, ownerCookie);
  assert.equal(addCoRenter.status, 201);
  assert.notEqual(addCoRenter.body.id, primaryId);
  assert.equal(addCoRenter.body.id, coInvite.body.renter.id, 'the same email resolves to the SAME renter identity, not a duplicate');

  // Re-opening the draft must pick up the newly-added co-tenant as a signer.
  const draft = await api('POST', `/api/leases/${lease.id}/agreements`, {}, ownerCookie);
  assert.equal(draft.body.fields.tenants.length, 2);
  const finalize = await prepareAndFinalize(lease.id);
  assert.equal(finalize.signers.filter((s) => s.role !== 'landlord').length, 2);

  await api('POST', `/api/lease-agreements/${finalize.id}/sign`, { consent: true, signatureText: 'Pat Owner' }, ownerCookie);

  const firstSign = await api('POST', `/api/renter/agreements/${finalize.id}/sign`, { consent: true, signatureText: 'Riley Renter' }, primaryCookie);
  assert.equal(firstSign.status, 200);
  assert.equal(firstSign.body.status, 'partially_signed');

  // The co-tenant cannot complete the primary's field, and vice versa --
  // each signer row is looked up by the CALLER's own renter id only. (Filter
  // out the landlord too -- their renterId is also not primaryId, but they
  // already signed earlier and aren't who this check is about.)
  const coStillPending = firstSign.body.signers.find((s) => s.role !== 'landlord' && s.renterId !== primaryId);
  assert.equal(coStillPending.status, 'pending');

  const secondSign = await api('POST', `/api/renter/agreements/${finalize.id}/sign`, { consent: true, signatureText: 'Casey Co-Tenant' }, coCookie);
  assert.equal(secondSign.status, 200);
  assert.equal(secondSign.body.status, 'completed');
  assert.ok(secondSign.body.signers.every((s) => s.status === 'signed'));
});

test('renter decline requires a message, marks the agreement declined, and blocks further signing', async () => {
  const { lease, renterCookie } = await inviteAndAssign();
  const agreement = await prepareAndFinalize(lease.id);
  await api('POST', `/api/lease-agreements/${agreement.id}/sign`, { consent: true, signatureText: 'Pat Owner' }, ownerCookie);

  const emptyMessage = await api('POST', `/api/renter/agreements/${agreement.id}/decline`, { message: '  ' }, renterCookie);
  assert.equal(emptyMessage.status, 400);

  const declined = await api('POST', `/api/renter/agreements/${agreement.id}/decline`, { message: 'Rent is wrong.' }, renterCookie);
  assert.equal(declined.status, 200);
  assert.equal(declined.body.status, 'declined');
  assert.equal(declined.body.declineReason, 'Rent is wrong.');

  const signAfterDecline = await api('POST', `/api/renter/agreements/${agreement.id}/sign`, { consent: true, signatureText: 'Riley Renter' }, renterCookie);
  assert.equal(signAfterDecline.status, 409);
});

test('renter request-correction blocks signing until the owner voids and replaces the agreement', async () => {
  const { lease, renterCookie } = await inviteAndAssign();
  const agreement = await prepareAndFinalize(lease.id);
  await api('POST', `/api/lease-agreements/${agreement.id}/sign`, { consent: true, signatureText: 'Pat Owner' }, ownerCookie);

  const correction = await api('POST', `/api/renter/agreements/${agreement.id}/request-correction`, { message: 'Wrong move-in date.' }, renterCookie);
  assert.equal(correction.status, 200);
  assert.equal(correction.body.status, 'changes_requested');

  const signBlocked = await api('POST', `/api/renter/agreements/${agreement.id}/sign`, { consent: true, signatureText: 'Riley Renter' }, renterCookie);
  assert.equal(signBlocked.status, 409, 'changes_requested is not a signable state');

  const voided = await api('POST', `/api/lease-agreements/${agreement.id}/void`, {}, ownerCookie);
  assert.equal(voided.status, 200);
  const reopened = await api('POST', `/api/leases/${lease.id}/agreements`, {}, ownerCookie);
  assert.equal(reopened.body.status, 'draft');
  assert.equal(reopened.body.replacesAgreementId, agreement.id);
});

// ---------------------------------------------------------------------------
// Status tracking: remind, audit trail, email, former-tenant isolation
// ---------------------------------------------------------------------------

test('reminding pending signers is a safe, non-mutating action reflected in the audit trail', async () => {
  const { lease } = await inviteAndAssign();
  const agreement = await prepareAndFinalize(lease.id);
  await api('POST', `/api/lease-agreements/${agreement.id}/sign`, { consent: true, signatureText: 'Pat Owner' }, ownerCookie);
  const remind = await api('POST', `/api/lease-agreements/${agreement.id}/remind`, {}, ownerCookie);
  assert.equal(remind.status, 200);
  assert.equal(remind.body.remindedCount, 1);
  const events = await api('GET', `/api/lease-agreements/${agreement.id}/events`, null, ownerCookie);
  assert.ok(events.body.some((e) => e.eventType === 'reminded'));
});

test('the signing audit trail records every step, in order, for both owner and renter views, with server timestamps', async () => {
  const { lease, renterCookie } = await inviteAndAssign();
  const agreement = await prepareAndFinalize(lease.id);
  await api('POST', `/api/lease-agreements/${agreement.id}/sign`, { consent: true, signatureText: 'Pat Owner' }, ownerCookie);
  await api('POST', `/api/renter/agreements/${agreement.id}/sign`, { consent: true, signatureText: 'Riley Renter' }, renterCookie);

  const ownerEvents = await api('GET', `/api/lease-agreements/${agreement.id}/events`, null, ownerCookie);
  const types = ownerEvents.body.map((e) => e.eventType);
  assert.deepEqual(types, ['created', 'finalized', 'consented', 'signed', 'sent', 'consented', 'signed', 'completed']);
  assert.ok(ownerEvents.body.every((e) => e.createdAt), 'every event has a server-recorded timestamp');

  const renterEvents = await api('GET', `/api/renter/agreements/${agreement.id}/events`, null, renterCookie);
  assert.deepEqual(renterEvents.body.map((e) => e.eventType), types, 'the renter sees the same full record, not a filtered one');
});

test('emailing the agreement is refused until it is completed, then reports a simulated recipient (no real provider configured)', async () => {
  const { lease } = await inviteAndAssign();
  const agreement = await prepareAndFinalize(lease.id);
  const tooEarly = await api('POST', `/api/lease-agreements/${agreement.id}/email`, {}, ownerCookie);
  assert.equal(tooEarly.status, 409);
});

test('a former tenant keeps access to their own completed agreement, and never sees the next tenant\'s agreement on the SAME property', async () => {
  const { lease, property, renterCookie: firstCookie } = await inviteAndAssign();
  const agreement1 = await prepareAndFinalize(lease.id);
  await api('POST', `/api/lease-agreements/${agreement1.id}/sign`, { consent: true, signatureText: 'Pat Owner' }, ownerCookie);
  await api('POST', `/api/renter/agreements/${agreement1.id}/sign`, { consent: true, signatureText: 'Riley Renter' }, firstCookie);

  const ended = await api('POST', `/api/leases/${lease.id}/end`, { endDate: TODAY, depositDisposition: 'Returned in full' }, ownerCookie);
  assert.equal(ended.status, 200);

  // A brand-new renter takes over the SAME now-vacant property -- a new
  // lease row (never a re-use of the ended one), with its own new agreement.
  const secondInvite = await api('POST', '/api/renters/invite', { name: 'Sam Successor', email: `succ-${Math.random()}@example.com` }, ownerCookie);
  const secondToken = tokenFromInviteUrl(secondInvite.body.url);
  const secondAccept = await api('POST', '/api/renter/accept-invite', { token: secondToken, password: 'somepassword1' });
  const secondCookie = secondAccept.cookie;
  const secondAssign = await api('POST', `/api/renters/${secondInvite.body.renter.id}/assign`, { propertyId: property.id, startDate: TODAY }, ownerCookie);
  assert.equal(secondAssign.status, 201);
  assert.notEqual(secondAssign.body.id, lease.id, 'a new tenancy is a new lease row, not a re-use of the ended one');

  const agreement2 = await prepareAndFinalize(secondAssign.body.id);
  await api('POST', `/api/lease-agreements/${agreement2.id}/sign`, { consent: true, signatureText: 'Pat Owner' }, ownerCookie);
  await api('POST', `/api/renter/agreements/${agreement2.id}/sign`, { consent: true, signatureText: 'Sam Successor' }, secondCookie);

  // The first (former) renter still sees their own completed agreement...
  const ownHistory = await api('GET', `/api/renter/leases/${lease.id}/agreements`, null, firstCookie);
  assert.equal(ownHistory.status, 200);
  assert.ok(ownHistory.body.some((a) => a.id === agreement1.id));

  // ...but has no signer row on the successor's lease/agreement at all, so
  // both 404 rather than leaking the new tenant's document.
  const crossAgreement = await api('GET', `/api/renter/agreements/${agreement2.id}`, null, firstCookie);
  assert.equal(crossAgreement.status, 404);
  const crossLease = await api('GET', `/api/renter/leases/${secondAssign.body.id}/agreements`, null, firstCookie);
  assert.equal(crossLease.status, 404, 'the former tenant has no lease_renters row on the successor\'s lease either');
});

// ---------------------------------------------------------------------------
// Regression guard: server/routes/leases.js's conflict check treats a draft
// tenancy as already occupying the property (§2's "prevent conflicting
// property assignments").
// ---------------------------------------------------------------------------

test('a manual "add lease" is refused while a draft ("Lease Pending") tenancy already occupies the property', async () => {
  const { property } = await inviteAndAssign();
  const attempt = await api('POST', `/api/properties/${property.id}/leases`, { tenantName: 'Someone Else', startDate: TODAY, rent: '1000.00' }, ownerCookie);
  assert.equal(attempt.status, 409);
});

// Unit tests for server/lib/statements.js's rendering/totals math and its
// immutable-snapshot behavior, isolated from HTTP (see test/renterPortal.test.js
// for the route-level share/visibility/download tests). Every PDF produced
// here is actually opened with pdftotext, not just structurally checked —
// see test/pdf.test.js's header for why that distinction matters.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const os = require('os');
const path = require('path');

process.env.UPLOADS_DIR = path.join(os.tmpdir(), `rental-app-statements-test-uploads-${Date.now()}-${process.pid}`);
process.env.DATA_DIR = path.join(os.tmpdir(), `rental-app-statements-test-datadir-${Date.now()}-${process.pid}`);

const { openDatabase } = require('../server/db');
const { generateStatement, serializeStatement } = require('../server/lib/statements');

let db, propertyId, leaseId;

before(() => {
  db = openDatabase(':memory:');
  db.prepare("INSERT INTO owners (name, email, password_hash) VALUES ('Owner','o@x.com','h')").run();
  propertyId = db.prepare(`
    INSERT INTO properties (owner_id, name, address_line1, city, state, zip, timezone)
    VALUES (1,'Statement Test House','1 Test Way','Denver','CO','80202','America/Denver')
  `).run().lastInsertRowid;
  leaseId = db.prepare(`
    INSERT INTO leases (property_id, tenant_name, tenant_email, start_date, due_day, late_after_days, status)
    VALUES (?, 'Riley Tenant', 'riley@example.com', '2025-01-01', 1, 5, 'active')
  `).run(propertyId).lastInsertRowid;
  db.prepare("INSERT INTO lease_rent_history (lease_id, rent_cents, effective_date) VALUES (?, 150000, '2025-01-01')").run(leaseId);
});

after(() => db.close());

function property() {
  return db.prepare('SELECT * FROM properties WHERE id = ?').get(propertyId);
}
function lease() {
  return db.prepare('SELECT * FROM leases WHERE id = ?').get(leaseId);
}
function addCharge(periodStart, periodEnd, dueDate, lateDate, amountCents) {
  return db.prepare('INSERT INTO charges (lease_id, period_start, period_end, due_date, late_date, amount_cents) VALUES (?,?,?,?,?,?)')
    .run(leaseId, periodStart, periodEnd, dueDate, lateDate, amountCents).lastInsertRowid;
}
function addPayment(chargeId, amountCents, opts = {}) {
  db.prepare(`
    INSERT INTO payments (lease_id, charge_id, amount_cents, type, method, status, paid_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(leaseId, chargeId, amountCents, opts.type || 'payment', opts.method || 'ach', opts.status || 'completed', opts.paidAt || '2025-01-03');
}
function extractText(filePath) {
  execFileSync('qpdf', ['--check', filePath], { stdio: 'pipe' });
  return execFileSync('pdftotext', [filePath, '-']).toString('utf8');
}
function absolutePathFor(statement) {
  return path.join(process.env.UPLOADS_DIR, 'properties', String(propertyId), 'statements', statement.file_path);
}

test('totals sum billed/paid/outstanding correctly across a fully paid, a partially paid, and an unpaid charge', () => {
  const c1 = addCharge('2025-01-01', '2025-01-31', '2025-01-01', '2025-01-06', 150000);
  const c2 = addCharge('2025-02-01', '2025-02-28', '2025-02-01', '2025-02-06', 150000);
  const c3 = addCharge('2025-03-01', '2025-03-31', '2025-03-01', '2025-03-06', 150000);
  addPayment(c1, 150000);
  addPayment(c2, 75000);

  const statement = generateStatement(db, {
    lease: lease(), property: property(), rangeType: 'custom', rangeStart: '2025-01-01', rangeEnd: '2025-03-31',
    generatedBy: 'owner', isSample: false,
  });
  const s = serializeStatement(statement);
  assert.equal(s.totals.billedCents, 450000);
  assert.equal(s.totals.paidCents, 225000);
  assert.equal(s.totals.outstandingCents, 225000);
  assert.equal(s.totals.chargeCount, 3);
  assert.equal(s.isSample, false);
  assert.equal(s.sharedWithRenter, false, 'a freshly generated statement must not be shared by default');

  const text = extractText(absolutePathFor(statement));
  assert.ok(text.includes('$4,500.00'));
  assert.ok(text.includes('$2,250.00'));
});

test('a refund reduces net paid and reopens outstanding balance in the statement totals', () => {
  const c1 = addCharge('2025-04-01', '2025-04-30', '2025-04-01', '2025-04-06', 100000);
  addPayment(c1, 100000, { paidAt: '2025-04-02' });
  // amount_cents is always a positive magnitude, even for a refund/reversal —
  // rentStatus.js's netPaidForCharge is what applies the sign, based on type.
  addPayment(c1, 30000, { type: 'refund', paidAt: '2025-04-10' });

  const statement = generateStatement(db, {
    lease: lease(), property: property(), rangeType: 'custom', rangeStart: '2025-04-01', rangeEnd: '2025-04-30',
    generatedBy: 'owner', isSample: false,
  });
  const s = serializeStatement(statement);
  assert.equal(s.totals.billedCents, 100000);
  assert.equal(s.totals.paidCents, 70000);
  assert.equal(s.totals.outstandingCents, 30000);
});

test('charges outside the requested range are excluded from totals and from the rendered table', () => {
  const inRange = addCharge('2025-06-01', '2025-06-30', '2025-06-01', '2025-06-06', 150000);
  addCharge('2025-07-01', '2025-07-31', '2025-07-01', '2025-07-06', 150000); // outside the range below

  const statement = generateStatement(db, {
    lease: lease(), property: property(), rangeType: 'month', rangeStart: '2025-06-01', rangeEnd: '2025-06-30',
    generatedBy: 'owner', isSample: false,
  });
  const s = serializeStatement(statement);
  assert.equal(s.totals.chargeCount, 1);
  assert.equal(s.totals.billedCents, 150000);
  const text = extractText(absolutePathFor(statement));
  assert.ok(text.includes('Jun 1, 2025'));
  assert.ok(!text.includes('Jul 1, 2025 – Jul 31, 2025'));
});

test('a range with no charges at all still produces a valid PDF saying so, with zero totals', () => {
  const statement = generateStatement(db, {
    lease: lease(), property: property(), rangeType: 'year', rangeStart: '2099-01-01', rangeEnd: '2099-12-31',
    generatedBy: 'owner', isSample: false,
  });
  const s = serializeStatement(statement);
  assert.equal(s.totals.chargeCount, 0);
  assert.equal(s.totals.billedCents, 0);
  const text = extractText(absolutePathFor(statement));
  assert.ok(text.includes('No charges fall within this date range.'));
});

test('is_sample statements are watermarked in the PDF and flagged in the serialized record', () => {
  const statement = generateStatement(db, {
    lease: lease(), property: property(), rangeType: 'lease_to_date', rangeStart: '2025-01-01', rangeEnd: '2025-12-31',
    generatedBy: 'owner', isSample: true,
  });
  assert.equal(serializeStatement(statement).isSample, true);
  const text = extractText(absolutePathFor(statement));
  assert.match(text, /SAMPLE DATA/);
});

test('generating a statement twice for the same lease/range produces two independent, immutable rows — never overwrites the first', () => {
  const c1 = addCharge('2025-08-01', '2025-08-31', '2025-08-01', '2025-08-06', 150000);
  const first = generateStatement(db, { lease: lease(), property: property(), rangeType: 'month', rangeStart: '2025-08-01', rangeEnd: '2025-08-31', generatedBy: 'owner', isSample: false });
  assert.equal(serializeStatement(first).totals.outstandingCents, 150000);

  // The ledger changes AFTER the first statement was generated...
  addPayment(c1, 150000, { paidAt: '2025-08-15' });

  const second = generateStatement(db, { lease: lease(), property: property(), rangeType: 'month', rangeStart: '2025-08-01', rangeEnd: '2025-08-31', generatedBy: 'owner', isSample: false });
  assert.equal(serializeStatement(second).totals.outstandingCents, 0);

  // ...and re-reading the FIRST row from the database proves it never changed:
  // its totals_json is frozen at generation time, exactly as db.js's
  // payment_statements comment promises.
  const firstReloaded = db.prepare('SELECT * FROM payment_statements WHERE id = ?').get(first.id);
  assert.equal(serializeStatement(firstReloaded).totals.outstandingCents, 150000, 'an earlier statement must never be silently corrected by a later ledger change');
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.file_path, second.file_path, 'each generation must write its own PDF file, never overwrite a prior one');
});

test('a co-tenant name is included in the statement header when present', () => {
  const coTenantLeaseId = db.prepare(`
    INSERT INTO leases (property_id, tenant_name, co_tenant_name, tenant_email, start_date, due_day, late_after_days, status)
    VALUES (?, 'Riley Tenant', 'Sam Co-Tenant', 'riley@example.com', '2025-01-01', 1, 5, 'active')
  `).run(propertyId).lastInsertRowid;
  db.prepare("INSERT INTO lease_rent_history (lease_id, rent_cents, effective_date) VALUES (?, 150000, '2025-01-01')").run(coTenantLeaseId);
  const coLease = db.prepare('SELECT * FROM leases WHERE id = ?').get(coTenantLeaseId);
  const statement = generateStatement(db, { lease: coLease, property: property(), rangeType: 'lease_to_date', rangeStart: '2025-01-01', rangeEnd: '2025-12-31', generatedBy: 'owner', isSample: false });
  const text = extractText(absolutePathFor(statement));
  assert.ok(text.includes('Riley Tenant & Sam Co-Tenant'));
});

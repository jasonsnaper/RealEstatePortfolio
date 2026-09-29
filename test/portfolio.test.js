const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../server/db');
const { computePortfolioTotals } = require('../server/lib/portfolio');

function setupOwnerWithTwoPropertiesSharingOneBankAccount() {
  const db = openDatabase(':memory:');
  db.prepare("INSERT INTO owners (name, email, password_hash) VALUES ('O','o@x.com','h')").run();
  db.prepare("INSERT INTO properties (owner_id, name, status) VALUES (1,'Prop A','active')").run();
  db.prepare("INSERT INTO properties (owner_id, name, status) VALUES (1,'Prop B','active')").run();
  db.prepare("INSERT INTO bank_accounts (owner_id, nickname, manual_balance_cents, manual_as_of) VALUES (1,'Shared Checking',500000,'2026-09-01')").run();
  db.prepare('INSERT INTO property_bank_accounts (property_id, bank_account_id) VALUES (1,1)').run();
  db.prepare('INSERT INTO property_bank_accounts (property_id, bank_account_id) VALUES (2,1)').run();
  return db;
}

test('a bank account shared by two properties is counted once, not twice, in cash held', () => {
  const db = setupOwnerWithTwoPropertiesSharingOneBankAccount();
  const totals = computePortfolioTotals(db, 1, {});
  assert.equal(totals.cashHeldCents, 500000, 'shared $5,000 balance must appear once, not $10,000');
  assert.equal(totals.linkedAccountCount, 1);
});

test('two properties with two separate (non-shared) bank accounts sum normally', () => {
  const db = openDatabase(':memory:');
  db.prepare("INSERT INTO owners (name, email, password_hash) VALUES ('O','o@x.com','h')").run();
  db.prepare("INSERT INTO properties (owner_id, name, status) VALUES (1,'Prop A','active')").run();
  db.prepare("INSERT INTO properties (owner_id, name, status) VALUES (1,'Prop B','active')").run();
  db.prepare("INSERT INTO bank_accounts (owner_id, nickname, manual_balance_cents, manual_as_of) VALUES (1,'Acct A',300000,'2026-09-01')").run();
  db.prepare("INSERT INTO bank_accounts (owner_id, nickname, manual_balance_cents, manual_as_of) VALUES (1,'Acct B',200000,'2026-09-01')").run();
  db.prepare('INSERT INTO property_bank_accounts (property_id, bank_account_id) VALUES (1,1)').run();
  db.prepare('INSERT INTO property_bank_accounts (property_id, bank_account_id) VALUES (2,2)').run();
  const totals = computePortfolioTotals(db, 1, {});
  assert.equal(totals.cashHeldCents, 500000);
  assert.equal(totals.linkedAccountCount, 2);
});

test('an archived property is excluded from portfolio totals entirely', () => {
  const db = openDatabase(':memory:');
  db.prepare("INSERT INTO owners (name, email, password_hash) VALUES ('O','o@x.com','h')").run();
  db.prepare("INSERT INTO properties (owner_id, name, status) VALUES (1,'Active Prop','active')").run();
  db.prepare("INSERT INTO properties (owner_id, name, status, archived_at) VALUES (1,'Old Prop','archived', datetime('now'))").run();
  db.prepare("INSERT INTO property_valuations (property_id, value_cents, valuation_date, is_purchase) VALUES (1,20000000,'2026-01-01',1)").run();
  db.prepare("INSERT INTO property_valuations (property_id, value_cents, valuation_date, is_purchase) VALUES (2,50000000,'2026-01-01',1)").run();
  const totals = computePortfolioTotals(db, 1, {});
  assert.equal(totals.estimatedValueCents, 20000000, 'archived property value must not count toward live totals');
  assert.equal(totals.propertyCount, 1);
});

test('estimated equity = latest value minus outstanding principal, using the most recent valuation only', () => {
  const db = openDatabase(':memory:');
  db.prepare("INSERT INTO owners (name, email, password_hash) VALUES ('O','o@x.com','h')").run();
  db.prepare("INSERT INTO properties (owner_id, name, status) VALUES (1,'P','active')").run();
  db.prepare("INSERT INTO property_valuations (property_id, value_cents, valuation_date, is_purchase) VALUES (1,20000000,'2024-01-01',1)").run();
  db.prepare("INSERT INTO property_valuations (property_id, value_cents, valuation_date) VALUES (1,25000000,'2026-01-01')").run();
  db.prepare("INSERT INTO mortgages (property_id, lender, original_amount_cents, current_principal_cents) VALUES (1,'Bank',18000000,15000000)").run();
  const totals = computePortfolioTotals(db, 1, {});
  assert.equal(totals.estimatedValueCents, 25000000, 'must use latest valuation, not the original purchase price');
  assert.equal(totals.outstandingPrincipalCents, 15000000);
  assert.equal(totals.estimatedEquityCents, 10000000);
});

test('security deposits held never counts toward rent collected', () => {
  const db = openDatabase(':memory:');
  db.prepare("INSERT INTO owners (name, email, password_hash) VALUES ('O','o@x.com','h')").run();
  db.prepare("INSERT INTO properties (owner_id, name, status) VALUES (1,'P','active')").run();
  db.prepare(`INSERT INTO leases (property_id, tenant_name, start_date, due_day, late_after_days, status, deposit_held_cents)
              VALUES (1,'T','2026-01-01',1,5,'active',150000)`).run();
  db.prepare("INSERT INTO lease_rent_history (lease_id, rent_cents, effective_date) VALUES (1,120000,'2026-01-01')").run();
  const totals = computePortfolioTotals(db, 1, { start: '2026-01-01', end: '2026-12-31' });
  assert.equal(totals.securityDepositsHeldCents, 150000);
  assert.equal(totals.rentCollectedCents, 0, 'no payments were recorded, so collected rent is zero even though a deposit is held');
});

test('NOI excludes mortgage payments and capital expenditures; cash flow includes them', () => {
  const db = openDatabase(':memory:');
  db.prepare("INSERT INTO owners (name, email, password_hash) VALUES ('O','o@x.com','h')").run();
  db.prepare("INSERT INTO properties (owner_id, name, status) VALUES (1,'P','active')").run();
  db.prepare(`INSERT INTO leases (property_id, tenant_name, start_date, due_day, late_after_days, status)
              VALUES (1,'T','2026-09-01',1,5,'active')`).run();
  db.prepare("INSERT INTO lease_rent_history (lease_id, rent_cents, effective_date) VALUES (1,150000,'2026-09-01')").run();
  db.prepare(`INSERT INTO charges (lease_id, period_start, period_end, due_date, late_date, amount_cents)
              VALUES (1,'2026-09-01','2026-09-30','2026-09-01','2026-09-06',150000)`).run();
  db.prepare(`INSERT INTO payments (lease_id, charge_id, amount_cents, type, status, paid_at) VALUES (1,1,150000,'payment','completed','2026-09-02')`).run();
  // The real payment-recording route mirrors every completed rent payment into the
  // general ledger too, which is what makes it visible to cash flow (see routes/leases.js).
  db.prepare(`INSERT INTO transactions (property_id, type, direction, amount_cents, txn_date, is_operating, related_payment_id) VALUES (1,'rent_payment','in',150000,'2026-09-02',1,1)`).run();
  db.prepare(`INSERT INTO transactions (property_id, type, direction, amount_cents, txn_date, is_operating, is_debt_service) VALUES (1,'mortgage_payment','out',110000,'2026-09-05',0,1)`).run();
  db.prepare(`INSERT INTO transactions (property_id, type, direction, amount_cents, txn_date, is_operating) VALUES (1,'expense','out',20000,'2026-09-10',1)`).run();
  db.prepare(`INSERT INTO transactions (property_id, type, direction, amount_cents, txn_date, is_operating, is_capital) VALUES (1,'expense','out',80000,'2026-09-12',0,1)`).run();

  const totals = computePortfolioTotals(db, 1, { start: '2026-09-01', end: '2026-09-30' });
  assert.equal(totals.rentCollectedCents, 150000);
  assert.equal(totals.operatingExpensesCents, 20000, 'only the operating expense counts, not the mortgage payment or the capex');
  assert.equal(totals.netOperatingIncomeCents, 130000); // 150000 - 20000
  assert.equal(totals.cashFlowCents, 150000 - 110000 - 20000 - 80000); // everything, including mortgage + capex
});

test('occupancy rate reflects properties with an active lease vs total active properties', () => {
  const db = openDatabase(':memory:');
  db.prepare("INSERT INTO owners (name, email, password_hash) VALUES ('O','o@x.com','h')").run();
  db.prepare("INSERT INTO properties (owner_id, name, status) VALUES (1,'A','active')").run();
  db.prepare("INSERT INTO properties (owner_id, name, status) VALUES (1,'B','active')").run();
  db.prepare("INSERT INTO properties (owner_id, name, status) VALUES (1,'C','active')").run();
  db.prepare("INSERT INTO leases (property_id, tenant_name, start_date, due_day, late_after_days, status) VALUES (1,'T','2026-01-01',1,5,'active')").run();
  const totals = computePortfolioTotals(db, 1, {});
  assert.equal(totals.occupancyRate, 1 / 3);
});

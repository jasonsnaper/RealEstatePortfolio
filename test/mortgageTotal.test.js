const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../server/db');
const { computePortfolioTotals } = require('../server/lib/portfolio');

function baseOwnerAndProperty(db, propertyName = 'P', status = 'active') {
  db.prepare("INSERT INTO owners (name, email, password_hash) VALUES ('O','o@x.com','h')").run();
  db.prepare('INSERT INTO properties (owner_id, name, status) VALUES (1,?,?)').run(propertyName, status);
}

test('monthly mortgage total sums every mortgage on one property (multiple loans, same property)', () => {
  const db = openDatabase(':memory:');
  baseOwnerAndProperty(db);
  db.prepare("INSERT INTO mortgages (property_id, lender, original_amount_cents, current_principal_cents, monthly_payment_cents) VALUES (1,'First Bank',20000000,18000000,150000)").run();
  db.prepare("INSERT INTO mortgages (property_id, lender, original_amount_cents, current_principal_cents, monthly_payment_cents) VALUES (1,'HELOC Co',5000000,4000000,40000)").run();
  const totals = computePortfolioTotals(db, 1, {});
  assert.equal(totals.monthlyMortgageTotalCents, 190000, 'both loans on the same property must be summed together');
  assert.equal(totals.monthlyMortgageTotalIsComplete, true);
  assert.equal(totals.mortgagesMissingPaymentCount, 0);
});

test('monthly mortgage total sums across multiple properties', () => {
  const db = openDatabase(':memory:');
  baseOwnerAndProperty(db, 'A');
  db.prepare("INSERT INTO properties (owner_id, name, status) VALUES (1,'B','active')").run();
  db.prepare("INSERT INTO mortgages (property_id, lender, original_amount_cents, current_principal_cents, monthly_payment_cents) VALUES (1,'Bank A',20000000,18000000,150000)").run();
  db.prepare("INSERT INTO mortgages (property_id, lender, original_amount_cents, current_principal_cents, monthly_payment_cents) VALUES (2,'Bank B',10000000,9000000,90000)").run();
  const totals = computePortfolioTotals(db, 1, {});
  assert.equal(totals.monthlyMortgageTotalCents, 240000);
});

test('a mortgage on an archived property is excluded from the monthly mortgage total', () => {
  const db = openDatabase(':memory:');
  baseOwnerAndProperty(db, 'Active Prop', 'active');
  db.prepare("INSERT INTO properties (owner_id, name, status, archived_at) VALUES (1,'Old Prop','archived', datetime('now'))").run();
  db.prepare("INSERT INTO mortgages (property_id, lender, original_amount_cents, current_principal_cents, monthly_payment_cents) VALUES (1,'Bank A',20000000,18000000,150000)").run();
  db.prepare("INSERT INTO mortgages (property_id, lender, original_amount_cents, current_principal_cents, monthly_payment_cents) VALUES (2,'Bank B (archived)',10000000,9000000,90000)").run();
  const totals = computePortfolioTotals(db, 1, {});
  assert.equal(totals.monthlyMortgageTotalCents, 150000, 'the archived property’s loan must not count toward the live total');
});

test('a mortgage missing its monthly payment amount is excluded from the sum and flags the total incomplete', () => {
  const db = openDatabase(':memory:');
  baseOwnerAndProperty(db);
  db.prepare("INSERT INTO mortgages (property_id, lender, original_amount_cents, current_principal_cents, monthly_payment_cents) VALUES (1,'Known Bank',20000000,18000000,150000)").run();
  db.prepare("INSERT INTO mortgages (property_id, lender, original_amount_cents, current_principal_cents, monthly_payment_cents) VALUES (1,'Unknown Bank',5000000,4000000,NULL)").run();
  const totals = computePortfolioTotals(db, 1, {});
  assert.equal(totals.monthlyMortgageTotalCents, 150000, 'only the known payment amount is summed — never silently treated as 0 and never blocking the known total');
  assert.equal(totals.monthlyMortgageTotalIsComplete, false, 'a missing payment amount must never be silently implied as complete');
  assert.equal(totals.mortgagesMissingPaymentCount, 1);
});

test('escrow is never added on top of monthly_payment_cents (no double counting)', () => {
  const db = openDatabase(':memory:');
  baseOwnerAndProperty(db);
  // escrow_cents is a breakdown OF monthly_payment_cents, not additive to it —
  // a large escrow value must not change the total at all.
  db.prepare("INSERT INTO mortgages (property_id, lender, original_amount_cents, current_principal_cents, monthly_payment_cents, escrow_cents) VALUES (1,'Bank',20000000,18000000,150000,60000)").run();
  const totals = computePortfolioTotals(db, 1, {});
  assert.equal(totals.monthlyMortgageTotalCents, 150000, 'escrow_cents must not be added on top of monthly_payment_cents');
});

test('a property with no mortgages at all counts as complete (nothing missing) with a zero total', () => {
  const db = openDatabase(':memory:');
  baseOwnerAndProperty(db);
  const totals = computePortfolioTotals(db, 1, {});
  assert.equal(totals.monthlyMortgageTotalCents, 0);
  assert.equal(totals.monthlyMortgageTotalIsComplete, true, 'zero loans is not the same as an incomplete/unknown total');
  assert.equal(totals.mortgagesMissingPaymentCount, 0);
});

test('an owner with zero active properties gets the field in the empty-portfolio response', () => {
  const db = openDatabase(':memory:');
  db.prepare("INSERT INTO owners (name, email, password_hash) VALUES ('O','o@x.com','h')").run();
  const totals = computePortfolioTotals(db, 1, {});
  assert.equal(totals.monthlyMortgageTotalCents, 0);
  assert.equal(totals.monthlyMortgageTotalIsComplete, true);
  assert.equal(totals.mortgagesMissingPaymentCount, 0);
  assert.equal(totals.propertyCount, 0);
});

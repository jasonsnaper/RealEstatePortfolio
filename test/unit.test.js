const { test } = require('node:test');
const assert = require('node:assert/strict');

const { dollarsToCents, centsToDisplay } = require('../server/lib/money');
const { addDays, addMonths, clampedDate, compareDates } = require('../server/lib/dates');
const { getChargeStatus, summarizeStatuses } = require('../server/lib/rentStatus');
const { computePeriodsToCharge, rentEffectiveOn, ensureChargesGenerated } = require('../server/lib/chargeGenerator');
const { openDatabase } = require('../server/db');

// ---- money ----
test('dollarsToCents parses common formats correctly', () => {
  assert.equal(dollarsToCents('1,250.50'), 125050);
  assert.equal(dollarsToCents('$1250'), 125000);
  assert.equal(dollarsToCents(1500), 150000);
  assert.equal(dollarsToCents('0.05'), 5);
  assert.equal(dollarsToCents(''), 0);
  assert.equal(dollarsToCents(null), 0);
});

test('dollarsToCents rejects garbage input instead of silently guessing', () => {
  assert.throws(() => dollarsToCents('not a number'));
  assert.throws(() => dollarsToCents('12.999'));
});

test('centsToDisplay formats with commas and two decimals', () => {
  assert.equal(centsToDisplay(125050), '$1,250.50');
  assert.equal(centsToDisplay(500), '$5.00');
  assert.equal(centsToDisplay(-500), '-$5.00');
});

// ---- dates ----
test('clampedDate clamps day-31 into February correctly (non-leap and leap years)', () => {
  assert.equal(clampedDate(2025, 2, 31), '2025-02-28');
  assert.equal(clampedDate(2024, 2, 31), '2024-02-29'); // leap year
  assert.equal(clampedDate(2026, 4, 31), '2026-04-30'); // April has 30 days
});

test('addDays crosses month and year boundaries correctly', () => {
  assert.equal(addDays('2026-01-30', 5), '2026-02-04');
  assert.equal(addDays('2026-12-29', 5), '2027-01-03');
});

test('addMonths clamps short months instead of overflowing', () => {
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2026-05-31', 1), '2026-06-30');
});

test('compareDates orders YYYY-MM-DD strings correctly', () => {
  assert.equal(compareDates('2026-01-01', '2026-01-02'), -1);
  assert.equal(compareDates('2026-02-01', '2026-01-31'), 1);
  assert.equal(compareDates('2026-01-01', '2026-01-01'), 0);
});

// ---- rent status: the five-state machine ----
function charge(overrides) {
  return { amount_cents: 150000, due_date: '2026-09-01', late_date: '2026-09-06', ...overrides };
}

test('status is "upcoming" before the due date with no payment', () => {
  const r = getChargeStatus(charge(), [], '2026-08-25');
  assert.equal(r.status, 'upcoming');
});

test('status is "due" on/after due date, before late date, no payment', () => {
  const r = getChargeStatus(charge(), [], '2026-09-03');
  assert.equal(r.status, 'due');
});

test('status is "partial" once some payment lands before the late date', () => {
  const payments = [{ status: 'completed', type: 'payment', amount_cents: 50000 }];
  const r = getChargeStatus(charge(), payments, '2026-09-03');
  assert.equal(r.status, 'partial');
  assert.equal(r.outstanding, 100000);
});

test('status is "late" once the late date passes with any balance remaining, even if partially paid', () => {
  const payments = [{ status: 'completed', type: 'payment', amount_cents: 50000 }];
  const r = getChargeStatus(charge(), payments, '2026-09-10');
  assert.equal(r.status, 'late'); // late beats partial, per spec priority
});

test('status is "late" with zero payment once the late date passes', () => {
  const r = getChargeStatus(charge(), [], '2026-09-10');
  assert.equal(r.status, 'late');
});

test('status is "paid" once net paid meets or exceeds the amount, regardless of date', () => {
  const payments = [{ status: 'completed', type: 'payment', amount_cents: 150000 }];
  const r = getChargeStatus(charge(), payments, '2026-09-10'); // even though it's past late_date
  assert.equal(r.status, 'paid');
});

test('multiple partial payments sum correctly toward "paid"', () => {
  const payments = [
    { status: 'completed', type: 'payment', amount_cents: 70000 },
    { status: 'completed', type: 'payment', amount_cents: 80000 },
  ];
  const r = getChargeStatus(charge(), payments, '2026-09-03');
  assert.equal(r.status, 'paid');
});

test('a refund against a paid charge correctly reopens a balance', () => {
  const payments = [
    { status: 'completed', type: 'payment', amount_cents: 150000 },
    { status: 'completed', type: 'refund', amount_cents: 150000 },
  ];
  const r = getChargeStatus(charge(), payments, '2026-09-03');
  assert.equal(r.status, 'due');
  assert.equal(r.outstanding, 150000);
});

test('a reversal removes previously-counted money the same way a refund does', () => {
  const payments = [
    { status: 'completed', type: 'payment', amount_cents: 150000 },
    { status: 'completed', type: 'reversal', amount_cents: 150000 },
  ];
  const r = getChargeStatus(charge(), payments, '2026-09-02');
  assert.equal(r.status, 'due');
});

test('a payment stuck in "processing" does not count as paid yet', () => {
  const payments = [{ status: 'processing', type: 'payment', amount_cents: 150000 }];
  const r = getChargeStatus(charge(), payments, '2026-09-02');
  assert.equal(r.status, 'due'); // not paid — processing isn't money in hand yet
});

test('a failed payment does not count toward the balance at all', () => {
  const payments = [{ status: 'failed', type: 'payment', amount_cents: 150000 }];
  const r = getChargeStatus(charge(), payments, '2026-09-02');
  assert.equal(r.status, 'due');
});

test('summarizeStatuses surfaces the worst status across multiple charges', () => {
  assert.equal(summarizeStatuses(['paid', 'paid', 'late']).status, 'late');
  assert.equal(summarizeStatuses(['paid', 'due']).status, 'due');
  assert.equal(summarizeStatuses(['paid', 'paid']).status, 'paid');
  assert.equal(summarizeStatuses([]).noCharges, true);
});

// ---- rent history: future rent changes must not touch past charges ----
test('rentEffectiveOn picks the most recent effective_date at or before the target date', () => {
  const history = [
    { rent_cents: 100000, effective_date: '2026-01-01' },
    { rent_cents: 120000, effective_date: '2026-06-01' },
  ];
  assert.equal(rentEffectiveOn(history, '2026-03-15'), 100000);
  assert.equal(rentEffectiveOn(history, '2026-06-01'), 120000);
  assert.equal(rentEffectiveOn(history, '2026-12-01'), 120000);
  assert.equal(rentEffectiveOn(history, '2025-12-31'), null); // before any known rent
});

test('computePeriodsToCharge generates one period per calendar month, due date clamped for short months', () => {
  const lease = { start_date: '2026-01-15', end_date: null, due_day: 31, late_after_days: 5 };
  const periods = computePeriodsToCharge(lease, '2026-03-01');
  assert.equal(periods.length, 3); // Jan, Feb, Mar
  assert.equal(periods[0].due_date, '2026-01-31');
  assert.equal(periods[1].due_date, '2026-02-28'); // clamped, not rolled into March
  assert.equal(periods[2].due_date, '2026-03-31');
});

test('ensureChargesGenerated is idempotent and never rewrites an existing charge', () => {
  const db = openDatabase(':memory:');
  db.prepare('INSERT INTO owners (name, email, password_hash) VALUES (?, ?, ?)').run('O', 'o@x.com', 'h');
  db.prepare('INSERT INTO properties (owner_id, name, timezone) VALUES (1, ?, ?)').run('P', 'America/Denver');
  db.prepare(`INSERT INTO leases (property_id, tenant_name, start_date, due_day, late_after_days)
              VALUES (1, 'T', '2026-06-01', 1, 5)`).run();
  db.prepare("INSERT INTO lease_rent_history (lease_id, rent_cents, effective_date) VALUES (1, 100000, '2026-06-01')").run();

  const created1 = ensureChargesGenerated(db, 1, 'America/Denver');
  assert.ok(created1.length >= 1);
  const chargesAfterFirst = db.prepare('SELECT * FROM charges WHERE lease_id = 1').all();

  // Simulate a future rent increase effective next month, then regenerate.
  db.prepare("INSERT INTO lease_rent_history (lease_id, rent_cents, effective_date) VALUES (1, 999999, '2099-01-01')").run();
  const created2 = ensureChargesGenerated(db, 1, 'America/Denver');
  assert.equal(created2.length, 0); // nothing new to create yet, since 2099 hasn't arrived

  const chargesAfterSecond = db.prepare('SELECT * FROM charges WHERE lease_id = 1').all();
  assert.deepEqual(chargesAfterFirst, chargesAfterSecond); // completely untouched
  for (const c of chargesAfterSecond) {
    assert.equal(c.amount_cents, 100000); // old rent preserved, not overwritten by the future rate
  }
});

test('changing rent for future periods leaves already-generated past charges at the old amount', () => {
  const db = openDatabase(':memory:');
  db.prepare('INSERT INTO owners (name, email, password_hash) VALUES (?, ?, ?)').run('O', 'o@x.com', 'h');
  db.prepare('INSERT INTO properties (owner_id, name, timezone) VALUES (1, ?, ?)').run('P', 'America/Denver');
  db.prepare(`INSERT INTO leases (property_id, tenant_name, start_date, due_day, late_after_days)
              VALUES (1, 'T', '2026-01-01', 1, 5)`).run();
  db.prepare("INSERT INTO lease_rent_history (lease_id, rent_cents, effective_date) VALUES (1, 100000, '2026-01-01')").run();

  // Pretend "today" is far enough in the future that Jan..Apr all exist by generating directly.
  const lease = db.prepare('SELECT * FROM leases WHERE id = 1').get();
  const periods = computePeriodsToCharge(lease, '2026-04-15');
  const insert = db.prepare(`INSERT INTO charges (lease_id, period_start, period_end, due_date, late_date, amount_cents)
                              VALUES (1, ?, ?, ?, ?, 100000)`);
  for (const p of periods) insert.run(p.period_start, p.period_end, p.due_date, p.late_date);

  // Now raise the rent starting May 1st and generate May's charge.
  db.prepare("INSERT INTO lease_rent_history (lease_id, rent_cents, effective_date) VALUES (1, 120000, '2026-05-01')").run();
  const rentHistory = db.prepare('SELECT rent_cents, effective_date FROM lease_rent_history WHERE lease_id = 1').all();
  const mayPeriod = computePeriodsToCharge(lease, '2026-05-15').find(p => p.period_start === '2026-05-01');
  const mayRent = rentEffectiveOn(rentHistory, mayPeriod.period_start);
  db.prepare(`INSERT INTO charges (lease_id, period_start, period_end, due_date, late_date, amount_cents)
              VALUES (1, ?, ?, ?, ?, ?)`).run(mayPeriod.period_start, mayPeriod.period_end, mayPeriod.due_date, mayPeriod.late_date, mayRent);

  const jan = db.prepare("SELECT amount_cents FROM charges WHERE lease_id=1 AND period_start='2026-01-01'").get();
  const may = db.prepare("SELECT amount_cents FROM charges WHERE lease_id=1 AND period_start='2026-05-01'").get();
  assert.equal(jan.amount_cents, 100000, 'January must stay at the old rent');
  assert.equal(may.amount_cents, 120000, 'May should reflect the new rent');
});

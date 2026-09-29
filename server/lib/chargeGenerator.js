const { clampedDate, addDays, addMonths, compareDates, todayInTimezone } = require('./dates');

/**
 * Whether a charge period genuinely falls within a lease's tenancy, for
 * display purposes. ensureChargesGenerated backfills every elapsed period
 * for an ACTIVE lease up through today, including when its start date is
 * long in the past. If an owner later ends that lease with a backdated end
 * date (recording a move-out that already happened), whatever was already
 * generated for periods after the real move-out is left behind in the
 * charges table — there was no way to know the end date before it was set.
 * Anything presenting "what this lease owes" should exclude those
 * post-move-out periods for an ended lease, since they represent rent for a
 * time when, per the owner's own end date, no tenancy existed. An active
 * lease (no end date yet) always passes.
 */
function periodWithinLeaseTerm(lease, periodStart) {
  if (lease.status !== 'ended' || !lease.end_date) return true;
  return compareDates(periodStart, lease.end_date) <= 0;
}

/** The rent in effect for a given calendar date, from the lease's effective-dated history. */
function rentEffectiveOn(rentHistoryRows, dateStr) {
  // rentHistoryRows: [{ rent_cents, effective_date }], any order.
  let applicable = null;
  for (const row of rentHistoryRows) {
    if (compareDates(row.effective_date, dateStr) <= 0) {
      if (!applicable || compareDates(row.effective_date, applicable.effective_date) > 0) {
        applicable = row;
      }
    }
  }
  return applicable ? applicable.rent_cents : null;
}

/**
 * Compute the list of monthly periods a lease should have a charge for, from
 * its start date through "asOfDate" (inclusive of the period asOfDate falls
 * in), stopping at the lease end date if it has already ended.
 *
 * Each period is a calendar month. due_date is the lease's due_day within
 * that period's month (clamped for short months). late_date is due_date +
 * late_after_days calendar days. Both stay fixed once a charge row is
 * created — we never recompute an existing charge's dates or amount.
 */
function computePeriodsToCharge(lease, asOfDate) {
  const periods = [];
  let periodStart = lease.start_date;
  const hardStop = lease.end_date && compareDates(lease.end_date, asOfDate) < 0
    ? lease.end_date
    : asOfDate;

  // Safety valve: never generate more than 600 periods (50 years) in one
  // pass, so a bad date can't spin this into an infinite loop.
  let guard = 0;
  while (compareDates(periodStart, hardStop) <= 0 && guard < 600) {
    guard += 1;
    const [y, m] = periodStart.split('-').map(Number);
    const periodEnd = addDays(addMonths(`${y}-${String(m).padStart(2, '0')}-01`, 1), -1);
    const dueDate = clampedDate(y, m, lease.due_day);
    const lateDate = addDays(dueDate, lease.late_after_days);
    periods.push({ period_start: periodStart, period_end: periodEnd, due_date: dueDate, late_date: lateDate });
    periodStart = addMonths(periodStart.slice(0, 8) + '01', 1);
  }
  return periods;
}

/**
 * Ensure charge rows exist for every elapsed period of an active lease, up
 * through "today" in the property's timezone. Idempotent: periods that
 * already have a charge (unique on lease_id + period_start) are skipped, and
 * existing charges are never modified — this is what makes "change future
 * rent without touching past bills" true by construction, not by convention.
 *
 * In production this should also run on a daily schedule (see README) so
 * charges exist even if nobody opens the app that day; for now it also runs
 * on-demand whenever a lease or the dashboard is loaded.
 */
function ensureChargesGenerated(db, leaseId, timezone) {
  const lease = db.prepare('SELECT * FROM leases WHERE id = ?').get(leaseId);
  if (!lease || lease.status !== 'active') return [];

  const today = todayInTimezone(timezone || 'America/Denver');
  const periods = computePeriodsToCharge(lease, today);
  const rentHistory = db.prepare('SELECT rent_cents, effective_date FROM lease_rent_history WHERE lease_id = ?').all(leaseId);

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO charges (lease_id, period_start, period_end, due_date, late_date, amount_cents)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const created = [];
  for (const period of periods) {
    const rentCents = rentEffectiveOn(rentHistory, period.period_start);
    if (rentCents === null) continue; // no rent was in effect yet for this period
    const result = insertStmt.run(leaseId, period.period_start, period.period_end, period.due_date, period.late_date, rentCents);
    if (result.changes > 0) created.push(period.period_start);
  }
  return created;
}

/**
 * Create (idempotently) the charge for the NEXT period after the latest one
 * that already exists for this lease — i.e. lets a renter pay next month's
 * rent before that period has even started, rather than waiting for
 * ensureChargesGenerated's normal "up through today" schedule to reach it.
 *
 * Returns the new (or already-existing) charge row, or null if there's
 * nothing sensible to advance to: the lease isn't active, the next period
 * would start after the lease's end date, or rent isn't yet in effect for
 * that period (e.g. a lease with no rent history at all, which shouldn't
 * happen in practice but is checked rather than assumed).
 *
 * Deliberately reuses the exact same INSERT OR IGNORE + unique-constraint
 * pattern as ensureChargesGenerated, so calling this and then a normal
 * "generate up through today" pass later can never create two charges for
 * the same period or disagree about one that already exists.
 */
function ensureNextPeriodCharge(db, leaseId) {
  const lease = db.prepare('SELECT * FROM leases WHERE id = ?').get(leaseId);
  if (!lease || lease.status !== 'active') return null;

  const latest = db.prepare('SELECT * FROM charges WHERE lease_id = ? ORDER BY period_start DESC LIMIT 1').get(leaseId);
  const today = todayInTimezone(
    (db.prepare('SELECT timezone FROM properties WHERE id = ?').get(lease.property_id) || {}).timezone || 'America/Denver'
  );
  // Advance from whichever is later: the period after the latest existing
  // charge, or the period containing today (covers a lease with no charges
  // yet at all — advancing should still mean "the period after this one").
  const basisStart = latest ? latest.period_start : today;
  const [y, m] = basisStart.split('-').map(Number);
  const nextPeriodStart = addMonths(`${y}-${String(m).padStart(2, '0')}-01`, 1);

  if (lease.end_date && compareDates(nextPeriodStart, lease.end_date) > 0) return null;

  const periodEnd = addDays(addMonths(nextPeriodStart.slice(0, 8) + '01', 1), -1);
  const dueDate = clampedDate(Number(nextPeriodStart.slice(0, 4)), Number(nextPeriodStart.slice(5, 7)), lease.due_day);
  const lateDate = addDays(dueDate, lease.late_after_days);

  const rentHistory = db.prepare('SELECT rent_cents, effective_date FROM lease_rent_history WHERE lease_id = ?').all(leaseId);
  const rentCents = rentEffectiveOn(rentHistory, nextPeriodStart);
  if (rentCents === null) return null;

  db.prepare(`
    INSERT OR IGNORE INTO charges (lease_id, period_start, period_end, due_date, late_date, amount_cents)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(leaseId, nextPeriodStart, periodEnd, dueDate, lateDate, rentCents);

  return db.prepare('SELECT * FROM charges WHERE lease_id = ? AND period_start = ?').get(leaseId, nextPeriodStart);
}

module.exports = { rentEffectiveOn, computePeriodsToCharge, ensureChargesGenerated, ensureNextPeriodCharge, periodWithinLeaseTerm };

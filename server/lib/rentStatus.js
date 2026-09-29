const { sumCents } = require('./money');
const { compareDates } = require('./dates');

/**
 * Net amount paid toward a charge: completed payments minus refunds/reversals
 * allocated to it. Credits count as payments. Failed/processing payments do
 * NOT count yet — money isn't real until it's completed.
 */
function netPaidForCharge(payments) {
  let net = 0;
  for (const p of payments) {
    if (p.status !== 'completed') continue;
    if (p.type === 'payment' || p.type === 'credit') net += p.amount_cents;
    else if (p.type === 'refund' || p.type === 'reversal') net -= p.amount_cents;
  }
  return net;
}

/**
 * Derive a charge's status from its own fields, its payments, and "today" —
 * never from a manually-toggled flag. This is the single source of truth
 * used by the dashboard, the property page, and the tenant portal alike.
 *
 * Priority order (matches the spec): paid > late > partial > due > upcoming.
 * A charge counts as "late" once the late date has passed AND a balance
 * remains, even if it's partially paid — late overrides partial.
 */
function getChargeStatus(charge, payments, todayStr) {
  const netPaid = netPaidForCharge(payments);
  const outstanding = charge.amount_cents - netPaid;

  if (outstanding <= 0) {
    return { status: 'paid', netPaid, outstanding: 0 };
  }
  if (compareDates(todayStr, charge.late_date) >= 0) {
    return { status: 'late', netPaid, outstanding };
  }
  if (netPaid > 0) {
    return { status: 'partial', netPaid, outstanding };
  }
  if (compareDates(todayStr, charge.due_date) >= 0) {
    return { status: 'due', netPaid, outstanding };
  }
  return { status: 'upcoming', netPaid, outstanding };
}

/** Human labels + a semantic color key the frontend maps to the status palette. */
const STATUS_META = {
  upcoming: { label: 'Upcoming', color: 'slate' },
  due: { label: 'Due', color: 'amber' },
  partial: { label: 'Partially paid', color: 'blue' },
  paid: { label: 'Paid', color: 'green' },
  late: { label: 'Late', color: 'red' },
};

/**
 * Roll several charge statuses up into one status for a card/summary view.
 * Priority: late > due > partial > upcoming > paid (worst news wins, so a
 * property with one late period and one paid period shows as "late").
 * Returns 'paid' (nothing owed) if there are no charges at all yet, with a
 * separate `noCharges` flag so the UI can say "no rent configured yet"
 * instead of implying everything is fine.
 */
function summarizeStatuses(statuses) {
  if (statuses.length === 0) return { status: 'paid', noCharges: true };
  const priority = ['late', 'due', 'partial', 'upcoming', 'paid'];
  for (const p of priority) {
    if (statuses.includes(p)) return { status: p, noCharges: false };
  }
  return { status: 'paid', noCharges: false };
}

module.exports = { netPaidForCharge, getChargeStatus, STATUS_META, summarizeStatuses };

const { sumCents } = require('./money');
const { getChargeStatus } = require('./rentStatus');
const { todayInTimezone } = require('./dates');
const { rentEffectiveOn } = require('./chargeGenerator');

/**
 * Definitions used throughout this module (also documented in README.md —
 * keep both in sync if these change):
 *
 *   Estimated equity     = latest estimated value - outstanding mortgage principal.
 *   Scheduled rent        = current rent (today's effective rate) summed across
 *                            active leases. A run-rate, not tied to the date range.
 *   Rent collected        = completed rent payments minus refunds/reversals,
 *                            dated within the selected period. Source of truth:
 *                            the `payments` table (the rent subledger), never
 *                            the general `transactions` ledger, so this always
 *                            matches the per-charge status shown elsewhere.
 *   Overdue rent           = outstanding balance on charges currently "late",
 *                            as of today — a snapshot, not a period sum.
 *   Operating expenses     = `transactions` rows flagged is_operating, direction
 *                            out, dated within the period. Mortgage payments and
 *                            capital improvements are excluded by construction
 *                            (they're flagged is_debt_service / is_capital).
 *   Net operating income   = rent collected - operating expenses, for the period.
 *                            Deliberately excludes mortgage debt service and capex.
 *   Cash flow              = every transaction in the period, in minus out,
 *                            INCLUDING mortgage payments — unlike NOI. This is
 *                            the one number that answers "did my bank balance
 *                            actually go up or down."
 *   Security deposits held = leases.deposit_held_cents, summed for active
 *                            leases. Always separate from rent income.
 *   Cash held               = bank_accounts.manual_balance_cents, summed ONCE
 *                            PER DISTINCT ACCOUNT that's linked to at least one
 *                            active property — never once per property, so a
 *                            bank account shared by three properties is only
 *                            counted a single time.
 *   Monthly mortgage total = mortgages.monthly_payment_cents, summed across
 *                            every loan on an active property (a property can
 *                            carry more than one loan). This is the CURRENT
 *                            scheduled obligation, not a principal balance and
 *                            not transactions posted during the selected date
 *                            range — it doesn't change when the date range
 *                            does. Escrow: the Add/Edit Loan form asks for
 *                            "Monthly payment" and "Escrow" as two fields, but
 *                            escrow_cents is a breakdown OF monthly_payment_cents
 *                            (how much of that payment is escrow), not an amount
 *                            on top of it — see the mortgage-payment recording
 *                            endpoint in financials.js, which likewise treats
 *                            "the whole payment" as already inclusive of
 *                            escrow/interest and principal as a portion carved
 *                            out of it. So this sum uses monthly_payment_cents
 *                            alone; adding escrow_cents on top would double
 *                            count it. If any mortgage on an active property is
 *                            missing a monthly payment amount, that loan is
 *                            excluded from the sum and monthlyMortgageTotalIsComplete
 *                            is set to false, so callers can show the total as
 *                            a floor rather than implying it's exhaustive.
 */

function currentRentForLease(db, leaseId, timezone) {
  const history = db.prepare('SELECT rent_cents, effective_date FROM lease_rent_history WHERE lease_id = ?').all(leaseId);
  const today = todayInTimezone(timezone);
  return rentEffectiveOn(history, today) || 0;
}

function computePortfolioTotals(db, ownerId, { start, end } = {}) {
  const properties = db.prepare("SELECT * FROM properties WHERE owner_id = ? AND status = 'active'").all(ownerId);
  const propertyIds = properties.map((p) => p.id);
  const timezoneByPropertyId = new Map(properties.map((p) => [p.id, p.timezone || 'America/Denver']));

  // The data model already allows each property its own timezone, so there is
  // no single "portfolio timezone" to compute "today" against once an owner
  // has properties in different zones. Every per-lease/per-charge calculation
  // below (scheduled rent, overdue rent) uses THAT property's own timezone,
  // via timezoneByPropertyId — this reference is used only to pick a default
  // date-range boundary when the caller didn't supply one explicitly (a
  // portfolio-wide report needs one shared window). We anchor that default to
  // the first active property's timezone, which is exact for the common
  // single-timezone portfolio and a reasonable, clearly-documented choice
  // otherwise; a caller who cares can always pass explicit start/end.
  const referenceTimezone = properties[0] ? (properties[0].timezone || 'America/Denver') : 'America/Denver';
  const today = todayInTimezone(referenceTimezone);
  const periodStart = start || today.slice(0, 8) + '01';
  const periodEnd = end || today;

  if (propertyIds.length === 0) {
    return emptyTotals(periodStart, periodEnd);
  }
  const placeholders = propertyIds.map(() => '?').join(',');

  // --- Value / equity ---
  let estimatedValueCents = 0;
  for (const p of properties) {
    const latest = db.prepare('SELECT value_cents FROM property_valuations WHERE property_id = ? ORDER BY valuation_date DESC, id DESC LIMIT 1').get(p.id);
    if (latest) estimatedValueCents += latest.value_cents;
  }
  const mortgagePrincipalRow = db.prepare(`SELECT COALESCE(SUM(current_principal_cents),0) AS total FROM mortgages WHERE property_id IN (${placeholders})`).get(...propertyIds);
  const outstandingPrincipalCents = mortgagePrincipalRow.total;
  const estimatedEquityCents = estimatedValueCents - outstandingPrincipalCents;

  // --- Monthly mortgage total (see the definitions block above re: escrow) ---
  const mortgageRows = db.prepare(`SELECT monthly_payment_cents FROM mortgages WHERE property_id IN (${placeholders})`).all(...propertyIds);
  const monthlyMortgageTotalCents = sumCents(
    mortgageRows.filter((m) => m.monthly_payment_cents != null).map((m) => m.monthly_payment_cents)
  );
  const mortgagesMissingPaymentCount = mortgageRows.filter((m) => m.monthly_payment_cents == null).length;
  const monthlyMortgageTotalIsComplete = mortgagesMissingPaymentCount === 0;

  // --- Leases / occupancy / scheduled rent / deposits ---
  const activeLeases = db.prepare(`SELECT * FROM leases WHERE property_id IN (${placeholders}) AND status = 'active'`).all(...propertyIds);
  const occupiedPropertyIds = new Set(activeLeases.map((l) => l.property_id));
  const scheduledRentCents = sumCents(activeLeases.map((l) => currentRentForLease(db, l.id, timezoneByPropertyId.get(l.property_id))));
  const securityDepositsHeldCents = sumCents(activeLeases.map((l) => l.deposit_held_cents));
  const occupancyRate = properties.length > 0 ? occupiedPropertyIds.size / properties.length : 0;

  // --- Rent collected (period) + overdue rent (as of today), from the payments subledger ---
  let rentCollectedCents = 0;
  let overdueRentCents = 0;
  for (const lease of activeLeases) {
    const leaseToday = todayInTimezone(timezoneByPropertyId.get(lease.property_id));
    const charges = db.prepare('SELECT * FROM charges WHERE lease_id = ?').all(lease.id);
    for (const charge of charges) {
      const payments = db.prepare('SELECT * FROM payments WHERE charge_id = ?').all(charge.id);
      const { status, outstanding } = getChargeStatus(charge, payments, leaseToday);
      if (status === 'late') overdueRentCents += outstanding;

      for (const pay of payments) {
        if (pay.status !== 'completed') continue;
        if (pay.paid_at < periodStart || pay.paid_at > periodEnd) continue;
        if (pay.type === 'payment' || pay.type === 'credit') rentCollectedCents += pay.amount_cents;
        else if (pay.type === 'refund' || pay.type === 'reversal') rentCollectedCents -= pay.amount_cents;
      }
    }
  }

  // --- Operating expenses / NOI / cash flow, from the transactions ledger ---
  const txnsInPeriod = db.prepare(`
    SELECT * FROM transactions WHERE property_id IN (${placeholders}) AND txn_date >= ? AND txn_date <= ? AND status = 'completed'
  `).all(...propertyIds, periodStart, periodEnd);

  const operatingExpensesCents = sumCents(
    txnsInPeriod.filter((t) => t.is_operating && t.direction === 'out').map((t) => t.amount_cents)
  );
  const netOperatingIncomeCents = rentCollectedCents - operatingExpensesCents;
  const cashInCents = sumCents(txnsInPeriod.filter((t) => t.direction === 'in').map((t) => t.amount_cents));
  const cashOutCents = sumCents(txnsInPeriod.filter((t) => t.direction === 'out').map((t) => t.amount_cents));
  const cashFlowCents = cashInCents - cashOutCents;

  // --- Cash held: dedup shared bank accounts so a shared account is never summed twice ---
  const linkedAccountRows = db.prepare(`
    SELECT DISTINCT ba.id, ba.manual_balance_cents, ba.manual_as_of, ba.nickname
    FROM bank_accounts ba
    JOIN property_bank_accounts pba ON pba.bank_account_id = ba.id
    WHERE pba.property_id IN (${placeholders}) AND ba.owner_id = ?
  `).all(...propertyIds, ownerId);
  const cashHeldCents = sumCents(linkedAccountRows.map((a) => a.manual_balance_cents));

  return {
    period: { start: periodStart, end: periodEnd },
    estimatedValueCents,
    outstandingPrincipalCents,
    estimatedEquityCents,
    monthlyMortgageTotalCents,
    monthlyMortgageTotalIsComplete,
    mortgagesMissingPaymentCount,
    scheduledRentCents,
    rentCollectedCents,
    overdueRentCents,
    securityDepositsHeldCents,
    operatingExpensesCents,
    netOperatingIncomeCents,
    cashFlowCents,
    occupancyRate,
    cashHeldCents,
    propertyCount: properties.length,
    occupiedCount: occupiedPropertyIds.size,
    linkedAccountCount: linkedAccountRows.length,
  };
}

function emptyTotals(periodStart, periodEnd) {
  return {
    period: { start: periodStart, end: periodEnd },
    estimatedValueCents: 0, outstandingPrincipalCents: 0, estimatedEquityCents: 0,
    monthlyMortgageTotalCents: 0, monthlyMortgageTotalIsComplete: true, mortgagesMissingPaymentCount: 0,
    scheduledRentCents: 0, rentCollectedCents: 0, overdueRentCents: 0,
    securityDepositsHeldCents: 0, operatingExpensesCents: 0, netOperatingIncomeCents: 0,
    cashFlowCents: 0, occupancyRate: 0, cashHeldCents: 0,
    propertyCount: 0, occupiedCount: 0, linkedAccountCount: 0,
  };
}

module.exports = { computePortfolioTotals, currentRentForLease };

// Single chokepoint for turning "money changed hands for a charge" into
// database rows, used by BOTH the owner's manual "record a payment" route
// and the automated payment-provider webhook handler. Routing both through
// here means a card payment collected via the tenant portal and a check
// the owner logs by hand are accounted for identically — same tables, same
// rules, no chance of the two paths drifting apart or double-counting.

function recordChargePayment(db, { chargeId, propertyId, leaseId, amountCents, type, method, paidAt, notes, externalRef }) {
  const validTypes = ['payment', 'refund', 'reversal', 'credit'];
  const paymentType = validTypes.includes(type) ? type : 'payment';
  const date = paidAt || new Date().toISOString().slice(0, 10);

  const result = db.prepare(`
    INSERT INTO payments (lease_id, charge_id, amount_cents, type, method, status, paid_at, notes, external_ref)
    VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, ?)
  `).run(leaseId, chargeId, amountCents, paymentType, method || 'cash', date, notes || null, externalRef || null);

  const direction = (paymentType === 'payment' || paymentType === 'credit') ? 'in' : 'out';
  db.prepare(`
    INSERT INTO transactions (property_id, type, direction, amount_cents, category, description, txn_date, is_operating, related_payment_id)
    VALUES (?, 'rent_payment', ?, ?, 'rent', ?, ?, 1, ?)
  `).run(propertyId, direction, amountCents, notes || `Rent ${paymentType}`, date, result.lastInsertRowid);

  return result.lastInsertRowid;
}

module.exports = { recordChargePayment };

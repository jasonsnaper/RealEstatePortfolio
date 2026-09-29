const { apiError, sendJson } = require('../lib/router');
const { requireAuth, getOwnedPropertyOr404, logAudit } = require('../lib/helpers');
const { dollarsToCents } = require('../lib/money');
const { ensureChargesGenerated } = require('../lib/chargeGenerator');
const { getChargeStatus } = require('../lib/rentStatus');
const { todayInTimezone } = require('../lib/dates');
const { recordChargePayment } = require('../lib/paymentAllocation');

function serializeCharge(db, charge, today) {
  const payments = db.prepare('SELECT * FROM payments WHERE charge_id = ? ORDER BY paid_at').all(charge.id);
  const result = getChargeStatus(charge, payments, today);
  return {
    id: charge.id,
    periodStart: charge.period_start,
    periodEnd: charge.period_end,
    dueDate: charge.due_date,
    lateDate: charge.late_date,
    amountCents: charge.amount_cents,
    paidCents: result.netPaid,
    outstandingCents: result.outstanding,
    status: result.status,
    payments: payments.map((p) => ({
      id: p.id, amountCents: p.amount_cents, type: p.type, method: p.method,
      status: p.status, paidAt: p.paid_at, notes: p.notes,
    })),
  };
}

function serializeLease(db, lease, timezone) {
  const history = db.prepare('SELECT * FROM lease_rent_history WHERE lease_id = ? ORDER BY effective_date').all(lease.id);
  const today = todayInTimezone(timezone);
  const charges = db.prepare('SELECT * FROM charges WHERE lease_id = ? ORDER BY period_start DESC').all(lease.id);
  const currentRent = [...history].reverse().find((h) => h.effective_date <= today);
  return {
    id: lease.id,
    tenantName: lease.tenant_name,
    coTenantName: lease.co_tenant_name,
    tenantEmail: lease.tenant_email,
    tenantPhone: lease.tenant_phone,
    emergencyContact: lease.emergency_contact,
    startDate: lease.start_date,
    endDate: lease.end_date,
    currentRentCents: currentRent ? currentRent.rent_cents : null,
    rentHistory: history.map((h) => ({ rentCents: h.rent_cents, effectiveDate: h.effective_date })),
    depositRequiredCents: lease.deposit_required_cents,
    depositHeldCents: lease.deposit_held_cents,
    depositDisposition: lease.deposit_disposition,
    billingFrequency: lease.billing_frequency,
    dueDay: lease.due_day,
    lateAfterDays: lease.late_after_days,
    lateFeeEnabled: !!lease.late_fee_enabled,
    lateFeeType: lease.late_fee_type,
    lateFeeAmountCents: lease.late_fee_amount_cents,
    status: lease.status,
    ownerNotes: lease.owner_notes,
    charges: charges.map((c) => serializeCharge(db, c, today)),
  };
}

function registerLeaseRoutes(router, { db }) {
  // All leases for a property, active first — includes ended leases so
  // "historical tenants" is just this same endpoint with status=ended.
  router.get('/api/properties/:id/leases', async (req, res) => {
    const owner = requireAuth(db, req);
    const property = getOwnedPropertyOr404(db, owner.id, req.params.id);
    let rows = db.prepare('SELECT * FROM leases WHERE property_id = ? ORDER BY start_date DESC').all(property.id);
    if (req.query.status) rows = rows.filter((l) => l.status === req.query.status);
    for (const lease of rows) {
      if (lease.status === 'active') ensureChargesGenerated(db, lease.id, property.timezone);
    }
    sendJson(res, 200, rows.map((l) => serializeLease(db, l, property.timezone)));
  });

  router.post('/api/properties/:id/leases', async (req, res) => {
    const owner = requireAuth(db, req);
    const property = getOwnedPropertyOr404(db, owner.id, req.params.id);
    const b = req.body;
    if (!b.tenantName || !b.startDate || !b.rent) {
      throw apiError(400, 'Tenant name, start date, and rent are required');
    }
    const activeExisting = db.prepare("SELECT id FROM leases WHERE property_id = ? AND status = 'active'").get(property.id);
    if (activeExisting) throw apiError(409, 'This property already has an active lease. End it before starting a new one.');

    const unit = db.prepare('SELECT id FROM units WHERE property_id = ? LIMIT 1').get(property.id);

    const result = db.prepare(`
      INSERT INTO leases (property_id, unit_id, tenant_name, co_tenant_name, tenant_email, tenant_phone, emergency_contact,
                           start_date, end_date, deposit_required_cents, deposit_held_cents, billing_frequency,
                           due_day, late_after_days, late_fee_enabled, late_fee_type, late_fee_amount_cents, owner_notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      property.id, unit ? unit.id : null, b.tenantName.trim(), b.coTenantName || null, b.tenantEmail || null,
      b.tenantPhone || null, b.emergencyContact || null, b.startDate, b.endDate || null,
      dollarsToCents(b.depositRequired || 0), dollarsToCents(b.depositHeld || 0),
      b.billingFrequency || 'monthly', b.dueDay || 1, b.lateAfterDays ?? 5,
      b.lateFeeEnabled ? 1 : 0, b.lateFeeType || 'flat', b.lateFeeAmount ? dollarsToCents(b.lateFeeAmount) : 0,
      b.ownerNotes || null
    );
    const leaseId = result.lastInsertRowid;
    db.prepare('INSERT INTO lease_rent_history (lease_id, rent_cents, effective_date) VALUES (?, ?, ?)')
      .run(leaseId, dollarsToCents(b.rent), b.startDate);

    ensureChargesGenerated(db, leaseId, property.timezone);
    logAudit(db, { actorType: 'owner', actorId: owner.id, action: 'create', entityType: 'lease', entityId: leaseId, after: b });

    const lease = db.prepare('SELECT * FROM leases WHERE id = ?').get(leaseId);
    sendJson(res, 201, serializeLease(db, lease, property.timezone));
  });

  function getOwnedLeaseOr404(ownerId, leaseId) {
    const lease = db.prepare(`
      SELECT l.*, p.timezone AS property_timezone, p.owner_id FROM leases l
      JOIN properties p ON p.id = l.property_id WHERE l.id = ? AND p.owner_id = ?
    `).get(leaseId, ownerId);
    if (!lease) throw apiError(404, 'Lease not found');
    return lease;
  }

  router.get('/api/leases/:id', async (req, res) => {
    const owner = requireAuth(db, req);
    const lease = getOwnedLeaseOr404(owner.id, req.params.id);
    ensureChargesGenerated(db, lease.id, lease.property_timezone);
    sendJson(res, 200, serializeLease(db, lease, lease.property_timezone));
  });

  router.put('/api/leases/:id', async (req, res) => {
    const owner = requireAuth(db, req);
    const before = getOwnedLeaseOr404(owner.id, req.params.id);
    const b = req.body;
    db.prepare(`
      UPDATE leases SET tenant_name=?, co_tenant_name=?, tenant_email=?, tenant_phone=?, emergency_contact=?,
             deposit_required_cents=?, deposit_held_cents=?, due_day=?, late_after_days=?,
             late_fee_enabled=?, late_fee_type=?, late_fee_amount_cents=?, owner_notes=?
      WHERE id=?
    `).run(
      b.tenantName ?? before.tenant_name, b.coTenantName ?? before.co_tenant_name,
      b.tenantEmail ?? before.tenant_email, b.tenantPhone ?? before.tenant_phone,
      b.emergencyContact ?? before.emergency_contact,
      b.depositRequired != null ? dollarsToCents(b.depositRequired) : before.deposit_required_cents,
      b.depositHeld != null ? dollarsToCents(b.depositHeld) : before.deposit_held_cents,
      b.dueDay ?? before.due_day, b.lateAfterDays ?? before.late_after_days,
      b.lateFeeEnabled != null ? (b.lateFeeEnabled ? 1 : 0) : before.late_fee_enabled,
      b.lateFeeType ?? before.late_fee_type,
      b.lateFeeAmount != null ? dollarsToCents(b.lateFeeAmount) : before.late_fee_amount_cents,
      b.ownerNotes ?? before.owner_notes,
      before.id
    );
    logAudit(db, { actorType: 'owner', actorId: owner.id, action: 'update', entityType: 'lease', entityId: before.id, before, after: b });
    sendJson(res, 200, serializeLease(db, db.prepare('SELECT * FROM leases WHERE id = ?').get(before.id), before.property_timezone));
  });

  // Changing rent never edits history rows or existing charges — it only adds a
  // new effective-dated rent row, so every bill already sent keeps its original amount.
  router.post('/api/leases/:id/rent-change', async (req, res) => {
    const owner = requireAuth(db, req);
    const lease = getOwnedLeaseOr404(owner.id, req.params.id);
    const { rent, effectiveDate } = req.body;
    if (!rent || !effectiveDate) throw apiError(400, 'New rent amount and effective date are required');

    db.prepare('INSERT INTO lease_rent_history (lease_id, rent_cents, effective_date) VALUES (?, ?, ?)')
      .run(lease.id, dollarsToCents(rent), effectiveDate);
    logAudit(db, { actorType: 'owner', actorId: owner.id, action: 'rent_change', entityType: 'lease', entityId: lease.id, after: { rent, effectiveDate } });

    ensureChargesGenerated(db, lease.id, lease.property_timezone);
    sendJson(res, 200, serializeLease(db, db.prepare('SELECT * FROM leases WHERE id = ?').get(lease.id), lease.property_timezone));
  });

  // Ending a lease preserves it (and all its charges/payments/documents) exactly
  // as-is — it's a status flip, never a delete, so tenant history survives intact.
  router.post('/api/leases/:id/end', async (req, res) => {
    const owner = requireAuth(db, req);
    const lease = getOwnedLeaseOr404(owner.id, req.params.id);
    const { endDate, depositDisposition } = req.body;
    db.prepare(`
      UPDATE leases SET status='ended', end_date=?, deposit_disposition=?, ended_at=datetime('now') WHERE id=?
    `).run(endDate || todayInTimezone(lease.property_timezone), depositDisposition || null, lease.id);
    logAudit(db, { actorType: 'owner', actorId: owner.id, action: 'end_lease', entityType: 'lease', entityId: lease.id, after: req.body });
    sendJson(res, 200, { ok: true });
  });

  // Recording a payment/refund/reversal against a specific charge. Also mirrors
  // a matching row into the general transactions ledger (see server/lib/portfolio.js
  // for why: transactions is the single source for cash flow and NOI, payments is
  // the single source for per-charge status and the rent-collected KPI).
  router.post('/api/charges/:id/payments', async (req, res) => {
    const owner = requireAuth(db, req);
    const charge = db.prepare(`
      SELECT c.*, l.property_id, p.timezone FROM charges c
      JOIN leases l ON l.id = c.lease_id JOIN properties p ON p.id = l.property_id
      WHERE c.id = ? AND p.owner_id = ?
    `).get(req.params.id, owner.id);
    if (!charge) throw apiError(404, 'Charge not found');

    const { amount, type, method, paidAt, notes } = req.body;
    if (!amount) throw apiError(400, 'Payment amount is required');
    const amountCents = dollarsToCents(amount);

    const paymentId = recordChargePayment(db, {
      chargeId: charge.id, propertyId: charge.property_id, leaseId: charge.lease_id,
      amountCents, type, method: method || 'cash', paidAt, notes,
    });

    logAudit(db, { actorType: 'owner', actorId: owner.id, action: 'record_payment', entityType: 'payment', entityId: paymentId, after: req.body });

    const updatedCharge = db.prepare('SELECT * FROM charges WHERE id = ?').get(charge.id);
    sendJson(res, 201, serializeCharge(db, updatedCharge, todayInTimezone(charge.timezone)));
  });
}

module.exports = { registerLeaseRoutes, serializeLease, serializeCharge };

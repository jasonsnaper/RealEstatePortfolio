const { apiError, sendJson } = require('../lib/router');
const { requireRenterAuth } = require('../lib/renterAuth');
const { getRenterLeaseOr404, renterLeaseIds, documentsVisibleForLease } = require('../lib/renterAccess');
const { ensureChargesGenerated, ensureNextPeriodCharge, periodWithinLeaseTerm } = require('../lib/chargeGenerator');
const { getChargeStatus, summarizeStatuses } = require('../lib/rentStatus');
const { todayInTimezone } = require('../lib/dates');
const { dollarsToCents } = require('../lib/money');
const { createCheckoutSession, describeProvider } = require('../lib/paymentProvider');
const { getOrCreateActiveLinkForLease } = require('./paymentLinks');
const { saveBase64Image } = require('../lib/helpers');
const { serializeStatement } = require('../lib/statements');
const path = require('path');

const { UPLOADS_DIR } = require('../db');

// ---------------------------------------------------------------------------
// Same privacy rule as server/routes/tenantPortal.js (read that file's header
// first): every response here is built from an explicit field allowlist, and
// a renter only ever sees leases they are actually linked to via
// lease_renters — including ENDED leases, on purpose (see README's move-out/
// historical-access section). "Signed in" and "currently renting" are two
// different questions; this file only answers the first one on its own —
// every route re-checks lease ownership itself via getRenterLeaseOr404.
// ---------------------------------------------------------------------------

function safeCharge(db, charge, today) {
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
    payments: payments.map((p) => ({ amountCents: p.amount_cents, type: p.type, method: p.method, status: p.status, paidAt: p.paid_at })),
  };
}

function safeLease(lease) {
  return {
    id: lease.id,
    status: lease.status,
    startDate: lease.start_date,
    endDate: lease.end_date,
    tenantName: lease.tenant_name,
    coTenantName: lease.co_tenant_name,
    depositRequiredCents: lease.deposit_required_cents,
    depositHeldCents: lease.deposit_held_cents,
    depositDisposition: lease.status === 'ended' ? lease.deposit_disposition : null,
    dueDay: lease.due_day,
    lateAfterDays: lease.late_after_days,
    lateFeeEnabled: !!lease.late_fee_enabled,
    lateFeeType: lease.late_fee_type,
    lateFeeAmountCents: lease.late_fee_amount_cents,
    property: {
      id: lease.property_id,
      name: lease.property_name,
      address: { line1: lease.address_line1, line2: lease.address_line2, city: lease.city, state: lease.state, zip: lease.zip },
    },
  };
}

function registerRenterPortalRoutes(router, { db, appBaseUrl }) {
  // Overview list — the "pick a lease" screen when a renter has more than
  // one, and the source of the topbar's lease switcher when they have
  // exactly one too (so switching properties later needs no separate code path).
  router.get('/api/renter/leases', async (req, res) => {
    const renter = requireRenterAuth(db, req);
    const rows = db.prepare(`
      SELECT l.*, p.id AS property_id, p.name AS property_name, p.address_line1, p.address_line2, p.city, p.state, p.zip, p.timezone, lr.role
      FROM lease_renters lr JOIN leases l ON l.id = lr.lease_id JOIN properties p ON p.id = l.property_id
      WHERE lr.renter_id = ? ORDER BY (l.status = 'active') DESC, l.start_date DESC
    `).all(renter.id);
    const summaries = rows.map((lease) => {
      if (lease.status === 'active') ensureChargesGenerated(db, lease.id, lease.timezone);
      const today = todayInTimezone(lease.timezone);
      const charges = db.prepare('SELECT * FROM charges WHERE lease_id = ?').all(lease.id)
        .filter((c) => periodWithinLeaseTerm(lease, c.period_start));
      const statuses = charges.map((c) => {
        const payments = db.prepare('SELECT * FROM payments WHERE charge_id = ?').all(c.id);
        return getChargeStatus(c, payments, today).status;
      });
      const outstandingCents = charges.reduce((sum, c) => {
        const payments = db.prepare('SELECT * FROM payments WHERE charge_id = ?').all(c.id);
        return sum + getChargeStatus(c, payments, today).outstanding;
      }, 0);
      // Named rentStatus (never spread as bare `status`) so it can't collide
      // with safeLease's own `status` field, which is the LEASE's lifecycle
      // state (active/ended) — the same rentStatus-vs-status split
      // server/routes/properties.js uses for the owner-facing property list,
      // for the same reason. Losing the lease's own status here would make an
      // ended lease indistinguishable from an active one in the lease
      // switcher/list, which matters a lot for the historical-access story.
      return { ...safeLease(lease), role: lease.role, outstandingCents, rentStatus: summarizeStatuses(statuses).status };
    });
    sendJson(res, 200, summaries);
  });

  router.get('/api/renter/leases/:id', async (req, res) => {
    const renter = requireRenterAuth(db, req);
    const lease = getRenterLeaseOr404(db, renter.id, req.params.id);
    if (lease.status === 'active') ensureChargesGenerated(db, lease.id, lease.timezone);
    const today = todayInTimezone(lease.timezone);
    const history = db.prepare('SELECT rent_cents, effective_date FROM lease_rent_history WHERE lease_id = ? ORDER BY effective_date DESC LIMIT 1').get(lease.id);
    const charges = db.prepare('SELECT * FROM charges WHERE lease_id = ? ORDER BY period_start DESC').all(lease.id)
      .filter((c) => periodWithinLeaseTerm(lease, c.period_start));
    sendJson(res, 200, {
      ...safeLease(lease),
      currentRentCents: history ? history.rent_cents : null,
      charges: charges.map((c) => safeCharge(db, c, today)),
      provider: describeProvider(),
    });
  });

  router.get('/api/renter/leases/:id/documents', async (req, res) => {
    const renter = requireRenterAuth(db, req);
    const lease = getRenterLeaseOr404(db, renter.id, req.params.id);
    const docs = documentsVisibleForLease(db, renter.id, lease.id);
    sendJson(res, 200, docs.map((d) => ({ id: d.id, filename: d.filename, category: d.category, url: `/uploads/properties/${d.property_id}/documents/${d.file_path}` })));
  });

  // Only statements the owner has explicitly shared — generating one does
  // NOT make it visible here on its own (see server/routes/statements.js).
  router.get('/api/renter/leases/:id/statements', async (req, res) => {
    const renter = requireRenterAuth(db, req);
    const lease = getRenterLeaseOr404(db, renter.id, req.params.id);
    const rows = db.prepare('SELECT * FROM payment_statements WHERE lease_id = ? AND shared_with_renter = 1 ORDER BY created_at DESC').all(lease.id);
    sendJson(res, 200, rows.map((s) => ({ ...serializeStatement(s), url: `/uploads/properties/${lease.property_id}/statements/${s.file_path}` })));
  });

  router.get('/api/renter/leases/:id/maintenance', async (req, res) => {
    const renter = requireRenterAuth(db, req);
    const lease = getRenterLeaseOr404(db, renter.id, req.params.id);
    const rows = db.prepare('SELECT * FROM maintenance_requests WHERE lease_id = ? ORDER BY created_at DESC').all(lease.id);
    sendJson(res, 200, rows.map((r) => {
      const photos = db.prepare('SELECT * FROM maintenance_photos WHERE maintenance_request_id = ?').all(r.id);
      return {
        id: r.id, title: r.title, description: r.description, priority: r.priority, status: r.status,
        scheduledDate: r.scheduled_date, completedDate: r.completed_date, createdAt: r.created_at,
        photos: photos.map((p) => ({ url: `/uploads/properties/${lease.property_id}/maintenance/${p.file_path}` })),
      };
    }));
  });

  router.post('/api/renter/leases/:id/maintenance', async (req, res) => {
    const renter = requireRenterAuth(db, req);
    const lease = getRenterLeaseOr404(db, renter.id, req.params.id);
    if (lease.status !== 'active') throw apiError(409, 'This tenancy has ended — contact your landlord directly for anything further.');
    const { title, description, images } = req.body;
    if (!title || !title.trim()) throw apiError(400, 'Please describe what needs attention');
    const result = db.prepare(`
      INSERT INTO maintenance_requests (property_id, lease_id, title, description, priority, status, created_by)
      VALUES (?, ?, ?, ?, 'normal', 'open', 'tenant')
    `).run(lease.property_id, lease.id, title.trim(), description || null);
    if (Array.isArray(images) && images.length > 0) {
      const destDir = path.join(UPLOADS_DIR, 'properties', String(lease.property_id), 'maintenance');
      for (const dataUrl of images) {
        const filename = saveBase64Image(dataUrl, destDir, 'maint');
        db.prepare('INSERT INTO maintenance_photos (maintenance_request_id, file_path) VALUES (?, ?)').run(result.lastInsertRowid, filename);
      }
    }
    sendJson(res, 201, { id: result.lastInsertRowid, ok: true });
  });

  // Creates (idempotently) the charge for the period right after the latest
  // one on file, so a renter can pay next month before it's even due — see
  // chargeGenerator.ensureNextPeriodCharge for the exact rule.
  router.post('/api/renter/leases/:id/advance-charge', async (req, res) => {
    const renter = requireRenterAuth(db, req);
    const lease = getRenterLeaseOr404(db, renter.id, req.params.id);
    if (lease.status !== 'active') throw apiError(409, 'This tenancy has ended — there is nothing to pay ahead of.');
    ensureChargesGenerated(db, lease.id, lease.timezone);
    const charge = ensureNextPeriodCharge(db, lease.id);
    if (!charge) throw apiError(409, "There's no further period to pay ahead of — check with your landlord if you think this is wrong.");
    sendJson(res, 200, safeCharge(db, charge, todayInTimezone(lease.timezone)));
  });

  // Same idea as the token-based tenant portal's checkout (see
  // tenantPortal.js), plus an optional explicit chargeId so a renter can pay
  // a SPECIFIC period — most importantly the not-yet-due one advance-charge
  // just created — rather than always whatever's currently most outstanding.
  router.post('/api/renter/leases/:id/checkout', async (req, res) => {
    const renter = requireRenterAuth(db, req);
    const lease = getRenterLeaseOr404(db, renter.id, req.params.id);
    if (lease.status !== 'active') throw apiError(409, 'This tenancy has ended — payments are no longer accepted on it.');
    ensureChargesGenerated(db, lease.id, lease.timezone);
    const today = todayInTimezone(lease.timezone);

    let charge;
    if (req.body.chargeId) {
      charge = db.prepare('SELECT * FROM charges WHERE id = ? AND lease_id = ?').get(req.body.chargeId, lease.id);
      if (!charge) throw apiError(404, 'Charge not found');
    } else {
      const allCharges = db.prepare('SELECT * FROM charges WHERE lease_id = ? ORDER BY period_start DESC').all(lease.id);
      charge = allCharges.find((c) => {
        const payments = db.prepare('SELECT * FROM payments WHERE charge_id = ?').all(c.id);
        return getChargeStatus(c, payments, today).status !== 'paid';
      }) || allCharges[0];
    }
    if (!charge) throw apiError(404, 'No charge found for this lease');

    const payments = db.prepare('SELECT * FROM payments WHERE charge_id = ?').all(charge.id);
    const { outstanding } = getChargeStatus(charge, payments, today);
    if (outstanding <= 0) throw apiError(409, 'This charge is already fully paid');

    let amountCents = outstanding;
    if (req.body.amount !== undefined) {
      amountCents = dollarsToCents(req.body.amount);
      if (amountCents <= 0) throw apiError(400, 'Enter an amount greater than $0');
      if (amountCents > outstanding) throw apiError(400, 'Amount cannot exceed the outstanding balance');
    }

    // payment_sessions requires a payment_link_id — see getOrCreateActiveLinkForLease's
    // comment for why a renter-portal checkout (no mailed link at all) mints
    // or reuses one under the hood rather than that constraint being loosened.
    const link = getOrCreateActiveLinkForLease(db, lease, charge, appBaseUrl);
    const session = createCheckoutSession(db, { paymentLinkId: link.id, chargeId: charge.id, amountCents, appBaseUrl });
    sendJson(res, 201, session);
  });

  router.get('/api/renter/leases/:id/sessions/:sessionId', async (req, res) => {
    const renter = requireRenterAuth(db, req);
    const lease = getRenterLeaseOr404(db, renter.id, req.params.id);
    const session = db.prepare(`
      SELECT ps.* FROM payment_sessions ps JOIN charges c ON c.id = ps.charge_id WHERE ps.id = ? AND c.lease_id = ?
    `).get(req.params.sessionId, lease.id);
    if (!session) throw apiError(404, 'Payment session not found');
    sendJson(res, 200, {
      id: session.id, status: session.status, amountCents: session.amount_cents, feeCents: session.fee_cents,
      totalCents: session.amount_cents + session.fee_cents,
    });
  });
}

module.exports = { registerRenterPortalRoutes };

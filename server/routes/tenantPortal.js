const { apiError, sendJson } = require('../lib/router');
const { ensureChargesGenerated } = require('../lib/chargeGenerator');
const { getChargeStatus } = require('../lib/rentStatus');
const { todayInTimezone } = require('../lib/dates');
const { dollarsToCents } = require('../lib/money');
const { createCheckoutSession, describeProvider } = require('../lib/paymentProvider');
const { saveBase64Image } = require('../lib/helpers');
const path = require('path');

const UPLOADS_DIR = path.join(__dirname, '..', '..', 'public', 'uploads');

// ---------------------------------------------------------------------------
// Everything in this file is reachable with ONLY a payment-link token — no
// owner session. That makes this the highest-privacy-risk file in the app,
// so every function here builds its response from an explicit allowlist of
// fields. Never `{ ...lease }` or `{ ...property }` here: the owner's bank
// balances, mortgage details, valuations, and private lease notes must be
// structurally impossible to leak through this file, not just absent by
// convention. If a new owner-only field is ever added to `leases` or
// `properties`, this file does not automatically start returning it.
// ---------------------------------------------------------------------------

function resolveActiveLink(db, token) {
  const link = db.prepare('SELECT * FROM payment_links WHERE token = ?').get(token);
  if (!link) throw apiError(404, 'This payment link was not found');
  if (link.status === 'revoked') throw apiError(410, 'This payment link has been revoked. Please ask your landlord to send a new one.');
  if (new Date(link.expires_at + 'Z').getTime() < Date.now()) {
    if (link.status !== 'expired') db.prepare("UPDATE payment_links SET status='expired' WHERE id=?").run(link.id);
    throw apiError(410, 'This payment link has expired. Please ask your landlord to send a new one.');
  }
  const lease = db.prepare(`
    SELECT l.*, p.id AS property_id, p.name AS property_name, p.address_line1, p.address_line2, p.city, p.state, p.zip, p.timezone
    FROM leases l JOIN properties p ON p.id = l.property_id WHERE l.id = ?
  `).get(link.lease_id);
  if (!lease) throw apiError(404, 'This payment link was not found');
  return { link, lease };
}

function tenantSafeCharge(db, charge, today) {
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
    // Tenant sees payment history for their own charges — dates, amounts,
    // method, status — never internal notes the owner logged.
    payments: payments.map((p) => ({ amountCents: p.amount_cents, type: p.type, method: p.method, status: p.status, paidAt: p.paid_at })),
  };
}

function registerTenantPortalRoutes(router, { db, appBaseUrl }) {
  router.get('/api/portal/:token', async (req, res) => {
    const { lease } = resolveActiveLink(db, req.params.token);
    ensureChargesGenerated(db, lease.id, lease.timezone);
    const today = todayInTimezone(lease.timezone);
    const charges = db.prepare('SELECT * FROM charges WHERE lease_id = ? ORDER BY period_start DESC').all(lease.id);
    const history = db.prepare('SELECT rent_cents, effective_date FROM lease_rent_history WHERE lease_id = ? ORDER BY effective_date DESC LIMIT 1').get(lease.id);

    sendJson(res, 200, {
      property: {
        name: lease.property_name,
        address: { line1: lease.address_line1, line2: lease.address_line2, city: lease.city, state: lease.state, zip: lease.zip },
      },
      lease: {
        tenantName: lease.tenant_name,
        coTenantName: lease.co_tenant_name,
        startDate: lease.start_date,
        endDate: lease.end_date,
        currentRentCents: history ? history.rent_cents : null,
        depositRequiredCents: lease.deposit_required_cents,
        depositHeldCents: lease.deposit_held_cents,
        dueDay: lease.due_day,
        lateAfterDays: lease.late_after_days,
        lateFeeEnabled: !!lease.late_fee_enabled,
        lateFeeType: lease.late_fee_type,
        lateFeeAmountCents: lease.late_fee_amount_cents,
      },
      charges: charges.map((c) => tenantSafeCharge(db, c, today)),
      provider: describeProvider(),
    });
  });

  router.get('/api/portal/:token/documents', async (req, res) => {
    const { lease } = resolveActiveLink(db, req.params.token);
    const rows = db.prepare('SELECT * FROM documents WHERE property_id = ? AND is_shared_with_tenant = 1 ORDER BY uploaded_at DESC').all(lease.property_id);
    sendJson(res, 200, rows.map((d) => ({
      id: d.id, filename: d.filename, category: d.category,
      url: `/uploads/properties/${d.property_id}/documents/${d.file_path}?token=${req.params.token}`,
    })));
  });

  router.get('/api/portal/:token/maintenance', async (req, res) => {
    const { lease } = resolveActiveLink(db, req.params.token);
    // Tenant-safe subset: never assigned vendor or cost figures — those are
    // the owner's operating details, not the tenant's business.
    const rows = db.prepare('SELECT * FROM maintenance_requests WHERE property_id = ? ORDER BY created_at DESC').all(lease.property_id);
    const withPhotos = rows.map((r) => {
      const photos = db.prepare('SELECT * FROM maintenance_photos WHERE maintenance_request_id = ?').all(r.id);
      return {
        id: r.id, title: r.title, description: r.description, priority: r.priority, status: r.status,
        scheduledDate: r.scheduled_date, completedDate: r.completed_date, createdAt: r.created_at,
        photos: photos.map((p) => ({ url: `/uploads/properties/${lease.property_id}/maintenance/${p.file_path}?token=${req.params.token}` })),
      };
    });
    sendJson(res, 200, withPhotos);
  });

  router.post('/api/portal/:token/maintenance', async (req, res) => {
    const { lease } = resolveActiveLink(db, req.params.token);
    const { title, description, images } = req.body;
    if (!title || !title.trim()) throw apiError(400, 'Please describe what needs attention');
    const result = db.prepare(`
      INSERT INTO maintenance_requests (property_id, title, description, priority, status, created_by)
      VALUES (?, ?, ?, 'normal', 'open', 'tenant')
    `).run(lease.property_id, title.trim(), description || null);
    if (Array.isArray(images) && images.length > 0) {
      const destDir = path.join(UPLOADS_DIR, 'properties', String(lease.property_id), 'maintenance');
      for (const dataUrl of images) {
        const filename = saveBase64Image(dataUrl, destDir, 'maint');
        db.prepare('INSERT INTO maintenance_photos (maintenance_request_id, file_path) VALUES (?, ?)').run(result.lastInsertRowid, filename);
      }
    }
    sendJson(res, 201, { id: result.lastInsertRowid, ok: true });
  });

  // Tenant picks an amount (defaulting to the full outstanding balance, but
  // partial payments are allowed per spec) and we create a provider session
  // for exactly that amount plus the disclosed processing fee.
  router.post('/api/portal/:token/checkout', async (req, res) => {
    const { link, lease } = resolveActiveLink(db, req.params.token);
    ensureChargesGenerated(db, lease.id, lease.timezone);
    const today = todayInTimezone(lease.timezone);

    // The link was minted against whichever charge was outstanding at the
    // time (link.charge_id), but a payment link stays valid and reusable for
    // its full TTL — by the time the tenant actually pays, that exact charge
    // may already be settled (through this same link earlier, or a manual
    // payment the owner recorded) while a NEWER period has since become the
    // outstanding one. Always resolve to whatever is currently owed for this
    // lease first, using the same "newest outstanding period" rule used when
    // the link was minted (see paymentLinks.js), so a real, current balance
    // is never blocked behind a stale reference to an already-paid charge.
    // Only fall back to the link's originally-bound charge, and then the
    // most recent charge overall, when nothing is currently outstanding —
    // so that case still produces an accurate "already paid" message rather
    // than silently resolving to some other charge.
    const allCharges = db.prepare('SELECT * FROM charges WHERE lease_id = ? ORDER BY period_start DESC').all(lease.id);
    const currentlyOutstanding = allCharges.find((c) => {
      const chargePayments = db.prepare('SELECT * FROM payments WHERE charge_id = ?').all(c.id);
      return getChargeStatus(c, chargePayments, today).status !== 'paid';
    });
    const charge = currentlyOutstanding
      || db.prepare('SELECT * FROM charges WHERE id = ?').get(link.charge_id)
      || allCharges[0];
    if (!charge) throw apiError(404, 'No charge found for this link');

    const payments = db.prepare('SELECT * FROM payments WHERE charge_id = ?').all(charge.id);
    const { outstanding } = getChargeStatus(charge, payments, today);
    if (outstanding <= 0) throw apiError(409, 'This charge is already fully paid');

    let amountCents = outstanding;
    if (req.body.amount !== undefined) {
      amountCents = dollarsToCents(req.body.amount);
      if (amountCents <= 0) throw apiError(400, 'Enter an amount greater than $0');
      if (amountCents > outstanding) throw apiError(400, 'Amount cannot exceed the outstanding balance');
    }

    const session = createCheckoutSession(db, { paymentLinkId: link.id, chargeId: charge.id, amountCents, appBaseUrl });
    sendJson(res, 201, session);
  });

  // Polled by the tenant's "waiting for confirmation" screen. Reflects ONLY
  // what a verified webhook has written to the database — never anything
  // the browser itself claims — so a tenant can't mark their own rent paid
  // by hitting a client-side "success" URL.
  router.get('/api/portal/:token/sessions/:sessionId', async (req, res) => {
    const { link } = resolveActiveLink(db, req.params.token);
    const session = db.prepare('SELECT * FROM payment_sessions WHERE id = ? AND payment_link_id = ?').get(req.params.sessionId, link.id);
    if (!session) throw apiError(404, 'Payment session not found');
    sendJson(res, 200, {
      id: session.id, status: session.status, amountCents: session.amount_cents, feeCents: session.fee_cents,
      totalCents: session.amount_cents + session.fee_cents,
    });
  });
}

module.exports = { registerTenantPortalRoutes, resolveActiveLink };

const crypto = require('crypto');
const { apiError, sendJson } = require('../lib/router');
const { requireAuth, logAudit } = require('../lib/helpers');
const { ensureChargesGenerated } = require('../lib/chargeGenerator');
const { getChargeStatus } = require('../lib/rentStatus');
const { todayInTimezone } = require('../lib/dates');
const { describeProvider } = require('../lib/paymentProvider');

const LINK_TTL_DAYS = 14;

function serializeLink(link, appBaseUrl) {
  return {
    id: link.id,
    token: link.token,
    url: `${appBaseUrl}/pay/link/${link.token}`,
    status: link.status,
    expiresAt: link.expires_at,
    createdAt: link.created_at,
    // Lets the owner-facing "Get payment link" UI say plainly whether a
    // generated link accepts real money or is a test/simulated link — never
    // left for the client to guess or assume.
    provider: describeProvider(),
  };
}

function getOwnedLeaseOr404(db, ownerId, leaseId) {
  const lease = db.prepare(`
    SELECT l.*, p.timezone AS property_timezone, p.owner_id, p.name AS property_name
    FROM leases l JOIN properties p ON p.id = l.property_id WHERE l.id = ? AND p.owner_id = ?
  `).get(leaseId, ownerId);
  if (!lease) throw apiError(404, 'Lease not found');
  return lease;
}

function registerPaymentLinkRoutes(router, { db, appBaseUrl }) {
  router.get('/api/leases/:id/payment-links', async (req, res) => {
    const owner = requireAuth(db, req);
    const lease = getOwnedLeaseOr404(db, owner.id, req.params.id);
    const rows = db.prepare('SELECT * FROM payment_links WHERE lease_id = ? ORDER BY created_at DESC').all(lease.id);
    sendJson(res, 200, rows.map((r) => serializeLink(r, appBaseUrl)));
  });

  // Returns the lease's current active payment link, minting a fresh one only
  // if none is active (or the previous one expired). This is deliberately
  // idempotent rather than "revoke old, create new" on every call: an owner
  // re-opening the property page and clicking "Get payment link" again must
  // never invalidate a link already texted to the tenant, who may have it
  // open right now. Unguessable regardless: 32 random bytes, never derivable
  // from the lease id. Expires automatically; the owner can also revoke it
  // early (e.g. after a phone/cash payment made the link moot).
  router.post('/api/leases/:id/payment-links', async (req, res) => {
    const owner = requireAuth(db, req);
    const lease = getOwnedLeaseOr404(db, owner.id, req.params.id);
    if (lease.status !== 'active') throw apiError(409, 'Cannot create a payment link for a lease that has ended');

    const existing = db.prepare("SELECT * FROM payment_links WHERE lease_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1").get(lease.id);
    if (existing && new Date(existing.expires_at + 'Z').getTime() >= Date.now()) {
      return sendJson(res, 200, serializeLink(existing, appBaseUrl));
    }

    ensureChargesGenerated(db, lease.id, lease.property_timezone);
    const today = todayInTimezone(lease.property_timezone);
    const charges = db.prepare('SELECT * FROM charges WHERE lease_id = ? ORDER BY period_start DESC').all(lease.id);
    const outstandingCharge = charges.find((c) => {
      const payments = db.prepare('SELECT * FROM payments WHERE charge_id = ?').all(c.id);
      return getChargeStatus(c, payments, today).status !== 'paid';
    });
    if (!outstandingCharge) throw apiError(409, 'This tenant has no outstanding balance to collect right now');

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + LINK_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 19);
    const result = db.prepare(`
      INSERT INTO payment_links (token, lease_id, charge_id, status, expires_at) VALUES (?, ?, ?, 'active', ?)
    `).run(token, lease.id, outstandingCharge.id, expiresAt);

    logAudit(db, { actorType: 'owner', actorId: owner.id, action: 'create_payment_link', entityType: 'payment_link', entityId: result.lastInsertRowid, after: { leaseId: lease.id, chargeId: outstandingCharge.id } });
    sendJson(res, 201, serializeLink(db.prepare('SELECT * FROM payment_links WHERE id = ?').get(result.lastInsertRowid), appBaseUrl));
  });

  router.post('/api/payment-links/:id/revoke', async (req, res) => {
    const owner = requireAuth(db, req);
    const link = db.prepare(`
      SELECT pl.* FROM payment_links pl JOIN leases l ON l.id = pl.lease_id JOIN properties p ON p.id = l.property_id
      WHERE pl.id = ? AND p.owner_id = ?
    `).get(req.params.id, owner.id);
    if (!link) throw apiError(404, 'Payment link not found');
    db.prepare("UPDATE payment_links SET status='revoked', revoked_at=datetime('now') WHERE id=?").run(link.id);
    logAudit(db, { actorType: 'owner', actorId: owner.id, action: 'revoke_payment_link', entityType: 'payment_link', entityId: link.id });
    sendJson(res, 200, { ok: true });
  });
}

module.exports = { registerPaymentLinkRoutes, serializeLink };

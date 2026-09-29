const { sendJson } = require('../lib/router');
const { verifyAndParseWebhook } = require('../lib/paymentProvider');
const { recordChargePayment } = require('../lib/paymentAllocation');
const { todayInTimezone } = require('../lib/dates');

// ---------------------------------------------------------------------------
// This is the ONE place a completed payment turns into money in the ledger.
// The tenant-facing checkout flow never calls recordChargePayment directly —
// only a verified webhook event does, which is what makes "do not mark rent
// paid solely because the browser reached a success page" true by
// construction rather than by remembering not to.
// ---------------------------------------------------------------------------

function registerWebhookRoutes(rawRouter, { db }) {
  // Registered directly against the raw HTTP layer (see server/index.js) rather
  // than through the JSON body-parsing router, because signature verification
  // needs the exact raw bytes the provider signed — parsing to JSON first and
  // re-serializing can change whitespace/key order and break the signature.
  return async function handleMockWebhook(req, res, rawBody) {
    let event;
    try {
      event = verifyAndParseWebhook(rawBody, req.headers['x-webhook-signature']);
    } catch (e) {
      return sendJson(res, e.statusCode || 400, { error: e.message });
    }

    // Idempotency: record this event id before acting on it. If another
    // delivery of the exact same event already landed (providers redeliver
    // on timeout, at-least-once), the INSERT hits the UNIQUE(provider,
    // event_id) constraint and we acknowledge without reprocessing.
    try {
      db.prepare('INSERT INTO webhook_events (provider, event_id, event_type, payload_json) VALUES (?, ?, ?, ?)')
        .run('mock', event.id, event.type, rawBody);
    } catch (e) {
      if (e.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed/.test(e.message)) {
        return sendJson(res, 200, { received: true, duplicate: true });
      }
      throw e;
    }

    const session = db.prepare('SELECT * FROM payment_sessions WHERE id = ?').get(event.data.sessionId);
    if (!session) return sendJson(res, 200, { received: true, note: 'Unknown session, ignored' });

    if (event.type === 'payment_intent.processing') {
      db.prepare("UPDATE payment_sessions SET status='processing', updated_at=datetime('now') WHERE id=?").run(session.id);
    } else if (event.type === 'payment_intent.succeeded') {
      // A session can only be paid out to the ledger once, no matter how many
      // times this event is (re)delivered — guard on current status, not just
      // the webhook_events table, in case two different event ids ever
      // represented the same underlying charge.
      if (session.status !== 'succeeded') {
        const charge = db.prepare('SELECT * FROM charges WHERE id = ?').get(session.charge_id);
        // Join to the property for its timezone: this webhook can fire at any
        // instant, and "today" for the rent ledger must be the PROPERTY's
        // local calendar date, never the server's raw UTC date — otherwise a
        // payment made in the evening (in any timezone behind UTC) risks
        // being dated tomorrow and silently dropping out of "this month"
        // reports until the next range rolls around. See lib/dates.js.
        const lease = db.prepare(`
          SELECT l.*, p.timezone AS property_timezone FROM leases l JOIN properties p ON p.id = l.property_id WHERE l.id = ?
        `).get(charge.lease_id);
        recordChargePayment(db, {
          chargeId: charge.id, propertyId: lease.property_id, leaseId: lease.id,
          amountCents: session.amount_cents, type: 'payment', method: 'card',
          paidAt: todayInTimezone(lease.property_timezone),
          notes: 'Paid online via tenant portal (Test Payment Simulator)',
          externalRef: session.provider_session_id,
        });
      }
      db.prepare("UPDATE payment_sessions SET status='succeeded', updated_at=datetime('now') WHERE id=?").run(session.id);
    } else if (event.type === 'payment_intent.failed') {
      db.prepare("UPDATE payment_sessions SET status='failed', updated_at=datetime('now') WHERE id=?").run(session.id);
    }

    sendJson(res, 200, { received: true });
  };
}

module.exports = { registerWebhookRoutes };

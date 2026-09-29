const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Payment provider abstraction.
//
// Every route in this app talks to "the provider" through the four functions
// exported at the bottom (createCheckoutSession, verifyAndParseWebhook,
// describeProvider, isLiveModeConfigured) — never to a specific vendor's SDK
// directly. That's what makes swapping in a real processor later a matter of
// writing one new adapter file, not touching the routes, the database, or
// the tenant portal UI.
//
// Right now there is exactly one adapter: MOCK. It is a fully real, fully
// working implementation of "a hosted-checkout payment processor" — real
// sessions, real signed webhooks, real signature verification, real
// idempotency — except that the "bank" on the other end is simulated by a
// button on a clearly-labeled test page in this same app, so no actual money
// moves and no real card/bank credentials are ever collected or stored here.
//
// Why not wire up real Stripe/Plaid API calls? Because doing so would need a
// real secret key and webhook signing secret that only the property owner
// can obtain (by creating a Stripe account). Writing "integration" code
// against an API with no credentials to actually exercise it would produce
// code that looks connected but has never been proven to work — worse than
// being honest about what's mocked. Instead: everything UP TO the provider
// boundary (sessions, webhooks, ledgers, idempotency, link security) is
// fully built and fully tested; the boundary itself is a small, clearly
// documented seam. See README.md "Connecting a real payment provider" for
// the exact steps to implement a StripeProvider against this same interface.
// ---------------------------------------------------------------------------

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const SECRET_PATH = path.join(DATA_DIR, '.mock_webhook_secret');

function getMockWebhookSecret() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(SECRET_PATH)) return fs.readFileSync(SECRET_PATH, 'utf8').trim();
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(SECRET_PATH, secret, { mode: 0o600 });
  return secret;
}

/** A small, non-refundable-sounding processing fee, the way most hosted
 * checkouts price card payments: 2.9% + $0.30, shown to the tenant BEFORE
 * they confirm, never silently added after. */
function estimateFeeCents(amountCents) {
  return Math.round(amountCents * 0.029) + 30;
}

function isLiveModeConfigured() {
  // A real adapter would check for e.g. process.env.STRIPE_SECRET_KEY here.
  return false;
}

function describeProvider() {
  return isLiveModeConfigured()
    ? { mode: 'live', name: 'Stripe' }
    : { mode: 'test', name: 'Test Payment Simulator', notice: 'No real payment provider is connected. Payments made here are simulated — no real money moves.' };
}

/**
 * Create a payment session for a given charge/amount. In a real adapter this
 * would call the provider's API (e.g. Stripe Checkout Sessions) and return
 * their hosted URL. The mock adapter creates a local DB row and points at
 * this app's own simulated checkout page instead.
 */
function createCheckoutSession(db, { paymentLinkId, chargeId, amountCents, appBaseUrl }) {
  const feeCents = estimateFeeCents(amountCents);
  const providerSessionId = `mock_sess_${crypto.randomBytes(12).toString('hex')}`;
  const result = db.prepare(`
    INSERT INTO payment_sessions (payment_link_id, charge_id, provider, provider_session_id, amount_cents, fee_cents, status)
    VALUES (?, ?, 'mock', ?, ?, ?, 'created')
  `).run(paymentLinkId, chargeId, providerSessionId, amountCents, feeCents);

  return {
    sessionId: result.lastInsertRowid,
    providerSessionId,
    chargeId,
    amountCents,
    feeCents,
    totalCents: amountCents + feeCents,
    checkoutUrl: `${appBaseUrl}/pay/${result.lastInsertRowid}`,
  };
}

/**
 * Verify an inbound webhook's signature and parse its event. Real providers
 * (Stripe included) sign the RAW request body with HMAC-SHA256 and a secret
 * only the server knows; we do exactly that here so this code path is
 * genuinely exercised, not stubbed out. Throws if the signature is missing,
 * malformed, or doesn't match — callers must reject the request (401/400) in
 * that case rather than trusting the payload.
 */
function signPayload(rawBody, secret) {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

function verifyAndParseWebhook(rawBody, signatureHeader) {
  const secret = getMockWebhookSecret();
  if (!signatureHeader) throw Object.assign(new Error('Missing webhook signature'), { statusCode: 400 });
  const expected = signPayload(rawBody, secret);
  const provided = Buffer.from(String(signatureHeader), 'hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  if (provided.length !== expectedBuf.length || !crypto.timingSafeEqual(provided, expectedBuf)) {
    throw Object.assign(new Error('Webhook signature verification failed'), { statusCode: 400 });
  }
  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (e) {
    throw Object.assign(new Error('Malformed webhook payload'), { statusCode: 400 });
  }
  if (!event.id || !event.type) throw Object.assign(new Error('Webhook payload missing id/type'), { statusCode: 400 });
  return event;
}

module.exports = {
  getMockWebhookSecret, signPayload, estimateFeeCents,
  isLiveModeConfigured, describeProvider,
  createCheckoutSession, verifyAndParseWebhook,
};

const http = require('http');
const crypto = require('crypto');
const { apiError, sendJson } = require('../lib/router');
const { escapeHtml } = require('../lib/html');
const { centsToDisplay } = require('../lib/money');
const { signPayload, getMockWebhookSecret } = require('../lib/paymentProvider');

// ---------------------------------------------------------------------------
// The simulated hosted-checkout page. A tenant lands here after starting a
// payment; it is intentionally NOT styled to resemble any real bank, card
// network, or payment processor, and says "TEST MODE — simulated" in several
// places, because it stands in for a real hosted-checkout redirect (like
// Stripe Checkout) that this app can't create without real API credentials.
// No card or bank account fields are collected here — see paymentProvider.js
// for why, and README.md for how to connect a real provider.
// ---------------------------------------------------------------------------

function deliverWebhook(port, event) {
  const rawBody = JSON.stringify(event);
  const signature = signPayload(rawBody, getMockWebhookSecret());
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: '/api/webhooks/mock-provider', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(rawBody), 'x-webhook-signature': signature },
    }, (res) => {
      res.resume();
      res.on('end', resolve);
    });
    req.on('error', reject);
    req.write(rawBody);
    req.end();
  });
}

function checkoutPageHtml({ sessionId, propertyName, tenantName, amountCents, feeCents, status }) {
  const totalCents = amountCents + feeCents;
  const isTerminal = status === 'succeeded' || status === 'failed';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Test Payment Simulator</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; background: #EDEBE4; color: #16213B; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
  .ribbon { position: fixed; top: 0; left: 0; right: 0; background: #B8802A; color: #fff; text-align: center; font-size: 13px; padding: 7px; letter-spacing: .02em; }
  .card { background: #fff; border: 1px solid #DEDAD0; border-radius: 4px; padding: 36px 32px; max-width: 400px; width: 100%; margin-top: 34px; }
  .brand { font-size: 13px; color: #6b6559; margin-bottom: 22px; display:flex; justify-content:space-between; align-items:center;}
  .amount { font-family: Georgia, 'Iowan Old Style', serif; font-size: 40px; margin: 4px 0 2px; }
  .sub { color: #6b6559; font-size: 14px; margin-bottom: 22px; }
  .rows { border-top: 1px solid #EDEBE4; padding-top: 14px; margin-bottom: 26px; }
  .row { display: flex; justify-content: space-between; font-size: 14px; padding: 4px 0; color: #3a362f; }
  .row.total { font-weight: 600; color: #16213B; border-top: 1px solid #EDEBE4; margin-top: 8px; padding-top: 10px; }
  button { width: 100%; padding: 13px; border-radius: 3px; border: none; font-size: 15px; cursor: pointer; margin-bottom: 10px; font-weight: 500; }
  .btn-success { background: #3F7A54; color: #fff; }
  .btn-fail { background: #fff; color: #B3462C; border: 1px solid #B3462C; }
  .btn-async { background: #fff; color: #3D5A80; border: 1px solid #3D5A80; }
  .btn-cancel { background: transparent; color: #6b6559; text-decoration: underline; }
  .status { text-align: center; padding: 20px 0; }
  .status.succeeded { color: #3F7A54; }
  .status.failed { color: #B3462C; }
  .spinner { display:inline-block; width:16px; height:16px; border: 2px solid #DEDAD0; border-top-color:#3D5A80; border-radius:50%; animation: spin 0.8s linear infinite; margin-right: 8px; vertical-align: -3px;}
  @keyframes spin { to { transform: rotate(360deg); } }
  .disclosure { font-size: 12px; color: #948e80; margin-top: 18px; line-height:1.5; }
</style>
</head>
<body>
  <div class="ribbon">TEST MODE — this is a simulated payment screen. No real money moves and no card details are collected.</div>
  <div class="card">
    <div class="brand"><span>Test Payment Simulator</span><span>Session #${sessionId}</span></div>
    <div class="amount">${centsToDisplay(totalCents)}</div>
    <div class="sub">${escapeHtml(propertyName)} — ${escapeHtml(tenantName)}</div>
    <div class="rows">
      <div class="row"><span>Rent payment</span><span>${centsToDisplay(amountCents)}</span></div>
      <div class="row"><span>Processing fee</span><span>${centsToDisplay(feeCents)}</span></div>
      <div class="row total"><span>Total</span><span>${centsToDisplay(totalCents)}</span></div>
    </div>
    <div id="controls">
      ${isTerminal ? '' : `
      <button class="btn-success" onclick="simulate('success')">Simulate successful payment</button>
      <button class="btn-async" onclick="simulate('bank_async')">Simulate bank payment (delayed)</button>
      <button class="btn-fail" onclick="simulate('fail')">Simulate declined payment</button>
      <button class="btn-cancel" onclick="window.close()">Cancel and go back</button>
      `}
    </div>
    <div id="statusArea"></div>
    <div class="disclosure">This screen stands in for a real hosted checkout (like Stripe Checkout), which requires a connected payment provider account. See the app's README for how to connect one.</div>
  </div>
<script>
  async function simulate(outcome) {
    document.getElementById('controls').innerHTML = '<div class="status"><span class="spinner"></span>Processing…</div>';
    const res = await fetch('/api/mock-checkout/${sessionId}/simulate', {
      method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ outcome })
    });
    const data = await res.json();
    if (!res.ok) { document.getElementById('statusArea').innerHTML = '<div class="status failed">' + (data.error || 'Something went wrong') + '</div>'; return; }
    poll();
  }
  async function poll() {
    const res = await fetch('/api/mock-checkout/${sessionId}/status');
    const data = await res.json();
    if (data.status === 'succeeded') {
      document.getElementById('controls').innerHTML = '';
      document.getElementById('statusArea').innerHTML = '<div class="status succeeded">✓ Payment confirmed. You can close this window.</div>';
      if (window.opener) { try { window.opener.postMessage({ type: 'mock-payment-complete', sessionId: ${sessionId}, status: 'succeeded' }, '*'); } catch (e) {} }
    } else if (data.status === 'failed') {
      document.getElementById('controls').innerHTML = '<button class="btn-cancel" onclick="location.reload()">Try again</button>';
      document.getElementById('statusArea').innerHTML = '<div class="status failed">✗ Payment declined.</div>';
      if (window.opener) { try { window.opener.postMessage({ type: 'mock-payment-complete', sessionId: ${sessionId}, status: 'failed' }, '*'); } catch (e) {} }
    } else if (data.status === 'processing') {
      document.getElementById('statusArea').innerHTML = '<div class="status"><span class="spinner"></span>Bank payment processing — this can take a few seconds in this simulation (real ACH transfers take 1-4 business days)…</div>';
      setTimeout(poll, 1200);
    }
  }
  ${isTerminal ? '' : ''}
</script>
</body>
</html>`;
}

function registerMockCheckoutRoutes(router, { db, port }) {
  router.get('/pay/:sessionId', async (req, res) => {
    const sessionId = req.params.sessionId;
    const session = db.prepare('SELECT * FROM payment_sessions WHERE id = ?').get(sessionId);
    if (!session) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<h1>Payment session not found</h1><p>This link may have expired.</p>');
    }
    const link = db.prepare('SELECT * FROM payment_links WHERE id = ?').get(session.payment_link_id);
    const lease = db.prepare('SELECT * FROM leases WHERE id = ?').get(link.lease_id);
    const property = db.prepare('SELECT * FROM properties WHERE id = ?').get(lease.property_id);
    const html = checkoutPageHtml({
      sessionId: session.id, propertyName: property.name, tenantName: lease.tenant_name,
      amountCents: session.amount_cents, feeCents: session.fee_cents, status: session.status,
    });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });

  router.get('/api/mock-checkout/:sessionId/status', async (req, res) => {
    const session = db.prepare('SELECT * FROM payment_sessions WHERE id = ?').get(req.params.sessionId);
    if (!session) throw apiError(404, 'Session not found');
    sendJson(res, 200, { status: session.status });
  });

  router.post('/api/mock-checkout/:sessionId/simulate', async (req, res) => {
    const session = db.prepare('SELECT * FROM payment_sessions WHERE id = ?').get(req.params.sessionId);
    if (!session) throw apiError(404, 'Session not found');
    if (session.status === 'succeeded' || session.status === 'failed') {
      throw apiError(409, 'This session has already reached a final status');
    }
    const outcome = req.body.outcome;
    const baseEvent = { data: { sessionId: session.id } };

    if (outcome === 'success') {
      await deliverWebhook(port, { id: `evt_${crypto.randomBytes(12).toString('hex')}`, type: 'payment_intent.succeeded', ...baseEvent });
    } else if (outcome === 'fail') {
      await deliverWebhook(port, { id: `evt_${crypto.randomBytes(12).toString('hex')}`, type: 'payment_intent.failed', ...baseEvent });
    } else if (outcome === 'bank_async') {
      await deliverWebhook(port, { id: `evt_${crypto.randomBytes(12).toString('hex')}`, type: 'payment_intent.processing', ...baseEvent });
      // Simulated ACH-style settlement delay. This setTimeout firing after the
      // request returns is exactly the point: the tenant's browser is told
      // "processing" now, and the real completion arrives later via its own
      // independently-verified webhook call, never from this same request.
      setTimeout(() => {
        deliverWebhook(port, { id: `evt_${crypto.randomBytes(12).toString('hex')}`, type: 'payment_intent.succeeded', ...baseEvent }).catch(() => {});
      }, 4000);
    } else {
      throw apiError(400, 'Unknown outcome');
    }
    sendJson(res, 200, { ok: true });
  });
}

module.exports = { registerMockCheckoutRoutes };

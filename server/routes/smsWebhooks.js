const { sendJson } = require('../lib/router');
const { verifyStatusCallback } = require('../lib/smsProvider');

// ---------------------------------------------------------------------------
// Twilio's asynchronous delivery-status callback for an SMS this app sent
// (see server/lib/smsProvider.js's sendSms, which sets StatusCallback to this
// URL). This is the ONLY thing that ever moves an sms_messages row from
// "sent" to "delivered" or "failed" — the initial send response only ever
// tells us the message was accepted for sending, never whether a handset
// actually received it. Same raw-body-signature-verification pattern as
// server/routes/webhooks.js (the mock payment provider) and the same reason:
// verifying the signature needs the exact bytes/params Twilio signed, which a
// JSON-parsing router would have already discarded or reordered.
// ---------------------------------------------------------------------------

function registerSmsWebhookRoutes(rawRouter, { db, appBaseUrl }) {
  return async function handleTwilioStatusWebhook(req, res, rawBody) {
    const params = Object.fromEntries(new URLSearchParams(rawBody));
    try {
      verifyStatusCallback(`${appBaseUrl}/api/webhooks/twilio-sms`, params, req.headers['x-twilio-signature']);
    } catch (e) {
      return sendJson(res, e.statusCode || 400, { error: e.message });
    }

    const { MessageSid, MessageStatus, ErrorCode, ErrorMessage } = params;
    if (!MessageSid || !MessageStatus) return sendJson(res, 200, { received: true, note: 'Missing MessageSid/MessageStatus, ignored' });

    const message = db.prepare('SELECT * FROM sms_messages WHERE provider_message_id = ?').get(MessageSid);
    if (!message) return sendJson(res, 200, { received: true, note: 'Unknown message, ignored' });

    // Twilio can deliver the same callback more than once (at-least-once,
    // same as any webhook provider) and can deliver STATUSES out of order
    // under retries — never regress a terminal status ('delivered' | 'failed'
    // | 'undelivered') back to an earlier one like 'sent'.
    const TERMINAL = ['delivered', 'failed', 'undelivered'];
    if (TERMINAL.includes(message.status) && message.status !== MessageStatus) {
      return sendJson(res, 200, { received: true, note: 'Status already terminal, ignored' });
    }

    db.prepare(`
      UPDATE sms_messages SET status = ?, error_message = ?, updated_at = datetime('now') WHERE id = ?
    `).run(MessageStatus, ErrorMessage || (ErrorCode ? `Twilio error ${ErrorCode}` : null), message.id);

    sendJson(res, 200, { received: true });
  };
}

module.exports = { registerSmsWebhookRoutes };

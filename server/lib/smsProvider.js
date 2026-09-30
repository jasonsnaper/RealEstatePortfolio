// Real SMS provider abstraction, deliberately mirroring the shape of
// server/lib/bankProvider.js (read that file's header first — same reasoning
// applies here almost word for word): every route talks to "the provider"
// only through the functions exported at the bottom, never to a vendor API
// directly.
//
// Provider: Twilio (https://www.twilio.com/docs/sms/api), called directly
// over HTTPS with Node's built-in fetch rather than the official `twilio` npm
// package. Two reasons: this app has zero npm dependencies by design (see
// README.md), and Twilio's Messages resource is a single plain REST endpoint
// with HTTP Basic Auth — there is no SDK-specific behavior worth pulling in a
// dependency for. This is genuine, working integration code, not a
// placeholder: it will send a real text message the moment real credentials
// are present, exactly like bankProvider.js does for Plaid.
//
// ---------------------------------------------------------------------------
// Setup — see README.md "Sending renter invitations by SMS" for the full walkthrough:
//   1. Create a Twilio account at https://www.twilio.com/try-twilio and buy
//      (or use the trial) a phone number capable of sending SMS.
//   2. Set these environment variables before starting the server:
//        TWILIO_ACCOUNT_SID   — from your Twilio Console
//        TWILIO_AUTH_TOKEN    — from your Twilio Console (keep this secret)
//        TWILIO_FROM_NUMBER   — the E.164 number you send from, e.g. +15551234567
//      (Advanced/optional: TWILIO_MESSAGING_SERVICE_SID instead of
//      TWILIO_FROM_NUMBER, if you've set up a Twilio Messaging Service —
//      Twilio's recommended approach for anything beyond a single number,
//      e.g. automatic failover across numbers. Either one is enough on its
//      own; if both are set, the Messaging Service is preferred.)
//   3. That's it. isLiveModeConfigured() flips on the moment credentials are
//      set — "Send Renter Portal Link" then sends a real text instead of
//      showing a setup-required state. Nothing else in the app needs to change.
//   4. Optional but recommended: set APP_BASE_URL to this server's real,
//      publicly-reachable HTTPS address. Doing so lets Twilio call back with
//      delivery/failure status (see the webhook below) so "Delivered" and
//      "Failed" are real, reported states rather than the app guessing. On
//      an address Twilio itself can't reach (localhost, a private network),
//      messages still send — they will just visibly stay at "Sent" here
//      forever, since nothing can tell this server what happened next. This
//      is stated plainly in the owner-facing invite UI, never silently
//      assumed to be "Delivered".
// ---------------------------------------------------------------------------

const crypto = require('crypto');

function isLiveModeConfigured() {
  return !!(
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    (process.env.TWILIO_FROM_NUMBER || process.env.TWILIO_MESSAGING_SERVICE_SID)
  );
}

function describeProvider() {
  return isLiveModeConfigured()
    ? { mode: 'live', name: 'Twilio' }
    : {
        mode: 'unconfigured',
        name: 'Twilio',
        notice: 'SMS sending isn’t set up on this server yet. Copy the invitation link and send it yourself for now — see the README ("Sending renter invitations by SMS") for the exact environment variables to add.',
      };
}

/** Thrown when credentials are missing, so callers can show an honest
 * setup-required state — never a fake/live-looking "Sent". */
function notConfiguredError() {
  return Object.assign(new Error('SMS sending is not configured on this server yet.'), {
    statusCode: 503,
    code: 'sms_provider_not_configured',
  });
}

/** True once APP_BASE_URL looks like something Twilio itself could actually
 * reach to deliver a status callback — i.e. a real https:// host, not
 * localhost or a bare IP on a private network. This is a best-effort,
 * informational check only (used to set expectations in the UI), never a
 * hard gate on sending — a message still sends without it, it just won't
 * ever move past "Sent" here. */
function statusCallbacksReachable(appBaseUrl) {
  if (!appBaseUrl || !appBaseUrl.startsWith('https://')) return false;
  try {
    const host = new URL(appBaseUrl).hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local')) return false;
    return true;
  } catch (e) {
    return false;
  }
}

async function twilioRequest(path, formBody) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  let res;
  try {
    res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${auth}`,
      },
      body: formBody.toString(),
    });
  } catch (err) {
    throw Object.assign(new Error('Could not reach Twilio — check this server’s network access and try again.'), { statusCode: 502, code: 'sms_provider_unreachable' });
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const message = (data && data.message) || `Twilio request to ${path} failed (${res.status})`;
    throw Object.assign(new Error(message), { statusCode: 502, code: 'sms_provider_error', twilioError: data });
  }
  return data;
}

/**
 * Send one SMS. Returns Twilio's own view of the message right after
 * accepting it — normally status "queued" or "accepted", NOT "delivered":
 * Twilio only knows that later, and reports it asynchronously via the status
 * callback webhook (see verifyStatusCallback below). Callers persist the
 * returned providerMessageId so that webhook can find the right row again.
 */
async function sendSms({ to, body, appBaseUrl }) {
  if (!isLiveModeConfigured()) throw notConfiguredError();
  const form = new URLSearchParams();
  form.set('To', to);
  form.set('Body', body);
  if (process.env.TWILIO_MESSAGING_SERVICE_SID) {
    form.set('MessagingServiceSid', process.env.TWILIO_MESSAGING_SERVICE_SID);
  } else {
    form.set('From', process.env.TWILIO_FROM_NUMBER);
  }
  if (statusCallbacksReachable(appBaseUrl)) {
    form.set('StatusCallback', `${appBaseUrl}/api/webhooks/twilio-sms`);
  }
  const data = await twilioRequest('/Messages.json', form);
  return {
    providerMessageId: data.sid,
    status: data.status,
    errorCode: data.error_code || null,
    errorMessage: data.error_message || null,
    callbacksReachable: statusCallbacksReachable(appBaseUrl),
  };
}

/**
 * Verify Twilio's X-Twilio-Signature on an inbound status-callback request.
 * Twilio's own documented algorithm (https://www.twilio.com/docs/usage/security#validating-requests):
 * HMAC-SHA1, keyed by the Auth Token, over the exact webhook URL with every
 * POST parameter's name+value appended (sorted alphabetically by name, no
 * delimiters), base64-encoded. Throws on a missing/mismatched signature so
 * callers reject the request rather than trusting an unsigned payload —
 * exactly the same posture as paymentProvider.js's verifyAndParseWebhook.
 */
function verifyStatusCallback(fullUrl, params, signatureHeader) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) throw Object.assign(new Error('SMS sending is not configured on this server yet.'), { statusCode: 503 });
  if (!signatureHeader) throw Object.assign(new Error('Missing Twilio signature'), { statusCode: 400 });
  let data = fullUrl;
  for (const key of Object.keys(params).sort()) {
    data += key + params[key];
  }
  const expected = crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
  const providedBuf = Buffer.from(String(signatureHeader), 'base64');
  const expectedBuf = Buffer.from(expected, 'base64');
  if (providedBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(providedBuf, expectedBuf)) {
    throw Object.assign(new Error('Twilio signature verification failed'), { statusCode: 400 });
  }
}

module.exports = { isLiveModeConfigured, describeProvider, notConfiguredError, statusCallbacksReachable, sendSms, verifyStatusCallback };

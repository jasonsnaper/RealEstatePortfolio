// Real-bank-connection provider abstraction, deliberately mirroring the
// shape of server/lib/paymentProvider.js: every route talks to "the
// provider" only through the functions exported at the bottom, never to a
// vendor API directly, so this file is the one place that changes if the
// provider is ever swapped.
//
// Provider: Plaid (https://plaid.com/docs/), called directly over HTTPS with
// Node's built-in fetch rather than the official `plaid` npm package. Two
// reasons: this app has zero npm dependencies by design (see README.md —
// everything runs on Node's own built-ins), and in the environment this was
// built in, `npm install` to the public registry could not even reach it.
// Plaid's Node SDK is a thin generated wrapper over exactly the REST
// endpoints called below, so nothing real is lost by calling them directly —
// this is genuine, working integration code, not a placeholder, and it will
// exchange a real public_token and fetch real account balances the moment
// real credentials are present.
//
// ---------------------------------------------------------------------------
// Setup — see README.md "Connecting a real bank provider" for the full walkthrough:
//   1. Create a Plaid account at https://dashboard.plaid.com and get a
//      client_id + secret for the environment you want. Sandbox is free and
//      uses fake test institutions/logins — start there before requesting
//      Production access for real banks.
//   2. Set these environment variables before starting the server:
//        PLAID_CLIENT_ID  — from your Plaid dashboard
//        PLAID_SECRET     — the secret for the matching environment
//        PLAID_ENV        — "sandbox" or "production" (see note below)
//        APP_NAME         — optional; the name Plaid Link shows the owner
//   3. That's it. isLiveModeConfigured() flips on the moment both
//      PLAID_CLIENT_ID and PLAID_SECRET are set — "Connect a real bank" then
//      calls these functions for real instead of showing a setup-required
//      state. Nothing else in the app needs to change.
//
// Note on PLAID_ENV: Plaid has consolidated its environments over time —
// confirm in your own Plaid dashboard which environment name(s)/base URLs
// are current for your account before relying on this. "sandbox" and
// "production" below are the two long-standing, stable ones.
// ---------------------------------------------------------------------------
//
// The Link flow this supports (see routes/bankConnections.js for how the
// client drives it):
//   Owner clicks "Connect a real bank" -> we call createLinkToken() and hand
//   the browser a link_token -> the browser opens Plaid's OWN hosted Link UI
//   with it (Plaid's javascript, loaded fresh from Plaid at the time you wire
//   up the frontend piece — see the README) -> the owner authenticates with
//   their real bank INSIDE Plaid's UI; this app never sees or asks for those
//   credentials -> Plaid hands the browser a one-time public_token -> the
//   browser sends that to us -> exchangePublicToken() turns it into a
//   permanent access_token, which we store server-side ONLY (bank_connections
//   table) and never return to any client -> fetchAccounts() lists the real
//   accounts the owner chose to share so they can pick which to associate
//   with which rental.

const ENV_BASE_URLS = {
  sandbox: 'https://sandbox.plaid.com',
  production: 'https://production.plaid.com',
  // Kept for older Plaid accounts that still have a separate development
  // tier; Plaid has been folding this into sandbox/production, so confirm
  // it's still correct for your account before relying on it.
  development: 'https://development.plaid.com',
};

function isLiveModeConfigured() {
  return !!(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET);
}

function describeProvider() {
  return isLiveModeConfigured()
    ? { mode: 'live', name: 'Plaid', env: process.env.PLAID_ENV || 'sandbox' }
    : {
        mode: 'unconfigured',
        name: 'Plaid',
        notice: 'Real bank connections aren’t set up on this server yet. Manual accounts work normally either way. See the README ("Connecting a real bank provider") for the exact environment variables to add.',
      };
}

/** Thrown by every function below when credentials are missing, so callers
 * can show an honest setup-required state — never a fake/live-looking flow. */
function notConfiguredError() {
  return Object.assign(new Error('Real bank connections are not configured on this server yet.'), {
    statusCode: 503,
    code: 'bank_provider_not_configured',
  });
}

function baseUrl() {
  const env = process.env.PLAID_ENV || 'sandbox';
  const url = ENV_BASE_URLS[env];
  if (!url) throw Object.assign(new Error(`Unknown PLAID_ENV "${env}" — expected "sandbox" or "production".`), { statusCode: 500 });
  return url;
}

async function plaidRequest(path, body) {
  let res;
  try {
    res = await fetch(`${baseUrl()}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
        'PLAID-SECRET': process.env.PLAID_SECRET,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw Object.assign(new Error('Could not reach Plaid — check this server’s network access and try again.'), { statusCode: 502, code: 'bank_provider_unreachable' });
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const message = (data && (data.display_message || data.error_message)) || `Plaid request to ${path} failed (${res.status})`;
    throw Object.assign(new Error(message), { statusCode: 502, code: 'bank_provider_error', plaidError: data });
  }
  return data;
}

/** Mint a short-lived link_token the browser uses to open Plaid's hosted
 * Link UI. `ownerId` becomes Plaid's client_user_id (just an opaque
 * identifier on their end, never a credential). Pass `accessToken` (an
 * existing connection's stored token) to instead get an "update mode" token
 * for reconnecting that same item after it breaks (e.g. the owner changed
 * their bank password) — Plaid then walks the owner through fixing that
 * specific connection rather than creating a duplicate one. */
async function createLinkToken({ ownerId, accessToken }) {
  if (!isLiveModeConfigured()) throw notConfiguredError();
  const body = {
    client_name: process.env.APP_NAME || 'Rental Portfolio',
    language: 'en',
    country_codes: ['US'],
    user: { client_user_id: String(ownerId) },
  };
  if (accessToken) {
    body.access_token = accessToken; // update mode — products are already set on the item, so omitted here
  } else {
    body.products = ['auth'];
  }
  const data = await plaidRequest('/link/token/create', body);
  return { linkToken: data.link_token, expiration: data.expiration };
}

/** Exchange Link's one-time public_token for a permanent access_token +
 * item_id. The access_token is the only thing that can read this connection
 * from here on — store it server-side and never send it to any client. */
async function exchangePublicToken(publicToken) {
  if (!isLiveModeConfigured()) throw notConfiguredError();
  const data = await plaidRequest('/item/public_token/exchange', { public_token: publicToken });
  return { accessToken: data.access_token, itemId: data.item_id };
}

/** Real-time account + balance list for an established connection, so the
 * owner can choose which of their real accounts to associate with which
 * rental. Prefers the "available" balance when Plaid reports one (funds
 * actually free to use), falling back to "current" — Plaid's own documented
 * fallback, since some account types never populate "available". */
async function fetchAccounts(accessToken) {
  if (!isLiveModeConfigured()) throw notConfiguredError();
  const data = await plaidRequest('/accounts/balance/get', { access_token: accessToken });
  return (data.accounts || []).map((a) => {
    const balances = a.balances || {};
    const hasAvailable = balances.available != null;
    const amount = hasAvailable ? balances.available : balances.current;
    return {
      externalAccountId: a.account_id,
      name: a.name || 'Account',
      officialName: a.official_name || null,
      mask: a.mask || null,
      balanceType: hasAvailable ? 'available' : 'current',
      balanceCents: amount != null ? Math.round(amount * 100) : null,
    };
  });
}

module.exports = { isLiveModeConfigured, describeProvider, createLinkToken, exchangePublicToken, fetchAccounts };

# Rental Portfolio Manager

A visual, project-based rental property management app for your own portfolio — one page per
property with a cover photo, photo/document timeline, financials, tenant/lease history, and a
tenant-facing payment portal. Built as a single Node.js app with **zero npm dependencies** (a
custom router, vanilla JS frontend, no build step) and a **local SQLite file** as the database
(via Node's built-in `node:sqlite`, no external database server to install).

This document is the account promised at the end of the build: what works, what has actually been
tested (automated and by hand), and — importantly — what still needs your attention before you'd
call this "done." Read the **Before you rely on this for real money or real tenants** section
before connecting real bank accounts or sending a real tenant a real payment link.

---

## Update log

**This update** (applied directly to your existing app — all of your properties, tenants, photos,
documents, and financial records were left exactly as they were; nothing here required you to
re-enter anything):

- **Dashboard totals no longer scroll sideways.** The financial summary is now a responsive grid
  (4 columns on wide screens, 2 on tablets, 1 on phones) instead of a horizontally-scrolling strip.
  Every number wraps instead of clipping. See `public/css/app.css` (`.ledger`) and
  `public/js/views/dashboard.js` (`renderLedger`).
- **The numbers are color-coded**, consistently: green for money that's coming in or in your favor
  (equity, scheduled rent, rent collected, NOI, cash flow — only while actually positive), red for
  obligations and shortfalls (mortgage principal, mortgage total, expenses, overdue rent — only
  while actually nonzero/positive), and neutral for everything else, including any of the above
  when it happens to be exactly **$0** — a brand-new, empty portfolio reads as neutral throughout,
  not alarmingly red or falsely cheerful green. Labels and minus signs are kept so color is never
  the only signal.
- **New card: Monthly Mortgage Total** — the sum of every mortgage's `monthly_payment_cents`
  across your active properties (correctly handling more than one mortgage on the same property,
  and excluding archived properties). If any mortgage is missing its payment amount, the total
  says so explicitly ("Incomplete — N loans missing a payment amount") instead of silently
  understating itself. See `server/lib/portfolio.js`.
- **Bank accounts are now a real, first-class feature**, not a single balance glued to a property:
  a **Bank Accounts** page on the homepage, a clear **Link Bank Account** action per rental, manual
  accounts (nickname/balance/date, assignable to more than one rental, editable, unlinkable from
  one rental without touching the others), and a real **Connect a real bank** flow via Plaid —
  fully implemented and ready to go live the moment you add Plaid credentials (see §5). A property
  now correctly shows **every** account linked to it, not just the first one.
- **Fixed: "Get payment link" getting stuck on the loading spinner.** See "The payment-link bug,
  confirmed" in §6 for the root cause and how it was verified fixed.
- 32 new automated tests (93 total, all passing) covering everything above — see §6.

---

## 1. Quick start

**Requirements:** Node.js **22.5 or newer** (this app uses Node's built-in SQLite module, which
doesn't exist in older Node versions — check with `node --version`).

```bash
npm install        # installs nothing — there are zero dependencies — but is still worth running once
npm run seed        # creates data/app.db and fills it with a sample portfolio (see below)
npm start           # starts the server on http://localhost:3000
```

Open **http://localhost:3000** in a browser. Sign in with the demo account the seed script
printed to your terminal:

```
Email:    demo@example.com
Password: password123
```

Change that password (or remove the account) before you'd consider this account "yours." Every
sample property is badged **sample**, and you can wipe all of them in one click from the banner
at the top of the dashboard once you're ready to add your own — see §3.

If you'd rather start from a completely empty account instead of the demo data, skip
`npm run seed` and just run `npm start`; the app will walk you through creating your own
owner account on first visit.

### Running the automated tests

```bash
npm test
```

This runs 93 tests (unit + integration) covering money math, rent-status logic, the full
payment/webhook flow, multi-tenant data isolation, mortgage totals, bank-account linking, and
payment-link generation. See §6 for exactly what's covered.

---

## 2. What you're looking at

- **Dashboard** — your whole portfolio: occupancy, scheduled vs. collected rent, overdue rent,
  security deposits held (kept separate from rent income), operating expenses, NOI, cash flow, and
  total cash held across your bank accounts. A bank account linked to more than one property (e.g.
  you deposit rent from two units into one shared checking account) is counted **once**, not once
  per property — this is enforced in the portfolio math itself and covered by automated tests, not
  just something that happens to look right in the demo data.
- **Property pages** — one per rental, each with: a cover photo, an activity/photo timeline
  (with before/after pairing for repairs), documents (each markable as shared with the tenant or
  private), transactions, property value & capital improvements, mortgage, current tenant & lease
  (with full rent history and per-period charge status), historical tenants, maintenance requests,
  and reminders (manual ones you add, plus automatic ones for lease expirations and documents with
  an expiration date).
- **Tenant portal** — a link you generate per lease (`/pay/link/:token`, no login required by
  the tenant) where they can see their charge history, pay what's currently owed, and submit a
  maintenance request. It deliberately shows the tenant **less** than the owner sees: no bank
  balances, no mortgage details, no private owner notes, and maintenance requests show no vendor
  or cost — this is enforced server-side and covered by tests, not just hidden in the UI.

### Rent status, precisely

Each monthly charge is one of: **upcoming** → **due** → **late** (once the late date passes with
any balance left, even if partially paid) → **paid** (once the net amount paid meets the charge).
A refund or reversal can reopen a "paid" charge. None of this is a stored flag you could get out
of sync — it's computed fresh from the charge, its payments, and today's date (in the *property's
own* timezone, not the server's) every time it's displayed. `server/lib/rentStatus.js` is the
single source of truth every view reads from.

A property's headline "Rent status" always describes the **current** period specifically (so it's
never shown contradicting the "owed this period" figure right next to it). If an **older** period
still has a balance too, you'll see a separate callout for that, with the actual amount — it
doesn't get silently absorbed into "this period" or hidden just because both periods happen to
carry the same status label.

---

## 3. The sample data

`npm run seed` creates four properties that between them exercise most of what the app does:

| Property | What it demonstrates |
|---|---|
| Maple Street Duplex | Steady on-time tenant, a rent increase partway through, a mortgage with real payment history, three valuations, a capital improvement, one completed + one open maintenance request (with a before/after photo pair), tenant-shared and private documents. |
| Birchwood Bungalow | **Shares Maple's bank account** (proves the no-double-counting math), a messier payment history (on-time, paid-late, two separate partial payments in different months — so you can see the "older unpaid period" callout in action), a high-priority open maintenance request. |
| Cedar Court Cottage | Currently vacant, own separate bank account, one fully-paid **historical** tenant with a deposit returned in full. |
| Willow Loft | **Archived** (hidden from the default dashboard view; find it via the "Archived" toggle), a past tenant whose deposit was **partially withheld**, no bank account linked at all. |

Every sample property (and the bank account the seed script created) is marked internally as
sample data. Click **"Remove sample data"** on the dashboard banner to permanently delete all four
properties — photos, documents, leases, transactions, everything — in one step, once you're ready
to add your own. This is a real delete, not an archive; there's no undo.

---

## 4. Payments: what's real and what's simulated

Every route in the app talks to "the payment provider" through one small interface
(`server/lib/paymentProvider.js`) — never to a specific vendor's SDK directly. Today there is
exactly one adapter, and it's important to be precise about what it actually is:

**It is a fully real, fully working implementation of a hosted-checkout payment processor** —
real sessions, a real hosted checkout page, real HMAC-SHA256-signed webhooks delivered over a real
HTTP request (not a function call), real signature verification (rejected if missing, malformed,
or wrong — this is tested), real idempotency (redelivering the same webhook event a second time is
a no-op, also tested). The **only** thing that's simulated is which bank is on the other end: it's
a clearly-labeled test page in this same app with a "Simulate success" / "Simulate decline"
button, so no real money moves and no real card or bank details are ever collected.

This matters for one core guarantee the spec asked for: **the browser never marks anything paid.**
The tenant's "payment succeeded" page is just a page — it's the signed webhook, verified
server-side, that's the only thing that ever flips a charge to "paid." You can see this yourself:
the tenant-facing status page polls the server rather than trusting anything the checkout redirect
told it.

### Connecting a real payment provider

I did not wire up real Stripe (or similar) API calls, and want to be direct about why: doing so
would need a real secret key and webhook signing secret that only you can obtain, by creating an
account with that provider. Writing "integration" code against an API with no credentials to
actually exercise it would produce code that *looks* connected but has never been proven to work —
worse than being honest about what's simulated. Instead, everything up to the provider boundary is
fully built and fully tested; the boundary itself is a small, clearly-marked seam:

1. Create `server/lib/providers/stripeProvider.js` exporting the same four functions
   `paymentProvider.js` exports: `createCheckoutSession`, `verifyAndParseWebhook`,
   `describeProvider`, `isLiveModeConfigured`.
2. `createCheckoutSession` should call Stripe's Checkout Sessions API and return their hosted
   `checkoutUrl` instead of this app's own mock page.
3. `verifyAndParseWebhook` should verify using Stripe's SDK (`stripe.webhooks.constructEvent`)
   against `process.env.STRIPE_WEBHOOK_SECRET` instead of the mock HMAC check.
4. `isLiveModeConfigured` should check for `process.env.STRIPE_SECRET_KEY`.
5. Swap the `require('./paymentProvider')` in `server/routes/tenantPortal.js`,
   `server/routes/webhooks.js`, and `server/routes/paymentLinks.js` for your new file.

Nothing in the routes, the database schema, or the tenant portal UI should need to change — that
separation is the point of the interface.

---

## 5. Bank accounts

Two ways to track a bank account, side by side:

**Manual accounts** — a nickname, a balance, and the date that balance is as of. Link one account
to more than one rental (e.g. you deposit rent from two units into one shared checking account);
it shows a **shared** badge on every property it's linked to and is counted **once**, not once per
property, in your portfolio cash total. Unlink an account from a single property without deleting
it or touching its other links; edit the balance any time; delete it outright when you're done
with it. A property page shows **every** account linked to it, in full — nickname, balance, and
whether it's shared — not just the first one.

**Connected accounts (Plaid)** — click **Connect a real bank** and you get Plaid's own hosted
Link UI: the owner signs in at their real bank *inside Plaid's interface*, and this app never sees
or asks for that password. Plaid hands back a token identifying which accounts the owner chose to
share; you then pick which of those to actually associate with which rental (nothing is imported
automatically). From then on each connected account shows its institution, a masked account
number, whether Plaid reports an "available" or "current" balance, and when it last synced. If the
bank connection breaks (the owner changed their bank password, MFA expired, etc.), every account
under that connection shows a **reconnect** badge and a one-click flow to fix it — Plaid calls this
"update mode," and it repairs the existing connection rather than creating a duplicate.

**This is fully implemented, real integration code** — not a mock, and not a placeholder. It calls
Plaid's actual REST API (`server/lib/bankProvider.js`) using Node's built-in `fetch`, matching
Plaid's current documented flow (`/link/token/create` → Link UI → `/item/public_token/exchange` →
`/accounts/balance/get`). It was written without the official `plaid` npm package on purpose, to
keep this app's zero-dependency design — the SDK is a thin wrapper over the same endpoints, so
nothing real is lost.

**What's missing is credentials, not code.** Real Plaid credentials can only come from *you*
creating a Plaid account — I can't obtain or fabricate them. Until you add them:

- **Manual accounts work exactly as described above, with no limitation.**
- Clicking "Connect a real bank" shows a plain, honest **"Real bank connections aren't set up on
  this server yet"** message — never a fake-looking connection and never invented balances.

### Turning on real bank connections

1. Create a free account at [dashboard.plaid.com](https://dashboard.plaid.com) and get a
   `client_id` and `secret`. Start in Plaid's **Sandbox** environment (fake test banks, no real
   money or real bank required) before requesting **Production** access.
2. Set these environment variables before starting the server:
   ```
   PLAID_CLIENT_ID=...
   PLAID_SECRET=...
   PLAID_ENV=sandbox        # or "production" once you have that access
   APP_NAME=Rental Portfolio  # optional — the name Plaid's Link UI shows the owner
   ```
3. Restart the app. That's it — `isLiveModeConfigured()` flips on the moment both
   `PLAID_CLIENT_ID` and `PLAID_SECRET` are present, and "Connect a real bank" starts talking to
   Plaid for real instead of showing the setup-required state. Nothing else needs to change.

Full details and the exact request/response shapes are documented directly in
`server/lib/bankProvider.js`.

A separate, already-implemented **transaction import** endpoint accepts a batch of external bank
transactions (by an external id, to skip re-importing the same one twice) and will match one
against a transaction you already recorded by hand rather than creating a duplicate. That part has
existed since the first build and is unrelated to which of the above two account modes you use.

---

## 6. What's actually been tested

**Automated (93 tests across 6 files, `npm test`, all passing):**
- Money math (dollar/cents parsing and formatting) and date math (month/year boundaries, clamping
  short months) — the kind of off-by-one bugs that are easy to ship silently.
- The full rent-status state machine (upcoming/due/late/partial/paid), including refunds and
  reversals reopening a paid charge, and payments stuck in "processing" or "failed" correctly not
  counting yet.
- Charge generation being idempotent (running it twice never duplicates or rewrites a charge) and
  a rent change only affecting future periods, never rewriting history.
- The full owner-facing HTTP surface: signup/login, property CRUD, cover photo upload (including
  rejecting a file whose declared type doesn't match its content), leases, rent payments,
  transactions, and archiving.
- Portfolio math specifically: a bank account shared by two properties counted once (not twice);
  archived properties excluded entirely; NOI excluding debt service/capex while cash flow includes
  it; deposits never counted as rent income; occupancy rate.
- The full payment-link → checkout → webhook flow, including a bad webhook signature being
  rejected, a duplicate webhook being a no-op, and a declined payment correctly not creating a
  payment record.
- Data isolation: the tenant portal payload never includes owner-only fields (bank balances,
  mortgage details, private notes) or maintenance vendor/cost; unauthenticated requests to owner
  endpoints are rejected; one owner cannot reach another owner's property.
- **New — Monthly Mortgage Total** (`test/mortgageTotal.test.js`, 7 tests): multiple mortgages on
  one property summed correctly; summed correctly across properties; a mortgage on an archived
  property excluded; a mortgage missing its payment amount excluded from the sum *and* flags the
  total incomplete (never silently treated as $0); escrow never double-counted on top of the
  payment amount; a zero-mortgage property correctly reads "complete," not "unknown"; the field is
  present in the empty-portfolio response.
- **New — Bank accounts** (`test/bankAccounts.test.js`, 9 tests): a shared account correctly
  labeled and linked to two properties at once; a property returns **every** linked account, not
  just the first (a direct regression test for the reported bug); editing an account without
  passing `propertyIds` leaves its links untouched; unlinking from one property leaves the account
  and its other link intact; a rejected reassignment (mixing in a property the owner doesn't own)
  leaves the account's existing links **completely unchanged** — proving the reassignment is
  atomic, not partially applied; cross-owner isolation on every bank-account route (link, edit,
  unlink, delete); a shared account counted once, not per-property, in portfolio totals; deleting
  an account removes it from every property it was linked to; the Plaid provider-status endpoint
  correctly reports "unconfigured" with no credentials set, and creating a real Link token then
  fails loudly (503) rather than ever faking a live connection.
- **New — Payment links** (`test/paymentLinks.test.js`, 10 tests; `test/apiClient.test.js`, 6
  tests): successful generation (token shape, correct URL, honest `provider` disclosure);
  re-requesting a still-valid link returns the *same* link rather than minting a new one; a fully
  paid lease is rejected with 409, never a silent fake link; a nonexistent lease returns 404
  promptly; an ended lease is rejected with a 409 distinct from the "no balance" case; cross-owner
  isolation; the link opens the correct tenant's bill with **zero** owner session required;
  revoking a link and reissuing produces a genuinely new token, and the old one stops working;
  history lists every link issued; a configured `APP_BASE_URL` is what actually lands in the
  link's URL, not `localhost`. Separately, `api.js`'s fetch wrapper (the piece the stuck-spinner
  bug lived in) is tested directly against a real HTTP server, including a request that never
  responds at all — proving the client-side timeout actually fires and never hangs indefinitely.

### The payment-link bug, confirmed

**Root cause:** two compounding issues in the client, not the server. `openPaymentLinkModal()`
started its request with a plain `.then()` and **no `.catch()`** — any rejection (a 404, a 409, a
network drop, anything) became an unhandled promise rejection that the modal never heard about, so
it just sat on "Generating a secure payment link…" forever. Separately, `api.js`'s fetch wrapper
had **no timeout at all**, so even a request that never got a response from the server (dropped
connection, hung process on the other end) would never resolve *or* reject on its own — there was
no bound on how long the browser would wait. Either problem alone would have caused this; together
they meant the button had no failure path whatsoever, only a success path.

**The fix:** `api.js` now races every request against an `AbortController` timeout (20s default,
configurable per call) and classifies exactly why a request failed (`timeout` / `network` / a real
HTTP status). `openPaymentLinkModal()` now has a real `.catch()`, shows a plain-language message
for every case (missing/ended lease, no balance due, expired login, network failure, server error),
offers **Retry** only when retrying could plausibly help (never for a 409 or an expired login,
which would just repeat), and guards against a delayed response writing into a modal the owner has
since closed or replaced. The lease id is captured before the request starts, so a slow response
can never land against whatever property the owner has since navigated to. The button is disabled
for the whole request, so a second click can't start a duplicate one.

**Verified, not just reasoned about:** beyond the automated tests above, I drove the actual button
in a real browser (Playwright) through three scenarios and confirmed none of them hang:
1. **Success** — a lease with a balance due: a real link appears, with the correct "simulated
   payment" and (on this test server) "points at localhost" banners.
2. **Handled failure** — a lease with nothing owed: the exact server message appears, with **no**
   Retry button (correctly — retrying wouldn't change anything).
3. **The original failure shape, recreated** — the payment-link request intercepted so it never
   comes back at all (simulating a dropped connection): the modal correctly shows a network-error
   message with a **Retry** button, and clicking Retry (once the connection "recovers") succeeds
   and shows the link. Nothing hangs at any point.

### Verified by hand, original build

I ran the app end-to-end in an actual browser (signed in, clicked through every tab on every sample
property, generated and paid a tenant payment link through a real popup-and-poll flow, recorded a
real mortgage payment, removed sample data, checked the archived-property view) specifically
*because* code that looks correct can still fail once it's actually run. That process caught and
fixed several real bugs that reading the code alone had missed: a SQL syntax mistake that made
recording a mortgage payment fail outright (`server/routes/financials.js`), a date bug where
multi-year records all looked like they were from the same year, a CSS layout bug where a
normal-length tenant email visually overlapped the phone number next to it, an "owed this period"
figure that could hide a *second*, older unpaid balance, and the "Record payment"/"Get payment
link" buttons silently failing on first load because their setup code only ran after visiting a
different tab first. All fixed and re-verified; none were caught by the automated suite at the
time, which is exactly why that pass mattered.

### Verified by hand, this update

The same reasoning applied again: a responsive grid can look right on the one screen size you
happen to check and still be broken elsewhere. I used Playwright to load the dashboard, the Bank
Accounts page, and a property page at five widths (1440/1024/834/390/320px) and check, for real, in
a real rendered page — not by eyeballing one screenshot — that `document.documentElement`'s
scroll width never exceeds its client width (no horizontal scrollbar) and that no `.ledger-value`
element's content overflows its own box (no clipped number). This caught two real bugs before you
ever saw them: at 320px-wide phones, the topbar's nav (Dashboard / Bank Accounts / owner name /
Sign out) didn't fit on one line, and a property with **more than one** linked bank account
overflowed its card, because the account-summary line was still laid out for exactly one account.
Both are fixed (the topbar hides the purely-decorative owner name below 480px as a first line of
defense and wraps as a backstop; each bank account on a card now gets its own row instead of being
crammed into one). Re-running the same check afterward confirmed zero overflow at any of the five
widths, on all three pages. I also separately rendered a brand-new, zero-property owner's empty
dashboard to confirm the "$0.00 is neutral" color rule actually holds there, not just in the demo
data — it does.

**Known gap, disclosed rather than glossed over:** this app has no npm dependencies and this
environment can't reach the npm registry to add a test one, so `jsdom` isn't available. That means
DOM-dependent client logic — the exact staleness guard, button-disabling, and modal state
transitions described above — is verified by direct code reading and the live Playwright
click-through in this section, but doesn't have a permanent, fast, `npm test`-driven regression
test the way the server-side logic does. `api.js` itself (no DOM dependency) is the exception and
is fully covered by real automated tests (`test/apiClient.test.js`).

**Not exercised at all:** anything involving a real payment provider or a real, credentialed Plaid
connection, since neither has credentials configured in this environment (§4, §5) — the code paths
are real and tested up to that boundary, but there is nothing to test past it until you add your
own credentials.

---

## 7. Security notes

- Passwords are hashed with Node's built-in `scrypt` (random salt per password, timing-safe
  comparison) — no plaintext, no reversible encoding.
- Sessions are random 32-byte tokens stored server-side (not JWTs) with a 30-day expiry, sent as an
  `HttpOnly`, `SameSite=Lax` cookie so client-side JavaScript can't read it and it isn't sent
  cross-site. The cookie also gets the `Secure` flag automatically once `APP_BASE_URL` is an
  `https://` URL (see the deploy note below) — it deliberately does *not* set `Secure` when you're
  just running this on `http://localhost`, because browsers would silently drop the cookie
  entirely and you'd never be able to sign in.
- Every write to money, leases, and archival/deletion actions is recorded in an append-only audit
  log (`audit_log` table: who, what, before/after, when) — nothing here is "fire and forget."
  There's no UI to browse it yet, but the data is there (`SELECT * FROM audit_log ORDER BY id DESC`).
- The one webhook signing secret and the server's own secret are generated randomly on first run
  and written to `data/` with `0600` permissions — never hard-coded, never checked into version
  control (see `.gitignore`).
- Every property/financial/tenant-scoped route checks that the resource actually belongs to the
  signed-in owner before returning anything (tested — see §6's "data isolation" line).

### Before you deploy this beyond your own machine

This was built and verified as a local app (`localhost:3000`). If you put it on a real server
reachable over the internet:
- Serve it over HTTPS and set `APP_BASE_URL=https://your-real-domain.com` — this is also what turns
  on the `Secure` cookie flag mentioned above.
- Put `data/` on a disk that's actually backed up. `data/app.db` is a single SQLite file; losing it
  loses everything.
- Read §4 and connect a real payment provider before sending a real tenant a real payment link —
  right now, no real money can move through this app at all, by design.

---

## 8. Project layout

```
server/
  db.js                  schema + additive migrations (schema_meta.version tracked)
  seed.js                sample-data generator (npm run seed)
  lib/                   money/date helpers, rent-status logic, auth, and:
                            paymentProvider.js  mock payment processor (§4)
                            bankProvider.js     real Plaid REST client (§5)
  routes/                one file per resource (properties, leases, financials, tenantPortal,
                            bankAccounts, bankConnections, paymentLinks, …)
public/
  index.html + js/       owner-facing single-page app (hash-based routing, no build step)
                            views/bankAccounts.js  Bank Accounts page + per-property section,
                              including the Plaid Link browser flow
  tenant.html + tenant.js  tenant portal (separate, deliberately smaller, page)
test/
  unit.test.js           pure logic: money, dates, rent-status
  integration.test.js    full HTTP flows against a real (temp) database
  portfolio.test.js      portfolio-level aggregation math
  mortgageTotal.test.js  Monthly Mortgage Total edge cases
  bankAccounts.test.js   bank-account linking, ownership, atomicity
  paymentLinks.test.js   payment-link generation and every handled failure state
  apiClient.test.js      public/js/api.js's timeout/error classification, against a real server
```

No bundler, no framework, no build step — edit a `.js` file under `public/` and reload the page.

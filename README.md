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
re-enter anything). This was in response to a specific report of data disappearing after a
reload/restart, so it's split below into what's fixed and verified vs. what's still in progress:

- **Fixed: the mobile photo picker forced the phone camera open instead of offering the photo
  library**, so an existing photo could never be chosen, only a brand-new one taken on the spot.
  The picker now detects HEIC photos (by file type, and by extension when the phone reports no
  type at all) and offers the real library. Covered by 4 new automated tests
  (`test/photoPicker.test.js`).
- **Data loss investigated, root cause identified, and the app now detects and loudly reports the
  unsafe condition instead of failing silently** — a boot-time console warning, a permanent red
  banner in the app itself (before anyone's even signed in), and an unauthenticated
  `GET /api/system-status` check. Full root cause, the fix, what was actually verified (including a
  real process kill-and-restart, not just a page reload), and what still needs doing on your live
  Render service are all reported honestly, in detail, in §7's new **"Persistence verification,
  step by step"** section — please read that section rather than assuming this bullet is the whole
  story either way.
- **Every save and action across the app now shows real Saving/Saved states, tied to the server's
  actual response** — no more optimistic "it probably worked." A failed save keeps your modal open,
  shows a plain-language error, and preserves everything you typed so you never have to retype it
  to retry. Rapid double-clicking a save button can no longer fire the request twice. Closing a
  modal with unsaved changes now asks first, and closing the browser tab/window does too. Building
  this surfaced and fixed two real pre-existing bugs along the way: canceling a nested confirmation
  (e.g. "Delete this photo?" from inside the photo viewer) used to destroy the screen underneath it
  instead of just dismissing the prompt; and canceling out of the mobile photo picker after
  choosing "keep editing" used to leave broken, blank photo previews behind. Both are fixed and
  covered by live browser testing — see "Verified by hand, this update" in §6. 5 new automated tests
  (`test/formSave.test.js`) cover the underlying error-message logic.
- **Not yet user-visible:** the data model gained new tables and columns to support renter accounts
  and a tenant-facing portal (login, balance, documents, payments) — this is schema-only groundwork
  for that still-in-progress feature and changes nothing about how the app looks or behaves today.
- 9 new automated tests (102 total, all passing) covering everything above — see §6.

**Previous update** (dashboard grid, color-coded numbers, Monthly Mortgage Total card, bank-account
linking, and the payment-link fix):

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

This runs 102 tests (unit + integration) covering money math, rent-status logic, the full
payment/webhook flow, multi-tenant data isolation, mortgage totals, bank-account linking,
payment-link generation, the mobile photo picker's HEIC handling, and the shared save-lifecycle
error-message logic. See §6 for exactly what's covered.

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

**Automated (102 tests across 9 files, `npm test`, all passing):**
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
- **New — Mobile photo picker** (`test/photoPicker.test.js`, 4 tests): HEIC files correctly
  detected by MIME type and, separately, by file extension when the browser reports no MIME type at
  all (the exact case that forced iPhones straight to the camera instead of the photo library); a
  normal JPEG/PNG correctly *not* flagged as HEIC; `isUsableImageFile`'s accept/reject logic for
  what the picker will and won't try to preview.
- **New — Shared save-lifecycle error messages** (`test/formSave.test.js`, 5 tests):
  `describeApiError`'s mapping from a raw API error to the plain-language message shown to the
  owner — an expired session (401), an ordinary validation error (its own message passed through
  unchanged), a server-side failure (5xx, a generic "try again" message rather than a stack trace),
  a network/timeout failure (passed through as-is), and a safe fallback for anything that isn't
  even API-shaped (so a bug in the error handling itself can't throw a second, more confusing error
  on top of the first).

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

### Verified by hand, dashboard grid & bank accounts update

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

### Verified by hand, this update

This round adds a save/error UX layer that touches nearly every form and action button in the app
(property, photo, document, expense, valuation, improvement, mortgage, lease, rent-change,
end-lease, payment-recording, maintenance, reminder, and bank-account modals), so it was verified
live in a real browser (Playwright) rather than by inspection, across nine scenarios:

1. **Saving → Saved lifecycle.** A save button shows "Saving…" and is disabled for the actual
   duration of a (deliberately slowed) request, then the modal closes and a "Saved" toast appears
   only after the server actually confirmed success — not optimistically, before the response comes
   back.
2. **Failure keeps your input.** A simulated server failure leaves the modal open, shows a plain-
   language inline error above the buttons, re-enables the submit button, and leaves every field
   exactly as typed — nothing entered is lost, so retrying doesn't mean retyping.
3. **Duplicate submits are blocked.** Three click events dispatched at the same form in the same
   tick (bypassing the browser's own click handling, to test the app's guard directly, not the
   browser's) produced exactly **one** network request, not three.
4. **Unsaved-changes warning, both branches.** Editing a field and clicking Cancel prompts "Discard
   unsaved changes?"; choosing to keep editing leaves the modal open with the typed value intact;
   choosing to discard closes it and throws the edit away, as expected.
5. **No false positives.** Completing a real, successful save never shows a discard prompt —
   the warning is tied to unsaved edits, not to closing a modal in general.
6. **A pre-existing bug, found and fixed in the process:** the confirmation prompt used to be built
   on the same plumbing as the modal it could be triggered from (e.g. "Delete this photo?" from
   inside the photo viewer), so opening the prompt silently destroyed the modal underneath it —
   canceling the delete then lost the photo viewer entirely instead of just dismissing the prompt.
   Confirmed fixed: the photo viewer now stays visible behind the delete confirmation, canceling
   correctly restores it, and confirming deletes the photo and closes both.
7. **Leaving the page.** Dispatching a real `beforeunload` event is not prevented when nothing is
   open, and **is** prevented (the browser's native "leave site?" prompt) when a modal has unsaved
   changes — checked in both directions, not just the positive case.
8. **A second pre-existing bug, caught before it shipped:** the mobile photo picker used to discard
   its in-progress photo previews as soon as Cancel was clicked, even if you then chose "keep
   editing" at the new discard prompt — leaving broken, blank image tiles behind. Fixed so previews
   are only discarded once a close is actually confirmed; verified the previews stay valid and
   viewable after choosing "keep editing," and that a genuinely untouched picker still closes
   immediately with no prompt at all (so the warning never becomes a nuisance when there's nothing
   to lose).
9. **No new console/page errors** were observed during any of the above, checked by listening for
   them for the whole run rather than only looking where a bug was expected.

This same round also added the misconfigured-storage warning banner described in §7. That banner's
condition (`server/lib/storageStatus.js`) was checked directly against the possible combinations of
`DATA_DIR`/`UPLOADS_DIR`/hosting-provider environment variables, and the banner and matching
`/api/system-status` response were confirmed to appear and disappear exactly as that logic
predicts. What that banner does **not** by itself prove — and what the rest of this section is
careful not to claim — is that any particular deployment's storage is actually persistent; the
Persistence verification report below covers that separately, and honestly.

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
reachable over the internet, there are two things you must get right, plus one you should:

**1. Persistent storage — read this before you put any real data in.** This app stores everything
— the SQLite database (`data/app.db`) and every uploaded photo/document (`public/uploads/`) — as
plain files on disk. That's exactly right for your own machine, but most hosting platforms
(Render, Railway, Heroku, Fly.io, and most others) give your app a **fresh, empty filesystem on
every restart and every redeploy**, unless you explicitly attach a separate persistent disk/volume
and point the app at it. Miss this step and the app will look like it works — right up until the
service restarts (which happens automatically: idle timeouts, redeploys, host maintenance, crashes)
and every property, photo, document, renter, and payment you entered is gone, with no error or
warning at the moment it happens.

To fix this, the app already supports pointing its storage at any path you give it:
- Set `DATA_DIR` to a folder on a persistent disk — the database file goes there.
- Set `UPLOADS_DIR` to a (typically different) folder on that same persistent disk — uploaded
  photos/documents go there.
- Leave both unset and nothing changes — you get today's exact behavior (`data/` and
  `public/uploads/` next to the code), which is correct for running this on your own computer.

The app also **checks this itself and won't fail silently**: on startup it looks for the
environment variables platforms like Render set automatically (so it doesn't depend on you having
configured anything else correctly first) and, if it looks like a real deployment without
`DATA_DIR`/`UPLOADS_DIR` set, it prints a loud warning in the server logs, shows a red banner in
the app itself (every screen, signed in or not, until it's fixed), and exposes the same check at
`GET /api/system-status` (`{dataDirConfigured, uploadsDirConfigured, likelyEphemeralHost, atRisk}`
— no sign-in required, since the whole point is to catch this before anyone's created an account).
See `server/lib/storageStatus.js`.

**If you're deploying to Render specifically** (as of when this was written):
- Render's **Free** plan cannot attach a persistent disk at all — it's not a configuration option
  you're missing, it's not offered on that plan. Free-plan services also spin down completely after
  15 minutes with no incoming requests and cold-start on the next one, so on Free, *any* period of
  inactivity — not just a manual redeploy — resets the filesystem. This matches "I uploaded a photo
  and edited something, then reloaded and it was gone": if enough idle time passed to spin the
  service down, the reload's request is what spun it back up, on a brand-new empty filesystem.
  Reaching the app is not the same request that would show a "data loss" error — there isn't one;
  it just looks empty again, exactly as if it were a new install.
- To actually fix it on Render, you need a **paid** plan (their cheapest tier was ~$7/month at time
  of writing) and to attach a disk to your service (Render dashboard → your service → **Disks** →
  add a disk, choose a mount path and size; disk cost was ~$0.25/GB/month). Then set `DATA_DIR` and
  `UPLOADS_DIR` in your service's environment variables to two subfolders under that mount path
  (e.g. mount at `/var/data`, set `DATA_DIR=/var/data/db` and `UPLOADS_DIR=/var/data/uploads`) and
  redeploy. A service with a disk attached can only run as a single instance and loses zero-downtime
  deploys (brief downtime during each deploy) — both are fine for this app, which is single-owner
  and was never designed to run as more than one instance.
- Check current Render pricing/behavior yourself before deciding — plans and free-tier limits
  change. If you'd rather not pay for a disk, the alternative is moving the database and file
  storage to an external managed service (e.g. a hosted Postgres database and S3-compatible object
  storage) instead of local disk — a real rearchitecture this app doesn't currently include, since
  it was built around a local SQLite file by design (see the top of this document).
- Confirm it actually worked on your own service: add/edit something, then in the Render dashboard
  manually restart the service (or wait for an idle spin-down on Free, or redeploy), reload the
  app, and check your data is still there. Don't take "it works right now" as proof by itself —
  that's true right up until the first restart either way.

**2. HTTPS.** Serve the app over HTTPS and set `APP_BASE_URL=https://your-real-domain.com` — this is
also what turns on the `Secure` cookie flag mentioned above.

**You should also** read §4 and connect a real payment provider before sending a real tenant a real
payment link — right now, no real money can move through this app at all, by design.

### Persistence verification, step by step

This app previously lost data after a reload/restart in production. Here is the root cause, the
fix, and — separately — exactly what has and has not actually been verified, run just now in this
environment rather than reasoned about from memory.

**Root cause.** This app stores its database and uploaded files as plain files on local disk by
design (§ above) — correct for your own machine, wrong for most hosts unless you point it at a
persistent disk. Nothing was silently broken in the code: the app was simply deployed without
`DATA_DIR`/`UPLOADS_DIR` set to a persistent path, so every write landed on the host's local,
non-persistent filesystem. If the live site is on Render's **Free** plan specifically, this is
worse than an ordinary missed setting: Free cannot attach a persistent disk at all, and Free
services spin down after 15 minutes idle and cold-start fresh on the next request — so *any* lull
in traffic, not just a manual redeploy, resets the filesystem. That matches the reported symptom
(upload or edit something, come back later, it's gone) precisely.

**The fix.** `DATA_DIR`/`UPLOADS_DIR` env-var overrides (so the app can be pointed at a real
persistent disk instead of its own folder) already existed before this round; what's new here is
that the app now **detects and loudly reports** the unsafe default instead of failing silently: a
boot-time console warning, a permanent red banner in the app itself (every screen, before anyone's
even signed in), and an unauthenticated `GET /api/system-status` check — plus the save-lifecycle UX
in §6 (visible Saving/Saved states, inline errors that preserve your input, a warning before
leaving unsaved changes) so that if a save ever fails for *any* reason, including a future one, it
fails loudly on screen rather than looking like it worked.

**What I actually tested, just now, in this sandbox (not your live site):**
1. Ran the app against an external directory standing in for a persistent disk (`DATA_DIR`/
   `UPLOADS_DIR` pointed outside the app folder), with environment variables set so the app's own
   detection believed it was a real hosted deployment — confirmed `/api/system-status` correctly
   reported `atRisk: false` in that configuration.
2. Through the real UI in a real browser: created the owner account, added a rental, edited it,
   uploaded a cover photo, uploaded a document, saved and hard-refreshed, navigated away and back,
   signed out and back in. The rental (under its edited name), the cover photo, and the document
   were present at every one of those steps.
3. **Killed the running server process outright** — not a page reload, an actual `kill` of the
   Node process — and started a brand-new process pointed at the same external directory. Signed
   back in: the rental, its edited name, the cover photo (verified the image actually decodes, not
   just that a `<img>` tag is present), and the document (downloaded its real bytes through the
   server and got a 200, not a 404) were all still there. A fresh process reading the same disk is
   exactly what a Render restart, redeploy, or idle cold-start does, so this is the closest thing to
   your live scenario that can be tested without your actual Render service.
4. **As a control, reproduced the original bug fresh:** ran the app with no `DATA_DIR`/
   `UPLOADS_DIR` set (today's out-of-the-box default) under the same "looks like a real deployment"
   conditions, created an owner and a rental, killed the process, deleted the locally-written
   `data/`/`public/uploads/` folders (what a fresh container filesystem looks like with no volume
   attached), and restarted. The app came back on the first-run "create your account" screen — the
   owner and rental were completely gone. Same shape as what was reported.

**What I have not verified:** this environment cannot reach `jason.proroofing.us` or your Render
account, so I have not confirmed persistence through an actual restart or redeploy of your live
service, and I'm not claiming that. Steps 1–3 above prove the *mechanism* the fix relies on
actually works; they don't prove your live service is currently configured to use it. To close that
gap yourself: confirm `DATA_DIR`/`UPLOADS_DIR` are set in Render's environment variables to paths
under an attached persistent disk (Free plan can't attach one — see above), then add or edit
something on the real site, manually restart the service from the Render dashboard, reload, and
check it's still there. That's the one step in the original ask that only you can actually run.

---

## 8. Project layout

```
server/
  db.js                  schema + additive migrations (schema_meta.version tracked)
  seed.js                sample-data generator (npm run seed)
  lib/                   money/date helpers, rent-status logic, auth, and:
                            paymentProvider.js  mock payment processor (§4)
                            bankProvider.js     real Plaid REST client (§5)
                            storageStatus.js    ephemeral-host/misconfigured-persistence detection (§7)
  routes/                one file per resource (properties, leases, financials, tenantPortal,
                            bankAccounts, bankConnections, paymentLinks, systemStatus, …)
public/
  index.html + js/       owner-facing single-page app (hash-based routing, no build step)
                            components.js  shared UI primitives (Modal/Toast/PhotoPicker/…)
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
  photoPicker.test.js    photo picker's HEIC-detection/usable-file pure logic
  formSave.test.js       shared save-lifecycle error-message classification (describeApiError)
```

No bundler, no framework, no build step — edit a `.js` file under `public/` and reload the page.

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

**This update** (renter accounts and a full self-service renter portal — applied directly to your
existing app; every existing property, tenant, lease, photo, document, and financial record was left
exactly as it was; nothing here required you to re-enter anything):

- **Renters can now have their own account and sign in** at `/renter` — separate from, and in
  addition to, the one-time no-login payment link that's always existed (`/pay/link/:token`,
  unchanged). Signed in, a renter sees their own balance and full charge history, documents actually
  shared with them, can file and track maintenance requests, pull next month's rent forward and pay
  it early, and download any statement shared with them — across every lease they're on, past or
  present. Full details in the new §4.
- **A "renter" is its own identity**, separate from the plain tenant name/email that's always been on
  a lease. Add one or more to a lease from the Tenant & Lease tab (co-tenants each get their own
  login), invite them (a secure one-time link you copy and send yourself — no email provider is
  configured, see §4), or remove one (revokes access to that lease without deleting the account).
- **Document sharing reworked to be explicit, per lease** (and, when needed, per individual renter) —
  replacing a single property-wide "shared with tenant" checkbox that couldn't tell one tenant from
  another. A one-time migration carried forward anything already shared under the old model only
  where the intended recipient was unambiguous; anywhere else it's flagged **"Review sharing"** for
  you to resolve by hand rather than guessed at.
- **Rental Payment Statement PDFs** — generate one for a lease (a month, a year, the whole tenancy to
  date, or a custom range), share it to the renter's portal, "email" it (simulated), or delete it.
  Built with a small hand-written, dependency-free PDF writer, since this app has zero npm
  dependencies by design — see "The PDF writer, and a real encoding bug it caught" in §7.
- **Ending a lease now closes the loop properly**: it auto-generates a closing statement for the
  whole tenancy up to the actual move-out date, and a renter who already had portal access keeps
  read-only access to that lease's history afterward. This also surfaced a real, previously-
  undetected bug in how an ended lease's balance was calculated — see "The ended-lease balance bug,
  confirmed" in §7.
- **A related sample-data bug, caught and fixed alongside the sharing rework:** the seed script's
  "shared with tenant" sample documents had quietly stopped being visible to a tenant the moment the
  model above went explicit. Fixed, and the seed script now also creates one fully active
  renter-portal login (credentials printed to your terminal alongside the demo owner account — §1)
  so the renter portal is explorable immediately too.
- 49 new automated tests (151 total, all passing) — see §7.

**Previous update** (mobile photo picker fix, a data-loss investigation and fix, and Saving/Saved UX
across the whole app):

- **Fixed: the mobile photo picker forced the phone camera open instead of offering the photo
  library**, so an existing photo could never be chosen, only a brand-new one taken on the spot.
  The picker now detects HEIC photos (by file type, and by extension when the phone reports no
  type at all) and offers the real library. Covered by 4 automated tests (`test/photoPicker.test.js`).
- **Data loss investigated, root cause identified, and the app now detects and loudly reports the
  unsafe condition instead of failing silently** — a boot-time console warning, a permanent red
  banner in the app itself (before anyone's even signed in), and an unauthenticated
  `GET /api/system-status` check. Full root cause, the fix, and what was actually verified (including
  a real process kill-and-restart, not just a page reload) are in §8's **"Persistence verification,
  step by step"** section.
- **Every save and action across the app shows real Saving/Saved states, tied to the server's actual
  response** — no more optimistic "it probably worked." A failed save keeps your modal open, shows a
  plain-language error, and preserves everything you typed. Rapid double-clicking a save button can
  no longer fire the request twice. Closing a modal (or the browser tab) with unsaved changes asks
  first. Building this surfaced and fixed two real pre-existing bugs: canceling a nested confirmation
  used to destroy the screen underneath it instead of just dismissing the prompt, and canceling out
  of the mobile photo picker after choosing "keep editing" used to leave broken photo previews
  behind. Both fixed and covered by live browser testing.
- 9 automated tests (102 total at the time) covering everything above.

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

The Maple Street Duplex sample tenant also has an active **renter portal** login, so you can see
that side of the app too, at **/renter**:

```
Email:    jordan.alvarez@example.com
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

This runs 151 tests (unit + integration) covering money math, rent-status logic, the full
payment/webhook flow, multi-tenant data isolation, mortgage totals, bank-account linking,
payment-link generation, the mobile photo picker's HEIC handling, the shared save-lifecycle
error-message logic, renter accounts and the renter portal, document sharing, and payment
statements (including the hand-written PDF writer). See §7 for exactly what's covered.

---

## 2. What you're looking at

- **Dashboard** — your whole portfolio: occupancy, scheduled vs. collected rent, overdue rent,
  security deposits held (kept separate from rent income), operating expenses, NOI, cash flow, and
  total cash held across your bank accounts. A bank account linked to more than one property (e.g.
  you deposit rent from two units into one shared checking account) is counted **once**, not once
  per property — this is enforced in the portfolio math itself and covered by automated tests, not
  just something that happens to look right in the demo data.
- **Property pages** — one per rental, each with: a cover photo, an activity/photo timeline
  (with before/after pairing for repairs), documents (shared with a specific lease — or, when
  needed, with one specific renter — never property-wide), transactions, property value & capital
  improvements, mortgage, current tenant & lease (with full rent history, per-period charge status,
  the renters who have portal access to it, and any payment statements generated for it), historical
  tenants (a past lease keeps that same renters/statements detail available, read-only), maintenance
  requests, and reminders (manual ones you add, plus automatic ones for lease expirations and
  documents with an expiration date).
- **Two tenant-facing surfaces, for two different jobs.** A **payment link** (`/pay/link/:token`, no
  login) is the fast path for a one-off payment — generate one from a lease, send it, done. The
  **renter portal** (`/renter`, §4) is the full self-service experience for a renter you've actually
  set up with their own account: balance and full charge history, documents shared with them, filing
  and tracking maintenance requests, paying early, and downloading statements, across every lease
  they're on. Both deliberately show a renter **less** than the owner sees — no bank balances, no
  mortgage details, no private owner notes, and maintenance requests show no vendor or cost — this is
  enforced server-side and covered by tests, not just hidden in the UI.

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
| Maple Street Duplex | Steady on-time tenant, a rent increase partway through, a mortgage with real payment history, three valuations, a capital improvement, one completed + one open maintenance request (with a before/after photo pair), a tenant-shared document and a private one, and an active **renter portal** login (§1, §4) so you can see that side of the app too. |
| Birchwood Bungalow | **Shares Maple's bank account** (proves the no-double-counting math), a messier payment history (on-time, paid-late, two separate partial payments in different months — so you can see the "older unpaid period" callout in action), a high-priority open maintenance request. |
| Cedar Court Cottage | Currently vacant, own separate bank account, one fully-paid **historical** tenant with a deposit returned in full. |
| Willow Loft | **Archived** (hidden from the default dashboard view; find it via the "Archived" toggle), a past tenant whose deposit was **partially withheld**, no bank account linked at all. |

Every sample property (and the bank account the seed script created) is marked internally as
sample data. Click **"Remove sample data"** on the dashboard banner to permanently delete all four
properties — photos, documents, leases, transactions, everything — in one step, once you're ready
to add your own. This is a real delete, not an archive; there's no undo.

---

## 4. Renter accounts & portal

Every lease has always had a plain tenant name/email. A **renter** is a separate, additional thing:
an actual account a tenant can sign in with, at `/renter`, to see their own information instead of
you having to look everything up and relay it to them yourself. A lease can have zero renters
(nothing changes — the payment-link flow in §5 still works exactly as it always has), one, or
several — e.g. two co-tenants, each with their own login.

### Setting a renter up

From a lease's **Tenant & Lease** tab, under **Renters (portal access)**:

- **Add renter** — name, email, phone, and a role (primary/co-renter). The email is what they sign
  in with; it can be added later if you don't have it yet, but nothing can be invited without one.
- **Invite** — generates a secure, single-use link for that renter to set their own password and
  sign themselves in. No email/SMS provider is configured (deliberately — see "What's simulated"
  below), so you copy the link yourself and send it however you'd send anything else.
- **Remove** — revokes that renter's access to *this* lease. It does not delete their account or any
  other lease they're linked to.

Adding the same email on a second lease (the same person renting a different unit later, or a
co-tenant already known from another property) links it to the **same** renter identity rather than
creating a duplicate — they sign in once and see every lease they're linked to. If a duplicate
account does happen to get created some other way, `POST /api/renters/merge` folds one into the
other, transferring its lease access and resolving its old sessions transparently; there is
deliberately no owner-facing UI for this yet — a small enough edge case that a clean API now seemed
more valuable than a speculative screen for it later.

### What a signed-in renter sees

Once signed in, a renter's portal (a separate, smaller page — not the owner's app) shows, per lease
they have access to:

- **Balance & full charge history** — every period, its due/late dates, amount, and what's been
  paid, computed by the exact same `server/lib/rentStatus.js` every other view in this app reads
  from (§2's "Rent status, precisely" applies here too).
- **Pay what's due, or pay early** — the normal "pay what's owed" flow, plus pulling *next* period's
  charge forward to pay it before it would otherwise even appear.
- **Documents** — only ones actually shared with their lease (or with them personally) — never one
  shared with a different tenant, past or present, on the same property.
- **Maintenance** — file a new request and track ones already filed, with the same owner-only fields
  (vendor, actual cost) hidden that the payment-link portal already hides.
- **Payment statements** — download any statement the owner has generated **and shared** (generating
  one doesn't expose it automatically — see below).

A renter whose lease has since ended keeps this same read-only access to that lease's history and
statements afterward (see "Move-out and historical access" below) — signing in still works, there's
just nothing new to pay or file.

### Document sharing, precisely

A document is visible to a renter **only** through an explicit share, scoped to either a lease
(everyone currently on it) or one specific renter (e.g. kept visible to someone individually after
their co-tenant moved out). There is no property-wide "shared with everyone" setting anymore. When
uploading a document you can share it with one or more leases immediately; an already-uploaded
document's **Manage sharing** button changes that later, at any time, for active or ended leases
alike.

This replaced an older, single `is_shared_with_tenant` checkbox that had no way to distinguish one
tenant from another on a property with more than one lease. A one-time migration carried forward
anything already shared under that model — but only onto a property with **exactly one** lease ever,
where the intended recipient is unambiguous; anywhere else (more than one lease, past or present) the
document is left exactly as it was and flagged **"Review sharing"** for you to resolve by hand,
rather than guessed at and potentially shown to the wrong person.

### Payment statements

Generate a PDF statement for a lease over: a specific month, a specific year, the whole tenancy to
date (capped at the lease's own end date once it's ended — never at "today" for a lease that's
already over), or a custom date range. Each statement is an independent, immutable snapshot — a
correction to the ledger afterward never silently rewrites a statement someone may have already
downloaded; generating again just produces a second, more current one alongside the first. From the
list: **Download**, **Share**/**Unshare** (whether it appears in the renter's own portal — separate
from generating it, so you can look a statement over before a renter ever sees it exists), **Email**
(see below), or **Delete**.

The PDF itself is produced by a small, hand-written, dependency-free PDF writer
(`server/lib/pdf.js`) — this app has zero npm dependencies by design (see the top of this document),
and this sandbox's npm registry access is blocked outright, so pulling in a PDF library wasn't
reachable even as an option. See "The PDF writer, and a real encoding bug it caught" in §7 for what
that involved and what it caught.

### Move-out and historical access

Ending a lease (**End lease**, on the Tenant & Lease tab) now also generates a closing statement
automatically, covering the whole tenancy up through the actual move-out date you record — the same
"whole tenancy to date" a statement would show if you generated it by hand, just done for you so
there's always at least one closing statement on file the moment a lease ends. It is **not**
auto-shared with the renter (same reasoning as any other statement: you review it first — a deposit
deduction or last-minute charge is often still being entered right around move-out).

An ended lease moves to **Historical Tenants** and drops off the active Tenant & Lease tab, but it
doesn't lose anything: **View lease details** on a past tenant's card expands, in place, the same
charges, renters, and payment-statements sections the active tab has — so the auto-generated closing
statement (and the ability to invite a renter for the first time purely so they can look back at
their own history — the "historical access" case) both stay reachable, not just the summary facts
(dates, final rent, deposit disposition) that were there before.

### What's simulated

**Invite links and "emailing" a statement are both simulated** — no email or SMS provider is
configured in this environment, the same honest position §5 takes on a real payment provider and §6
takes on a real bank connection. An invite generates a real, working, single-use link that you copy
and send yourself; "Email" on a statement logs what *would* be sent (to the server console) and marks
the statement shared, but no message actually leaves this server. Everything up to that boundary —
the tokens, the expiry, the single-use enforcement, the audit trail — is real and tested; there's
simply no outside provider wired in to hand the message to.

---

## 5. Payments: what's real and what's simulated

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

## 6. Bank accounts

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

## 7. What's actually been tested

**Automated (151 tests across 13 files, `npm test`, all passing):**
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
- **New — Renter accounts & the renter portal** (`test/renterPortal.test.js`, 21 tests): the full
  owner-side lifecycle (add a renter, invite them, preview an invite before it's accepted, adding the
  same email to two leases linking one identity rather than a duplicate); the full renter-side
  lifecycle (accepting an invite sets a password and signs them in immediately, a used invite token
  can't be reused, login rejects a bad password and an unknown email with the **same** generic
  message so no one can enumerate which emails have accounts, forgot-password issues a working
  single-use reset token and the old password stops working afterward, logout actually ends the
  session); a signed-in renter sees the correct balance and **only** their own lease, never another
  owner's; a request with no session cookie at all gets a 401, not a peek at anything; document
  sharing is explicit and lease-scoped, confirmed both that a shared document appears and that one
  shared with a *different* lease on the same property does not; filing a maintenance request through
  the portal attributes it to the correct lease; paying a future period early via the
  advance-charge endpoint, and a checkout on an already-fully-paid charge correctly refused (409); an
  ended lease stays visible to its own renter (historical access) while maintenance/checkout are
  correctly refused on it, and — the regression test for the balance bug below — an ended lease's
  charges (both the list summary and the per-lease detail) exclude every period after its end date;
  merging a duplicate renter reassigns lease access and resolves the old session transparently; a
  statement stays invisible to the renter until the owner shares it, then becomes visible and
  downloadable, and a statement belonging to a different owner can't be shared, emailed, or deleted
  by someone else.
- **New — Payment statement generation & math** (`test/statements.test.js`, 7 tests): totals sum
  correctly across a fully paid, partially paid, and unpaid charge; a refund correctly reduces net
  paid and reopens the outstanding balance; charges outside the requested range are excluded from
  both the totals and the rendered table; a range with no charges at all still produces a valid PDF
  saying so, with zero totals, rather than erroring; sample-property statements are watermarked in
  the PDF and flagged in the serialized record; generating a statement twice for the same lease/range
  produces two independent, immutable rows — never silently overwrites the first; a co-tenant's name
  is included in the statement header when present.
- **New — Owner-facing statement routes** (`test/statementsRoutes.test.js`, 10 tests): generating and
  listing a statement over the HTTP layer (not just the underlying PDF math above), including that
  the owner-facing list carries a downloadable URL and the file route itself still requires
  authentication; a month-range statement uses the calendar month regardless of what day it's
  actually generated on; cross-owner isolation on generate/share/email/delete; sharing toggles
  portal visibility without emailing anything; emailing simulates sending, records who it was "sent"
  to, and auto-shares as a side effect; deleting removes it from the list; **and the specific
  regression this update's biggest bug produced** — a `lease_to_date` statement for an ended lease
  stops at the lease's own end date, not at today (see "The ended-lease balance bug, confirmed"
  below) — plus three more covering the new auto-generated closing statement specifically: ending a
  lease generates exactly one unshared closing statement with the correct range, correcting an
  already-ended lease's end date generates a fresh statement rather than erroring or replacing the
  old one, and ending another owner's lease is refused before it ever generates anything.
- **New — The PDF writer** (`test/pdf.test.js`, 9 tests): see "The PDF writer, and a real encoding
  bug it caught" below.

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

### The ended-lease balance bug, confirmed

**Root cause:** `ensureChargesGenerated` backfills every elapsed monthly period for an **active**
lease up through today, by design — a lease with a start date long in the past generates many
months of charges the first time anyone looks at it. That's correct while the lease is still active,
but nothing ever retroactively removed those rows if the lease was **later ended with a backdated
end date** — recording a move-out that had already happened. The charges table could therefore
contain real rows for periods after the actual move-out date, generated on some earlier day while the
lease was still marked active, before the owner got around to recording exactly when it ended. Every
balance and charge list built on that table — the owner's own lease view, the renter portal, and a
"lease to date" statement — inherited the same inflated, wrong picture: a lease that actually ran 18
months could show 45 periods and tens of thousands of dollars "owed" for time when, by the owner's
own recorded end date, no tenancy existed at all.

**The fix:** a single, tested, shared predicate (`periodWithinLeaseTerm`, in
`server/lib/chargeGenerator.js`) that answers "is this charge period genuinely within this lease's
term" — true for any period on an active lease, true for an ended lease only up to its own end date.
Applied as a **display and query filter** everywhere a lease's charges are shown or totaled (the
owner's lease view, both renter-portal endpoints, and a statement's date-range resolution) —
deliberately **not** a deletion. Payments, payment links, and payment sessions all reference a charge
row by id, so removing a "phantom" charge that happened to already have something recorded against it
would risk breaking that reference or silently discarding a real payment's context; filtering what's
*displayed* achieves the same correctness without that risk, and without touching data that existed
before the fix.

**Verified, not just reasoned about:** a lease started two years in the past (so creating it alone
backfills many months of charges) and then ended six months ago produces charges after that end date
in the raw table by construction — confirmed directly against the database, not assumed — and then
confirmed that none of those post-end-date periods appear in: the owner's own lease view, the
renter's list-of-leases summary, the renter's per-lease detail, or a "lease to date" statement's
rendered range. Four dedicated regression tests, one per surface, are in the automated suite above.

### The PDF writer, and a real encoding bug it caught

Generating a real PDF with zero npm dependencies means writing the handful of PDF operators this app
actually needs by hand (`server/lib/pdf.js`) — positioning text, drawing a straight line, paging —
and, because nothing here is a battle-tested library, testing the *output*, not just the code that
produces it.

That process caught a real bug: PDF's default text encoding (`WinAnsiEncoding`, roughly
Windows-1252) takes exactly one byte per character, but naively UTF-8-encoding a JavaScript string
containing something as ordinary as a middle dot (`·`) or an en dash (`–`) — both used in this app's
own statement layout — emits *multiple* bytes, which a PDF viewer then reads back as several wrong
characters apiece. This wasn't caught by eyeballing generated output; it was caught by actually
decoding it: running a generated statement back through `pdftotext` and comparing the extracted text
against what was written in, which is exactly what `test/pdf.test.js` does for plain ASCII, that
specific punctuation, accented Latin letters, the smart-quotes/ellipsis block, and — a character
genuinely outside WinAnsi's repertoire — confirming it falls back to `?` rather than corrupting
whatever comes after it, instead of silently breaking partway through a page.

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

This same round also added the misconfigured-storage warning banner described in §8. That banner's
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

**Not exercised at all:** anything involving a real payment provider, a real, credentialed Plaid
connection, or a real email/SMS provider for renter invites and statement emails, since none of the
three have credentials configured in this environment (§4, §5, §6) — the code paths are real and
tested up to that boundary, but there is nothing to test past it until you add your own credentials.

### Verified by hand, renter portal & statements update

The renter portal is a second, fully separate front end (`public/renter.html` / `public/js/renter.js`)
with its own authentication, so it was checked live end-to-end in a real browser rather than assumed
correct from the server-side tests alone, across both the renter-facing and owner-facing halves:

1. **Renter accept-invite → sign-in → portal, desktop and mobile.** Starting from a real invite link
   (not a pre-made session), Playwright filled in the accept-invite form, set a password, and landed
   on the renter's lease list. With two leases under the same email — one active, one already ended —
   the lease switcher appeared and correctly offered both, labeling the ended one "(ended)". Opening
   the active lease exercised the Overview, Documents, Maintenance, and Statements tabs in turn; the
   Maintenance tab's "new request" modal was filled in and submitted for real, and the Documents and
   Statements tabs both rendered real shared content (a shared lease PDF, a shared statement) instead
   of an empty state. Switching to the ended lease via the switcher confirmed the historical view
   renders instead of erroring. The same flow was then repeated at a 390×844 mobile viewport (overview
   and the maintenance modal), including confirming the photo picker still offers explicit "Take
   Photo" / "Choose from Library" choices on mobile rather than forcing the camera open — the very bug
   that was item #1 on this project's original list — so that fix is now confirmed intact under the
   newer portal UI too, not just in isolation.
2. **Owner side: adding, inviting, and removing renters.** From a property's Tenant & Lease tab,
   added a second renter to a lease, confirmed the table updated to show both, generated a real
   invite link and confirmed it's a usable URL, then removed a renter and watched the confirmation
   dialog appear and the table drop back to one row — all against a live server, not mocked responses.
3. **The "Active" badge, seen for the first time.** Every renter created in this project's earlier
   testing was pre-invite ("Not invited"), so the "Active" badge branch of the renters table had only
   ever been read in the source, never actually rendered. Using the seed data's demo renter, who has
   a password from the moment `seed.js` creates it, confirmed in a real page that the badge reads
   "Active" and — just as importantly — that the "Invite" button is correctly absent for a renter who
   doesn't need one.
4. **Document sharing, including the pre-checked-checkbox case.** Uploaded a real file with a
   lease-sharing checkbox checked at upload time and confirmed the document's "Shared with" column
   names the renter immediately. Then reopened "Manage sharing" on that same already-shared document
   specifically to check the case that's easy to get backwards: that the checkbox comes back
   **pre-checked**, reflecting the document's actual current state rather than a blank form.
   Unchecking it and saving flipped the column to "Private", confirmed live.
5. **Payment statements, generated and shared.** Generated a lease-to-date statement from the owner
   UI, toggled its "shared with renter" flag on and watched the row update, and clicked "email
   statement" (see "What's simulated" in §4 for exactly what that button does, and doesn't do,
   without a real provider configured).
6. **Ending a lease auto-generates its closing statement, with no extra click.** Filled in the
   end-lease modal (which now explains up front that a closing statement will be generated),
   submitted it, and confirmed both the dynamic toast text ("Lease ended and a closing statement was
   generated") and a new row appearing in Payment statements — with zero manual "Generate statement"
   interaction, matching what `POST /api/leases/:id/end` does server-side (see "The ended-lease
   balance bug, confirmed" above for the related charge-window logic this same route relies on).
7. **Historical Tenants: closing a real reachability gap.** Ending a lease is one thing; finding its
   statement again afterward is another, and the first version of this feature's UI couldn't do the
   second. Historical Tenants originally opened a small modal with only a charges table — the
   auto-generated closing statement and the renters section were both built and tested at the API
   level, but completely unreachable by clicking anything. Rebuilt as an inline "View lease details"
   expansion instead, and confirmed live: charges, renters, and statements all appear inline, and —
   the specific case this design exists to get right — opening a real "Generate statement" sub-modal
   from inside that inline view and saving it leaves the view intact afterward (still showing
   "Renters (portal access)" and "Charges", now with two statement rows instead of one) rather than
   being silently destroyed. That is what would have happened with the more obvious approach of
   nesting a second `Modal.open()` inside the first, since this codebase's modal is a single-slot
   singleton that tears down whatever's currently open before showing something new (the same reason
   `confirmDialog` is deliberately its own overlay, not a nested modal) — caught and redesigned before
   this ever shipped, not after. Finally, added and invited a renter directly from inside a historical
   lease's detail view, confirming that "granting historical access after the fact" case works too.
8. **The seed data actually demonstrates what it claims to.** While wiring up the demo renter for the
   checks above, found that `seed.js`'s sample "shared" lease-agreement documents weren't actually
   shared under the current sharing model — they only set the old `is_shared_with_tenant` flag, which
   the renter portal stopped reading once sharing moved to explicit `document_shares` rows. Fixed
   `seed.js` to insert real shares, then confirmed — over real HTTP calls, not by reading the seed
   code — that the demo renter can log in and actually see the lease-agreement document the seed
   data claims to share with them.
9. **No new console/page errors** were observed in any of the above, checked by listening for both
   for the duration of each run.

---

## 8. Security notes

- Passwords are hashed with Node's built-in `scrypt` (random salt per password, timing-safe
  comparison) — no plaintext, no reversible encoding. Renter passwords go through the exact same
  `scrypt` helper — there's no separate, weaker password path for renters.
- Sessions are random 32-byte tokens stored server-side (not JWTs) with a 30-day expiry, sent as an
  `HttpOnly`, `SameSite=Lax` cookie so client-side JavaScript can't read it and it isn't sent
  cross-site. The cookie also gets the `Secure` flag automatically once `APP_BASE_URL` is an
  `https://` URL (see the deploy note below) — it deliberately does *not* set `Secure` when you're
  just running this on `http://localhost`, because browsers would silently drop the cookie
  entirely and you'd never be able to sign in.
- Renter sessions are entirely separate from owner sessions — their own `renter_sessions` table,
  their own `renter_session` cookie (distinct from the owner's), with the same `HttpOnly`/
  `SameSite=Lax`/conditional-`Secure` treatment. That separation means a renter session can never be
  mistaken for an owner session even if a route accidentally ran the wrong check, and it lets an
  owner and a renter be signed in from the same browser at once without clobbering each other's
  cookie. Invite, email-verification, and password-reset links are single-use tokens in their own
  table (`renter_tokens`), each purpose with its own expiry (30 minutes to 14 days depending on
  which); issuing a new one immediately invalidates any earlier unused one of the same purpose, so
  only the most recently sent link ever works.
- Every write to money, leases, and archival/deletion actions is recorded in an append-only audit
  log (`audit_log` table: who, what, before/after, when) — nothing here is "fire and forget."
  There's no UI to browse it yet, but the data is there (`SELECT * FROM audit_log ORDER BY id DESC`).
- The one webhook signing secret and the server's own secret are generated randomly on first run
  and written to `data/` with `0600` permissions — never hard-coded, never checked into version
  control (see `.gitignore`).
- Every property/financial/tenant-scoped route checks that the resource actually belongs to the
  signed-in owner before returning anything (tested — see §7's "data isolation" line).

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

**You should also** read §5 and connect a real payment provider before sending a real tenant a real
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
in §7 (visible Saving/Saved states, inline errors that preserve your input, a warning before
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

## 9. Project layout

```
server/
  db.js                  schema + additive migrations (schema_meta.version tracked)
  seed.js                sample-data generator (npm run seed)
  lib/                   money/date helpers, rent-status logic, auth, and:
                            paymentProvider.js  mock payment processor (§5)
                            bankProvider.js     real Plaid REST client (§6)
                            storageStatus.js    ephemeral-host/misconfigured-persistence detection (§8)
                            renterAuth.js       renter session/token issuance — separate from owner
                                                  sessions by design (§8)
                            renters.js          renter/lease-renter data access, incl. what makes a
                                                  renter "Active" vs "Not invited" (§4)
                            renterAccess.js     what a signed-in renter may see (documents, charges) —
                                                  the enforced source of truth for sharing (§4)
                            pdf.js              zero-dependency PDF writer used for statements (§4/§7)
                            statements.js       statement generation/PDF-rendering pipeline (§4/§7)
  routes/                one file per resource (properties, leases, financials, tenantPortal,
                            bankAccounts, bankConnections, paymentLinks, systemStatus, …), plus:
                            renterAuth.js       renter sign-up/login/invite-accept + tokens (§4)
                            renterManagement.js owner-facing add/invite/remove-renter endpoints (§4)
                            renterPortal.js     the signed-in renter's own API — balance, documents,
                                                  maintenance, statements (§4)
                            statements.js       generate/list/share/email/delete statements (§4/§7)
public/
  index.html + js/       owner-facing single-page app (hash-based routing, no build step)
                            components.js  shared UI primitives (Modal/Toast/PhotoPicker/…)
                            views/bankAccounts.js  Bank Accounts page + per-property section,
                              including the Plaid Link browser flow
  tenant.html + tenant.js  the payment-link surface (`/pay/link/:token`) — no account, one-off (§2)
  renter.html + renter.js  the renter portal (`/renter`) — full renter accounts, sign-in required (§4)
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
  renterPortal.test.js   renter accounts: invite/accept, sign-in, merge, portal-visible data (§4/§7)
  statements.test.js     statement generation math and the PDF-rendering pipeline (§4/§7)
  statementsRoutes.test.js  owner-facing statement routes: generate/list/share/email/delete (§7)
  pdf.test.js            the PDF writer itself, including the encoding bug it caught (§7)
```

No bundler, no framework, no build step — edit a `.js` file under `public/` and reload the page.

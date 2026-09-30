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

**This update** (real SMS invitations, a hardened separate renter login, self-serve sign-up with
connection codes, a reworked Unassigned Renters list, and a simplified renter waiting screen —
applied directly to your existing app; every existing property, tenant, lease, photo, document,
financial record, renter, and signed lease agreement was left exactly as it was):

- **"Send Renter Portal Link" can now actually text the link.** A real Twilio integration
  (`server/lib/smsProvider.js`) sends the invitation by SMS once you've added your own Twilio
  credentials — you review the exact phone number and message text before anything goes out, "Copy
  Link" still works exactly as it always has for sending the link yourself another way, and delivery
  is tracked through real, honestly-reported states (queued → sent → delivered/failed) rather than
  ever just claiming "Sent." With no credentials configured, the app says so plainly instead of
  pretending to send anything. See "Sending renter invitations by SMS" in §4 for the exact setup.
- **An expired invitation link can no longer lock out an existing renter.** Accepting an invite and
  signing in afterward are enforced as two genuinely separate things now, so a renter who already has
  a password can always sign in directly at `/renter` (or reset it) regardless of whether some
  unrelated invitation link has since lapsed.
- **`/renter` is now a hardened, dedicated login, not just an accept-invite landing page** — Email/
  Password sign-in, "Forgot password?", and "Make a New Account," with no "Remember Me": every
  session actually enforces a sliding inactivity timeout (30 minutes by default, configurable) rather
  than counting on the browser ever being "closed," and Sign Out always ends it immediately. See "The
  renter session model, precisely" in §4.
- **A renter can now create their own account from nothing.** Full name, phone (with country code),
  email, password, and a landlord **connection code** (a short, shareable code — an alternative to a
  per-person link, good for a flyer or something read aloud) are all required and validated; password
  rules are length-only (8+ characters, no forced character classes), matching the spec this was built
  against. Building this turned up and closed a real account-takeover gap — see "A real security gap,
  found and closed" in §8.
- **Unassigned Renters is now a proper dashboard section**, not an easy-to-miss list: collapsible,
  a live count badge, search by name/email/phone, a scrollable table with signup date and status
  (Invited / Pending verification), a manual Refresh, and "Assign to Property" right in the row.
- **A renter waiting on assignment or a lease signature now sees exactly one honest screen** —
  "Waiting on assignment," never your dashboard, an internal status, or an empty financial figure —
  with a "Review and Sign Lease" button appearing the moment it's actually their turn, and Profile/
  Sign Out always reachable. An existing renter with history on another lease keeps full access to it
  the entire time, alongside the waiting state for the new one. See §4.
- 23 new automated tests (203 total, all passing) — see §8.

**Previous update** (invite a renter all the way through a signed, synced lease):

- **A renter can now be invited, assigned to a property, and walked through an actual e-signed lease**
  without you re-typing anything you've already recorded. Full write-up in §5: invitations and the
  Unassigned Renters list, assigning to a property (a "Lease Pending" draft tenancy — never a
  guessed-at active one), preparing the lease from a reusable template with a live PDF preview, the
  landlord signing and sending, the renter reviewing and signing (or declining, or asking for a
  correction), and what happens once every required signer is done.
- **Lease templates are structured and reusable**, organized by a jurisdiction label you set — a
  clearly-labeled sample template is provided so there's always something to start from, and it's
  immutable; duplicate it to make your own editable one. See "Lease templates, precisely" in §5.
- **Signing is real, consent-gated, and audited** — explicit e-signature consent before every
  signature, a server-recorded timestamp (never the browser's clock), a distinct final "Sign and
  Accept Agreement" action that can't be triggered by anything else, and a full audit trail (who
  consented, who signed, when, plus the completed document's own integrity hash) available to the
  owner and every actual signer. A signed, sent version is frozen — changing terms after that voids
  and replaces it with a fresh one, never edits it in place. See "Real signing: what's actually
  implemented" in §5 for exactly what this does and doesn't mean next to a real e-signature provider.
- **Completion syncs straight into the tenancy** — rent and deposit flow into the lease's own billing
  the moment the last signature lands, without rewriting a single historical charge, duplicating the
  lease, or marking a future tenancy occupied before its start date. A former tenant keeps access to
  their own completed agreement afterward and never sees a later renter's.
- 29 automated tests added at the time (180 total then) — see §8.

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

This runs 203 tests (unit + integration) covering money math, rent-status logic, the full
payment/webhook flow, multi-tenant data isolation, mortgage totals, bank-account linking,
payment-link generation, the mobile photo picker's HEIC handling, the shared save-lifecycle
error-message logic, renter accounts and the renter portal, document sharing, payment statements
(including the hand-written PDF writer), the full invite-to-signed-lease workflow (including the
e-signature audit trail and the demo signing adapter), and SMS invitations, the renter session model,
self-serve sign-up, and the Unassigned Renters list from this update. See §8 for exactly what's covered.

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
- **Getting from "found a renter" to "have a signed lease"** used to mean handling that entirely
  outside this app. Now: invite the renter, assign them to a property, prepare and sign the lease
  yourself, and send it for their signature — all from here, with a full audit trail once it's done.
  See §5.

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
(nothing changes — the payment-link flow in §6 still works exactly as it always has), one, or
several — e.g. two co-tenants, each with their own login.

### Setting a renter up

From a lease's **Tenant & Lease** tab, under **Renters (portal access)**:

- **Add renter** — name, email, phone, and a role (primary/co-renter). The email is what they sign
  in with; it can be added later if you don't have it yet, but nothing can be invited without one.
- **Invite** — generates a secure, single-use link for that renter to set their own password and
  sign themselves in. Copy it yourself and send it however you like, or — see "Sending renter
  invitations by SMS" below — text it to them directly from the same modal.
- **Remove** — revokes that renter's access to *this* lease. It does not delete their account or any
  other lease they're linked to.

Adding the same email on a second lease (the same person renting a different unit later, or a
co-tenant already known from another property) links it to the **same** renter identity rather than
creating a duplicate — they sign in once and see every lease they're linked to. If a duplicate
account does happen to get created some other way, `POST /api/renters/merge` folds one into the
other, transferring its lease access and resolving its old sessions transparently; there is
deliberately no owner-facing UI for this yet — a small enough edge case that a clean API now seemed
more valuable than a speculative screen for it later.

Beyond a per-lease invite, the dashboard's **Renters** card has two more ways to get someone started,
covered in full below: **Send Renter Portal Link** (a one-off invite by SMS, not tied to any lease
yet — useful when you haven't assigned a property so far) and a standing **connection code** a renter
can type into their own "Make a New Account" screen with no link at all.

### Sending renter invitations by SMS

**This is real, working SMS — not a simulation — once you add your own Twilio credentials.** Every
route talks to "the SMS provider" through one small interface (`server/lib/smsProvider.js`), the same
shape §6 uses for payments and §7 uses for bank connections, calling Twilio's plain REST API directly
with Node's built-in `fetch` (no `twilio` npm package, to keep this app's zero-dependency design — see
the top of this document).

From the dashboard's **Renters** card, **Send Renter Portal Link** opens a modal that:

1. Generates (or reuses) that renter's invitation link — the exact same link **Copy Link** would give
   you, so texting it never creates a second, different invitation.
2. Lets you fill in a phone number (with a country-code picker) and **review the exact message
   text** — prefilled with the link, editable around it — before anything is sent. Nothing goes out
   without you looking at the phone number and the words first.
3. Sends it, and shows the real state Twilio reports back: **Not sent** (no provider configured —
   see below), **Sent**, **Delivered**, or **Failed**, updating automatically as Twilio's own status
   callback arrives (see "Delivery status, honestly" below) — never a fake "Sent" shown optimistically
   before the provider has actually accepted the message.

**Without Twilio credentials configured, the modal says so plainly** — "SMS sending isn't set up on
this server yet. Copy the invitation link and send it yourself for now" — and **Copy Link** keeps
working exactly as it always has. This is the same honest posture §6 takes on a real payment
processor and §7 takes on a real bank connection: no fake-looking "Sent" state, ever.

**To turn it on:**

1. Create a free account at [twilio.com/try-twilio](https://www.twilio.com/try-twilio) and buy (or
   use the trial) a phone number capable of sending SMS.
2. Set these environment variables before starting the server:
   ```
   TWILIO_ACCOUNT_SID=...
   TWILIO_AUTH_TOKEN=...
   TWILIO_FROM_NUMBER=+15551234567     # the E.164 number you send from
   ```
   (Advanced/optional: `TWILIO_MESSAGING_SERVICE_SID` instead of `TWILIO_FROM_NUMBER`, if you've set
   up a Twilio Messaging Service — Twilio's recommended approach once you're sending from more than
   one number. Either one alone is enough; if both are set, the Messaging Service is preferred.)
3. Restart the app. That's it — `isLiveModeConfigured()` flips on the moment credentials are present,
   and "Send Renter Portal Link" starts sending for real instead of showing the setup-required state.
4. **Recommended:** also set `APP_BASE_URL` to this server's real, publicly-reachable `https://`
   address (the same variable §9's deploy note asks for). This is what lets Twilio call back with a
   delivery status (below) — on an address Twilio itself can't reach (`localhost`, a private network),
   messages still send, they just visibly stay at "Sent" here forever, since nothing can tell this
   server what happened next. The invite modal states this plainly rather than assuming "Delivered."

**Delivery status, honestly.** Sending a text only ever tells you Twilio *accepted* the message for
delivery (status "queued"/"sent") — whether a handset actually received it is something Twilio only
learns afterward and reports asynchronously, over a signed webhook (`POST /api/webhooks/twilio-sms`,
handled in `server/routes/smsWebhooks.js`). That handler verifies Twilio's `X-Twilio-Signature`
(HMAC-SHA1 keyed by your Auth Token over the callback URL and its parameters — Twilio's own documented
algorithm) before trusting anything in the payload, exactly like `server/routes/webhooks.js` already
does for the payment provider, and a status can only ever move forward — a **delivered** or **failed**
message is never regressed back to an earlier state by a stray retried callback.

Every text sent (or attempted) is recorded in `sms_messages` — including an honest `not_configured`
row when no provider is set up, so the owner's own invite history never silently drops a message it
couldn't actually send.

### The connection code, precisely

Your **connection code** (shown on the dashboard's Renters card, and lazily generated the first time
anything asks for it) is a short, human-shareable code — 8 characters, from an alphabet that excludes
visually-ambiguous ones like `0`/`O` and `1`/`I`/`L`, meant to be read aloud or copied off a printed
page. A renter types it into their own **Make a New Account** screen (no link, no invitation from you
at all) and it tells the app which owner's Unassigned Renters list the resulting account belongs to —
the one piece of context a bare self-serve sign-up otherwise wouldn't have. **Regenerate** immediately
invalidates the old code for new sign-ups; anyone who already made an account with it keeps that
account regardless — regenerating only closes the door for whoever hasn't used it yet (say, if it
leaked somewhere public by mistake).

### Signing in, and the renter session model

`/renter` is a dedicated, self-contained login — **Email**, **Password**, **Sign in**, **Forgot
password?**, and **Make a New Account** — entirely separate from the owner's own `/` login, with its
own session cookie (`renter_session`, distinct from the owner's) so the two can never be confused and
an owner previewing their own site can be signed in alongside a renter in the same browser without
either one clobbering the other's cookie.

**Making a new account through "Make a New Account"** requires **Full name, Phone (with a country
code), Email, Password, Confirm password, and a landlord connection code** — every field mandatory and
validated, never silently optional (accepting an owner-sent invitation link, "Invite" above, is a
separate, simpler path that only ever asks for a password, since the owner has usually already
supplied the rest). Password rules are **length-only** (8 characters minimum, no forced mix of upper/lower/digits/
symbols) on both paths, by design, per the spec this was built against; **Show/Hide** is available on
both password fields on the sign-up screen so you can check what you typed before submitting.
Passwords are hashed with the exact same `scrypt` helper (§9) the owner's own account uses — there is
no separate, weaker path for renters.

**No "Remember Me," and an honest definition of "a new visit."** The renter session cookie carries no
`Max-Age`, so browsers treat it as a session cookie — but this app doesn't *rely* on that, since
plenty of mainstream browsers and mobile OSs restore tabs (and their cookies) across what looks, to
the person, like closing the browser. What's actually enforced, tested, and true on every single
request is a **sliding inactivity timeout**: 30 minutes by default (`RENTER_SESSION_IDLE_TIMEOUT_MINUTES`
env var to change it), measured from whatever the renter last did. As long as they keep doing anything
— browsing, paying, signing — with gaps shorter than the timeout, the session stays alive exactly as
long as it should; the first gap longer than that ends it, and the next request they make is rejected
with a plain "you've been signed out after N minutes of inactivity" message rather than a confusing
dead page. **Sign Out** (always reachable — see below) ends the session immediately either way.
Re-authenticating after a timeout never loses anything: nothing on the renter side writes optimistically
before the server confirms, so a timed-out request surfaces as the same plain, inline "please sign in
again" error the rest of this app already uses for an expired session (§8's save-lifecycle work), and
a payment retried after signing back in can't double up either, since the checkout/webhook flow (§6)
was already idempotent end to end.

**A self-serve sign-up must verify its email before it can sign in.** `POST /api/renter/login` now
checks `email_verified_at`, not just the password — see "A real security gap, found and closed" in §8
for exactly why this matters and what it closes. Accepting an owner-sent invitation link counts as
proof of that email immediately (opening a link the owner generated and sent already establishes
ownership), so this only ever actually pauses the self-serve **Make a New Account** path, and only
until the console-logged verification link (no email provider is configured — see "What's simulated"
below) is clicked. The login screen surfaces this as a plain "verify your email" message with its own
**Resend verification link** action, rather than the generic wrong-password error.

### Waiting on assignment, until there's a full portal to show

A renter who has signed in but has no completed tenancy yet — no property assigned, or assigned but
the lease isn't fully signed — sees exactly **one** honest screen, "Waiting on assignment," and
nothing else: never the owner's dashboard, an internal status name, or a $0.00 financial figure that
would look like a real, empty account. The moment there's actually something for them to do, the
heading stays the same but a working **Review and Sign Lease** button appears (reusing the exact same
signing modal §5 describes — there is only one signing code path in the app, reached two different
ways). **Profile** and **Sign Out** are always reachable from this screen too — being kept waiting on
a landlord is never also a reason to be locked out of your own contact details.

Critically, this never hides a renter's **other** history: if the same renter already has full access
to an active or ended lease elsewhere, that tenancy stays completely unaffected and one click away
("You still have full access to your other tenancy") — the waiting state applies only to the one
tenancy that isn't ready yet, never to the account as a whole. See "Move-out and historical access"
below for the ended-lease side of this same guarantee.

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
reachable even as an option. See "The PDF writer, and a real encoding bug it caught" in §8 for what
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

**SMS is real (once you configure Twilio — see above); email is not.** No email provider is
configured in this environment, the same honest position §6 takes on a real payment provider and §7
takes on a real bank connection: an invite always generates a real, working, single-use link, which
you can copy and send yourself, text via Twilio as covered above, or hand over however else you like;
"Email" on a statement, a verification link, and a password-reset link all log what *would* be sent
(to the server console) and update in-app state (marking a statement shared, and so on) rather than
delivering anything externally. Everything up to that boundary — the tokens, the expiry, the
single-use enforcement, the audit trail — is real and tested for every one of these; there's simply no
outside email provider wired in yet to hand the message to. To close that gap, follow the same seam
§6 and §7 already use: a small adapter (e.g. `server/lib/providers/emailProvider.js`) that the routes
currently logging to the console would call instead, using whichever transactional-email service you
choose (SendGrid, Postmark, AWS SES, and so on all work the same way — an API call with your own
credentials).

---

## 5. Lease agreements: invitation to a signed lease

Once a renter has an account (§4), turning them into an actual tenant with a signed lease is its own
guided flow — the whole distance from "I found a renter" to a fully executed agreement with rent
already flowing into the tenancy's ledger. None of the sample data comes with one of these already in
progress; to see it, invite a renter from the dashboard (**Invite Renter**) and follow along — the
whole path takes a few minutes end to end.

### Unassigned renters, and assigning one to a property

A renter who signs up through a general invite, a texted link, or their own connection code (rather
than being added directly to a specific lease, per §4) has an account but nothing to do with it yet.
They show up in the **Unassigned Renters** panel on the dashboard until an owner assigns them
somewhere — there's no cross-landlord directory, and a renter appears under *your* account only once
they've accepted a secure invitation or signed up with a code tied to it.

The panel itself is a collapsible section (a live count badge in its header either way) rather than
something you could miss: expanded by default, it shows each renter's full name, phone, email, signup
date, and status (**Invited** — has a link out but hasn't set a password yet; **Pending verification**
— set a password via self-serve sign-up but hasn't confirmed their email yet, see §4; or no badge at
all once fully active), searchable by name/email/phone, in a scrolling list so a long one never pushes
the rest of the dashboard down the page. **Refresh** re-fetches the list on demand — this app updates
this list (and everything else) on manual refresh rather than a live/polling connection, so a renter
who just signed up on their own phone won't appear until you click it or reload. A renter drops off the
list the moment they're assigned, and it reads "No unassigned renters" rather than just showing nothing
when it's empty.

Assigning one to a property creates a **draft tenancy**, not an active lease. The property shows a
**Lease Pending** badge everywhere it appears (dashboard, property card, the property page itself)
until a lease is actually signed: no rent is scheduled, no charges are generated, and the unit doesn't
count as occupied. The app also refuses a second draft or active tenancy on a property that already
has one pending, and refuses adding a manual tenant to a property that's mid-assignment — one property,
one tenancy, no accidental double-booking or double billing. From the draft tenancy's page, a prominent
**Send Lease Agreement** button opens lease preparation; the assignment itself sends nothing to the
renter on its own.

### Lease templates, precisely

Every lease is prepared from a **template** — reusable clause text plus a placeholder for each field
that changes lease to lease (names, address, rent, dates, and so on). A brand-new account gets exactly
one, automatically: a clearly labeled **"Standard Residential Lease (Sample)"** template, watermarked
as sample data in both the template list and every PDF built from it, and it's **immutable** — editing
or deleting it is refused outright. **Duplicate** it to get your own editable copy (or write one from
scratch), give it a name and a jurisdiction label of your own choosing (a free-text field for your own
organization — e.g. "California" or "Ontario — residential," not a legal database of per-jurisdiction
requirements), and edit its clauses and placeholders freely. Templates are per-owner and listed
together regardless of jurisdiction, so separate templates for separate states/provinces/property
types sit side by side.

**This is a structured, text-based template system, not a visual PDF/DOCX designer.** You can't upload
an existing lease document (a Word file, a scanned PDF) and click-to-place signature boxes on it —
templates are edited as text with placeholders, and the output is always this app's own generated PDF
layout. If your business already has a lease document it's required to use as-is, this app doesn't
reproduce its exact layout; it can only build an equivalent structured version of its content.

**Required fields are enforced, not just suggested.** Preparing a lease won't let you finalize (or
sign) it until landlord and tenant/co-tenant names, the property address and unit, rent, deposit, the
term (a fixed end date or month-to-month), the rent due day, grace period and late terms, occupants,
utilities responsibility, and both signature blocks are all filled in — finalizing with anything
missing is rejected with the exact list of what's still needed, never silently accepted with a gap in
it.

### Preparing a lease

Opening **Send Lease Agreement** on a draft tenancy opens an editable form next to a live PDF preview
of the exact document that will eventually be signed — every field you change updates the preview
immediately. Known facts (the property's address, the tenant's name from the renter record, the rent
already set on the tenancy) are **prefilled**, but you review and can correct every one of them before
anything is finalized; nothing is invented on your behalf, and no clause appears in the output that
didn't come from a field you filled in or a template you chose. The draft **saves persistently** as
you go — close the tab and come back tomorrow, it's exactly as you left it — and you can preview the
PDF at any point, finished or not, before you'd ever commit to sending it.

### Landlord signs, then sends

Finalizing a lease (only possible once every required field above is filled in) moves straight into
signing: explicit e-signature consent, a signature in your own field, and a **server-recorded
timestamp** — the lease's commencement date (whatever start date is on the lease itself) is always
tracked completely separately from the date it was actually signed, so a lease starting next month
never looks like it was signed in the future or vice versa. Once you sign, you confirm the tenant
recipients and hit **Send for Signature**. From that instant the document is **frozen** — this exact
version, with your signature on it, is what the tenant will see, and it can never be edited in place.
Needing to change a term afterward means **voiding** the agreement and preparing a fresh one; the new
version carries the old field values forward so you're not retyping everything, gets its own version
number, and the superseded copy is kept, not deleted — a signature is never carried onto changed terms.

### The renter reviews and signs

The moment a lease is sent, every tenant/co-tenant it names sees it the next time they're on their
**Waiting on assignment** screen (§4) — the heading stays the same, but a **Review and Sign Lease**
button now appears, since this tenancy has no completed lease yet and so never shows the full tab
dashboard in the meantime (the same reasoning as the "Waiting on assignment" writeup in §4: never a
half-populated dashboard for something that isn't real yet). Opening it lets them read and download
the full document (with the landlord's signature already on it) before doing anything else. Signing
requires its own explicit consent checkbox — never pre-checked — and a
distinct, separate **"Sign and Accept Agreement"** action; typing a name into a text field is never
treated as a signature by itself. A tenant can instead **decline** (with a required message explaining
why) or **request a correction** (also with a message) — either one blocks further signing until the
owner voids and replaces the agreement, and both notify the owner. With **co-tenants**, each signs in
their own field over their own session; one signer can never see or complete another's signature, and
the agreement only reaches "partially signed" rather than "awaiting renter signature" once it actually
knows one of two required renters has signed and the other hasn't — one signature on a two-renter lease
is never silently treated as a completion.

### Completed: the final PDF and the audit trail

Once every required signer — landlord plus every named tenant/co-tenant — has signed, the agreement
moves to **Completed** and three things happen at once: a final signed PDF is generated and saved
**permanently** under the lease (every signature and its date, laid out on the document itself); the
lease's rent and deposit are **synced into the tenancy** (below); and a **signing audit record** is
finalized — the document's version, every recipient's identity, every consent and signing event with
its server timestamp in order, plus a **SHA-256 hash of the completed PDF itself**, so the file can be
checked against tampering later. Both the owner and every actual signer can open the audit trail,
download the final PDF, or share it by email (simulated — below); a completed agreement is
**immutable** — the only way to change terms after this point is a brand-new agreement, never an edit
to this one.

### Status tracking, reminders, and lease sync

An agreement is always exactly one of: **Draft**, **Awaiting landlord signature**, **Awaiting renter
signature**, **Partially signed** (some but not all renters have signed), **Changes requested**,
**Completed**, **Declined**, or **Voided**. From the lease's page, an owner can review it at any stage,
send a **reminder** to whichever signers haven't acted yet, or **void** it outright. Re-sending never
duplicates an agreement — there is always exactly one open agreement per lease, plus whatever
voided/declined history led up to it.

On completion, the sync into the tenancy is deliberately conservative: it **updates** the lease's rent
and deposit-required figures rather than ever duplicating the lease row; a new rent figure lands as a
new, append-only row in the rent history (never rewriting what an earlier period actually charged); the
security deposit *held* is never touched by signing alone — only what's *required* changes, since
signing a lease isn't the same as actually receiving the deposit; and a tenancy with a future start
date is marked active without generating a single charge before that date arrives (charge generation
only ever runs up through today, regardless of status). A **former tenant** keeps access to their own
completed agreement after their lease ends, and, on a property that's since been re-let, never sees the
new tenant's agreement — access is scoped to the specific agreements a renter actually signed, not to
the property in general.

**One known gap, disclosed rather than glossed over:** invitation *links* expire (§4) and are enforced
as such, but a *sent lease agreement* itself has no automatic time-based expiry — an owner who wants to
cancel a stale, unsigned agreement needs to void it by hand rather than waiting for it to lapse on its
own.

### Real signing: what's actually implemented

I looked for an existing e-signature integration in this codebase first and found none — this is a new
build. Every agreement carries a `provider` field, exactly like payments (§6) and bank connections
(§7), specifically so a real provider can be dropped in later without redesigning anything; today that
field is always `"demo"`. I want to be precise about what that means, the same way §6 is precise about
the payment processor:

**What's real:** explicit consent capture, server-side timestamps, per-signer authentication and
tamper-proofing (a signing action always looks up the caller's *own* signer record — never a
client-supplied id — so one signer can't complete another's fields even by editing a request by hand),
the freeze-on-send/void-and-replace mechanics, the generated PDF, and the full audit trail with its
SHA-256 document hash. All of it is exercised by the automated tests in §8.

**What's not real:** this is this application's **own** signing workflow, not a connection to
DocuSign, Dropbox Sign, Adobe Sign, or any other third-party e-signature provider — I never call it by
one of those names, and the completed PDF says so on its own audit page rather than implying a
provider-issued certificate. It doesn't carry the specific legal assurances a dedicated e-signature
provider does (provider-side tamper-evident certificates, provider-hosted long-term audit storage,
jurisdiction-specific consumer e-signature disclosures, and so on) — those come from the provider
itself, not from this code, however carefully the workflow around it is built.

**To connect a real provider,** the shape to follow is the same seam §6 uses for payments:

1. Create an adapter (e.g. `server/lib/providers/docusignProvider.js`) that the agreement routes call
   instead of writing directly to `provider: 'demo'` — exposing, at minimum, a way to create an
   embedded or emailed signing session per recipient, and a webhook handler that verifies the
   provider's signature and marks the corresponding signer complete.
2. **Verify webhooks the same way `server/routes/webhooks.js` already does for payments:** check the
   provider's signature before trusting anything in the payload, and make replaying the same event a
   no-op — a real provider will redeliver events, and a duplicate must never double-record a signature
   or re-trigger completion.
3. **Never let a browser redirect alone mark anything signed.** The pattern this app already uses for
   a "payment succeeded" page (§6) applies identically here: a signing-complete redirect is just a
   page; only a verified, server-side event (the provider's webhook, or this app's own consent-and-
   signature submission today) is allowed to change an agreement's status.
4. Until real credentials are configured, keep production sending disabled and show the same kind of
   plain, honest "not connected yet" state this app already shows for Plaid (§7) — never a fake-looking
   signing session.

I didn't build against a real provider's API without real credentials to test it against, for the same
reason §6 gives for payments: code written against an API that's never actually been exercised looks
connected without ever being proven to work.

### What's simulated

Same email boundary as §4: **no email provider is configured**, so "Send for Signature," a reminder,
and emailing a completed agreement all log what *would* be sent to the server console and update the
in-app state (the renter's waiting screen, the reminder timestamp) rather than delivering anything
externally. This is a separate action from the renter-invitation SMS covered in §4 — texting is only
wired up for the initial portal invite, not for a lease-agreement reminder or a completed-agreement
email — so those still go out exactly the way §4 describes for a statement email. Everything up to
that boundary is real and tested; there's no outside provider wired in to hand the message to.

---

## 6. Payments: what's real and what's simulated

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

## 7. Bank accounts

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

## 8. What's actually been tested

**Automated (203 tests across 15 files, `npm test`, all passing):**
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
- **New — Lease agreements** (`test/leaseAgreements.test.js`, 29 tests): a generic invite appears in
  Unassigned Renters immediately (not gated on acceptance), a duplicate invite is rejected (409), an
  expired/invalid token is rejected (410); assigning a renter creates a draft lease with **no** rent
  history yet, removes them from Unassigned Renters, and surfaces on the property record — and a
  second assignment to an already-pending property is rejected (409); the built-in sample template
  can't be edited or deleted (409 on either) but can be duplicated into an editable copy, and its
  placeholders/prefill are correct, including the tenant as a signer; finalizing with any required
  field missing is rejected with the exact missing-field list, never silently accepted; a preview PDF
  can be generated at any stage; once finalized, the agreement's body is frozen (edits rejected, 409)
  and voiding-then-replacing increments the version, carries `replacesAgreementId`, and carries the
  old field values forward while preserving the superseded row untouched; landlord signing validates
  consent and the signature field, refuses a second signature, and — the regression guard for a bug
  fixed earlier in this build — lands on **"awaiting renter signature," not "partially signed,"**
  after only the landlord has signed; a renter who isn't an actual signer on the agreement gets a 404,
  never a peek at someone else's lease; declining requires a message and blocks further signing;
  requesting a correction blocks signing until the owner voids and replaces the agreement; a two-signer
  (primary + co-tenant) lease correctly reads "partially signed" after only one has signed, with each
  signer's own action isolated from the other's, including a same-email dedup case; the full audit
  trail's event order matches `created → finalized → consented → signed → sent → consented → signed →
  completed` identically from the owner's and the renter's own view; completion generates the final
  PDF and its hash, syncs rent/deposit into the tenancy exactly once (a replayed completion event
  doesn't duplicate the rent-history row), and a future-dated lease's start produces zero charges
  despite being marked active; emailing the agreement is refused before completion and allowed after;
  and former-tenant isolation is tested against a realistic **same-property, sequential-tenant**
  scenario — ending one lease and assigning a new renter to the same now-vacant property, then
  confirming the first renter still sees their own completed agreement and gets a 404 on the second
  renter's, not a 403 that would reveal it exists.
- **New — SMS invitations, the renter session model, self-serve sign-up, and Unassigned Renters**
  (`test/renterWorkflowUpdate.test.js`, 23 tests): **Copy Link** still returns a plain, unconditional
  URL regardless of SMS configuration; sending by text with no Twilio credentials records an honest
  `not_configured` status rather than a fake "Sent," and, configured, validates the phone number and
  refuses to send unless the actual invitation link is present in the message text; SMS routes refuse
  once a renter already has an account or before any invitation exists, and are owner-scoped (a
  different owner's request 404s); an owner session can't call a renter-portal route and a renter
  session can't call an owner route; previewing an invitation is read-only and never sets a session
  cookie ahead of acceptance; `GET /api/me` lazily mints a connection code and regenerating retires the
  old one; self-serve sign-up enforces every mandatory field and a length-only password rule; **the
  critical regression test** — signing up with an email that already belongs to an existing, unverified
  renter exposes none of that renter's data and can't be logged into until the console-logged
  verification link is actually used (this is the exact gap described in "A real security gap, found
  and closed" below, written as a permanent regression test once the fix landed); signing up again for
  an email with a working password already set is refused (409), never silently overwritten; the public
  verify-email-resend endpoint needs no session and gives an identical response whether or not the
  email has an account, so it can't be used to enumerate who's registered; an expired invitation never
  blocks an existing, already-onboarded renter's plain email+password login; the Unassigned Renters
  list carries name/phone/email/signup-date/status, drops a renter the moment they're assigned, and is
  owner-scoped; a brand-new renter gets an empty lease list while a newly-assigned one gets exactly one
  draft lease, and an existing renter with an active lease keeps seeing it once a second, still-pending
  tenancy is assigned to them (the dual-tenancy/historical-access guarantee in §4); a renter session
  idle past the timeout is rejected and deleted while one still inside the window slides forward
  instead; and explicit sign-out ends a session immediately with the cookie unusable afterward. Four
  more tests cover the Twilio status-callback webhook directly: a correctly-signed callback updates the
  matching `sms_messages` row, a tampered or missing signature is rejected and changes nothing, a
  terminal status is never regressed by an out-of-order retry, and a callback for an unrecognized
  message id is a harmless no-op.

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

This same round also added the misconfigured-storage warning banner described in §9. That banner's
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
three have credentials configured in this environment (§4, §6, §7) — the code paths are real and
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

### Verified by hand, lease agreements update

This feature is a modal-heavy part of the UI, exactly the kind of thing that's easy to get subtly
wrong in ways only a real browser catches, so it was driven end to end with Playwright against a
running instance of this exact app (an isolated database and uploads folder, never the real one)
rather than assumed correct from the HTTP-level tests above:

1. **The whole path, once, start to finish.** Signed in as a fresh owner, added a property, generated
   a renter invite, accepted it as that renter, assigned the renter to the property from the owner
   side, prepared a lease (filled every required field, watched the PDF preview update live), signed
   it as the owner, sent it, signed it as the renter (consent checkbox, then the distinct "Sign and
   Accept Agreement" button), and confirmed completion on both sides — including the owner's audit
   trail and a real PDF download compared by byte count on both the owner's and renter's copy.
2. **A real, would-have-shipped bug, found and fixed.** Clicking "Invite Renter" hung on the
   invite-link modal indefinitely — the copy-link field that should have appeared never did. Root
   cause: the modal helper this button used (`wireSave`) closes "whichever modal happens to be open
   right now" after a successful save, without checking *which* modal that is; this button's own
   success handler already closes the invite-*form* modal and opens a new invite-*link* modal, so
   `wireSave`'s own cleanup immediately closed that brand-new modal right back out from under it.
   Fixed by wiring the form's submit event by hand instead of through `wireSave`, the same pattern
   this codebase already used elsewhere for a modal-to-modal handoff. Confirmed fixed by re-running
   the same click in a real browser. The identical latent bug — masked by lucky timing rather than
   actually correct — was found and fixed the same way in the template editor's save handler before
   it ever surfaced as a visible failure.
3. **Rent sync, checked against the numbers, not just the status label.** After completion, confirmed
   the tenancy actually went active with the exact rent from the signed lease, exactly one rent-history
   row (nothing duplicated by the flow), and — for a lease with a future start date — **zero**
   generated charges despite the tenancy already showing active, matching what §5 claims about charge
   generation never running ahead of today.
4. **What each side is shown, not just what each side is sent.** Confirmed directly in the rendered
   page (not just the API response) that the sample-template disclaimer is visible on the prep screen,
   the renter's consent checkbox starts unchecked, "Sign and Accept Agreement" is visually distinct
   from ordinary form submission, and Decline/Request Correction are both present and reachable before
   signing — a control that exists in the API but never renders would pass every HTTP-level test above
   while still failing the actual person using it.
5. **No new console/page errors** were observed for the duration of the run.

**Not covered by this pass:** a real second co-tenant browser session (two-signer isolation is covered
by the automated HTTP tests in §8, not re-driven through a second real browser tab), and anything past
the demo signing adapter's boundary, since there's nothing real to click through until a provider is
actually connected (see "Real signing: what's actually implemented" in §5).

### A real security gap, found and closed

**Root cause.** The self-serve "Make a New Account" screen (§4) was built specifically so that a
sign-up with an unproven email exposes nothing: even calling `POST /api/renter/signup` with an email
that already belongs to a real renter — someone with real lease history — sets a password and returns
only "account created," never that renter's data or a session. But that protection lived entirely on
the signup side; nothing on the *sign-in* side independently checked that the email had actually been
proven yet. `POST /api/renter/login` compared only the email and password, so the exact password
self-serve signup just set would immediately work at the ordinary login screen — a second, unrelated
request the signup route's own careful design never defended against by itself. Concretely: knowing
(or guessing) a renter's email address was enough to set a new password for their identity through
signup, then simply sign in with it seconds later and see their real balance, documents, and lease
history.

**The fix.** `POST /api/renter/login` (`server/routes/renterAuth.js`) now also requires
`email_verified_at` to be set — a 403, not a 401, since the credentials are genuinely correct and
"incorrect email or password" would be actively misleading about what's actually wrong. An owner-sent
invitation link already counts as proof of ownership the instant it's accepted (accepting it
necessarily means the renter received something the owner sent to that address), so `accept-invite`
keeps signing a renter in immediately exactly as it always has — this gate only ever engages on the
self-serve path, and only until its console-logged verification link (no email provider is configured
yet — see §4) is opened. A new public `POST /api/renter/verify-email/resend` endpoint exists
specifically for someone stuck at this gate with no way to sign in yet to request a fresh link — same
privacy posture as forgot-password: an identical response whether or not the email exists or still
needs verifying — and the login screen surfaces a **Resend verification link** action the moment it
sees this exact error.

**Verified, not just reasoned about:** this wasn't reported to me — I found it myself while writing
this update's own test coverage for the new signup screen, and it's now a permanent regression test
(`test/renterWorkflowUpdate.test.js`, §8): signing up with an existing, unverified renter's exact email
is confirmed to return no trace of that renter's data, a login attempt with the just-set password is
confirmed to fail with 403 rather than succeed, and only after walking through the same verification
token a genuine signup would use does login succeed and return that renter's real, correct data. Every
pre-existing renter-login test fixture goes through `accept-invite`, which already stamped
`email_verified_at` immediately before this fix ever existed, so nothing already relying on
sign-in-immediately-after-accepting-an-invite broke.

### Verified by hand, the renter workflow update

Same reasoning as every prior round: a login/signup/status-screen feature like this can pass every
HTTP-level test above while still being subtly wrong, or simply unfinished, in an actual browser — so
it was driven end to end with Playwright against a running instance of this exact app (an isolated
database and uploads folder, never the real one), using **two separate browser contexts** (their own
cookie jars) for the owner and the renter specifically to prove session isolation rather than assume it
from the cookie names in the code.

1. **The whole path, once, start to finish, both sides at once.** Signed in as a fresh owner, opened
   **Send Renter Portal Link**, and reviewed the SMS modal's prefilled phone/message fields and its
   honest "not configured" notice (no Twilio credentials in this test run) before confirming **Copy
   Link** still works regardless. In the separate renter-side browser context, signed up cold through
   **Make a New Account** with every mandatory field and the owner's own connection code, confirmed the
   "verify your email" state, pulled the verification link from the server's own console output (the
   honest stand-in for a real email provider — see §4), and signed in for real afterward. Back on the
   owner side, confirmed the new sign-up appeared in **Unassigned Renters** as **Pending verification**
   and then, once verified, with no badge; assigned it to a property, prepared and sent a lease
   agreement, and confirmed the renter's **Waiting on assignment** screen picked up the new **Review and
   Sign Lease** button and completed a real sign, ending on the full portal (charges, lease details, a
   downloadable completed PDF, and a "Signed. Thank you!" confirmation) — the same tab dashboard the
   pre-existing lease-agreements feature already had, now reached through this update's new front door.
2. **Two real bugs in the verification *script*, not the app**, worth naming so "19/19 passing" doesn't
   read as "nothing went wrong the first time." The dashboard's generic invite-renter modal uses a plain
   `<input name="phone">`, not the country-code phone widget the renter-facing signup/accept-invite
   screens use, so a selector written against the wrong widget timed out; and an invalid mixed
   CSS/Playwright selector threw outright. Both were script mistakes, fixed by checking the actual
   rendered markup rather than assuming it matched a different screen's widget.
3. **A real, confirmed-intentional behavior — not a bug — worth recording so it isn't mistaken for one
   later.** After the owner sent the lease agreement, changing the renter's tab to `#/` via a bare hash
   update kept showing the stale "not assigned yet" state instead of the new sign button. Reading
   `renter.js`'s own `hashchange` handler confirmed this is by design: once signed in, a bare hash
   change re-renders from whatever's already cached in memory rather than re-fetching from the server —
   consistent with this whole app's "manual refresh, not live updates" philosophy (the same reason the
   Unassigned Renters panel above has its own explicit Refresh button rather than polling). A genuine
   page reload re-fetches and picks the change up immediately, which is what an actual returning renter
   would do. Fixed the test to reload rather than just changing the hash; nothing in the app changed.
4. **What each side is actually shown, not just what the API returns**, checked directly in the
   rendered page: the SMS modal's "not configured" notice, the signup screen's Show/Hide toggles
   (confirmed the field itself switches between `type="password"` and `type="text"`, not just that the
   button is present), the Unassigned Renters search box narrowing the visible rows without submitting
   anything, and the waiting screen never rendering any owner-facing figure or label at any point along
   the way.
5. **No new console/page errors** were observed for the duration of the run, checked by listening for
   the whole run rather than only where a problem was expected.

The run's 13 screenshots (the SMS modal, the Unassigned Renters panel, both new renter screens, the
verification step, both waiting-screen states, and the completed portal) were reviewed individually
afterward for actual visual correctness — layout, spacing, legible text — not just that a selector
found what it expected.

---

## 9. Security notes

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
- **A renter session enforces a real sliding inactivity timeout** (30 minutes by default,
  `RENTER_SESSION_IDLE_TIMEOUT_MINUTES` to change it) on every single authenticated request, checked
  and refreshed server-side — not a client-side timer that a modified or replayed request could ignore.
  There is deliberately no "Remember Me": the session cookie carries no `Max-Age`, and nothing about
  this app treats "the browser was closed" as a guarantee it can't actually verify. See "Signing in,
  and the renter session model" in §4 for the full reasoning.
- **A renter's own password can never be used to sign in until their email is verified** —
  `POST /api/renter/login` checks `email_verified_at`, not just the password, closing a real gap where
  self-serve sign-up (§4) could otherwise be used to set a password on an existing renter's identity and
  immediately log in as them. See "A real security gap, found and closed" in §8 for exactly what this
  closes and how it was found.
- **Twilio's SMS delivery-status webhook is signature-verified before anything in it is trusted** —
  `X-Twilio-Signature` (HMAC-SHA1 keyed by your Twilio Auth Token, Twilio's own documented algorithm),
  checked with a timing-safe comparison, the same posture `server/routes/webhooks.js` already takes for
  the payment provider. A missing or wrong signature is rejected outright, and a delivery status can
  only move forward — a terminal `delivered`/`failed`/`undelivered` status is never regressed by a
  retried or out-of-order callback. See "Sending renter invitations by SMS" in §4.
- Every write to money, leases, and archival/deletion actions is recorded in an append-only audit
  log (`audit_log` table: who, what, before/after, when) — nothing here is "fire and forget."
  There's no UI to browse it yet, but the data is there (`SELECT * FROM audit_log ORDER BY id DESC`).
- The one webhook signing secret and the server's own secret are generated randomly on first run
  and written to `data/` with `0600` permissions — never hard-coded, never checked into version
  control (see `.gitignore`).
- Every property/financial/tenant-scoped route checks that the resource actually belongs to the
  signed-in owner before returning anything (tested — see §8's "data isolation" line).
- **Every lease-signing action is looked up by the caller's own identity, never a client-supplied
  signer id** — a request to sign, decline, or request a correction always resolves "which signer is
  this?" from the authenticated session, so there's no id to tamper with in the first place, not just
  a check that happens to reject the wrong one. A completed agreement's PDF is hashed (SHA-256) at
  generation time and that hash is stored in its audit record, so the file can be checked against
  tampering after the fact.

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

**You should also** read §6 and connect a real payment provider before sending a real tenant a real
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
in §8 (visible Saving/Saved states, inline errors that preserve your input, a warning before
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

## 10. Project layout

```
server/
  db.js                  schema + additive migrations (schema_meta.version tracked)
  seed.js                sample-data generator (npm run seed)
  lib/                   money/date helpers, rent-status logic, auth, and:
                            paymentProvider.js  mock payment processor (§6)
                            bankProvider.js     real Plaid REST client (§7)
                            storageStatus.js    ephemeral-host/misconfigured-persistence detection (§9)
                            renterAuth.js       renter session/token issuance — sliding inactivity
                                                  timeout, no Remember Me, separate from owner
                                                  sessions by design (§4/§9)
                            renters.js          renter/lease-renter data access, incl. what makes a
                                                  renter "Active" vs "Not invited" (§4)
                            renterAccess.js     what a signed-in renter may see (documents, charges) —
                                                  the enforced source of truth for sharing (§4)
                            smsProvider.js      real Twilio SMS client + status-callback signature
                                                  verification (§4/§9)
                            connectionCode.js   short shareable codes for self-serve renter sign-up (§4)
                            phone.js            E.164 phone validation shared by sign-up and SMS (§4)
                            pdf.js              zero-dependency PDF writer used for statements (§4/§8)
                            statements.js       statement generation/PDF-rendering pipeline (§4/§8)
                            leaseAgreements.js  agreement lifecycle, signing, freeze/void-replace,
                                                  final PDF + audit trail, lease sync (§5/§8)
                            leaseTemplates.js   template CRUD, sample-template provisioning and its
                                                  immutability (§5)
                            pdfText.js          word-wrapping for the lease PDF's paragraph text,
                                                  built on pdf.js's base-14 font metrics (§5)
  routes/                one file per resource (properties, leases, financials, tenantPortal,
                            bankAccounts, bankConnections, paymentLinks, systemStatus, …), plus:
                            renterAuth.js       renter sign-up/login/invite-accept + tokens, incl. the
                                                  email-verified-before-login gate (§4/§8/§9)
                            renterManagement.js owner-facing add/invite/remove-renter endpoints, the
                                                  SMS-invite route, and Unassigned Renters (§4)
                            renterPortal.js     the signed-in renter's own API — balance, documents,
                                                  maintenance, statements (§4)
                            smsWebhooks.js      Twilio delivery-status callback handler (§4/§9)
                            statements.js       generate/list/share/email/delete statements (§4/§8)
                            leaseAgreements.js  owner + renter HTTP surface: prepare/preview/finalize,
                                                  sign/decline/request-correction, remind/void, audit,
                                                  final-PDF download and email (§5)
                            leaseTemplates.js   list/create/update/delete/duplicate a template (§5)
public/
  index.html + js/       owner-facing single-page app (hash-based routing, no build step)
                            components.js  shared UI primitives (Modal/Toast/PhotoPicker/…)
                            phone.js  the country-code + national-number phone input widget (§4)
                            leaseAgreementUI.js  shared owner + renter lease-agreement UI: invite/
                              assign modals (incl. the SMS-invite modal), the Unassigned Renters panel,
                              template manager, the prep-and-sign flow, and the audit modal (§4/§5)
                            views/bankAccounts.js  Bank Accounts page + per-property section,
                              including the Plaid Link browser flow
                            views/dashboard.js  portfolio dashboard, incl. the Renters card
                              (SMS invite / connection code) and the Unassigned Renters panel (§4)
  tenant.html + tenant.js  the payment-link surface (`/pay/link/:token`) — no account, one-off (§2)
  renter.html + renter.js  the renter portal (`/renter`) — dedicated login/sign-up, the "Waiting on
                             assignment" screen, and the full per-lease portal (§4)
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
  renterPortal.test.js   renter accounts: invite/accept, sign-in, merge, portal-visible data (§4/§8)
  statements.test.js     statement generation math and the PDF-rendering pipeline (§4/§8)
  statementsRoutes.test.js  owner-facing statement routes: generate/list/share/email/delete (§8)
  pdf.test.js            the PDF writer itself, including the encoding bug it caught (§8)
  leaseAgreements.test.js  invite-to-signed-lease end to end: assignment, templates, prep, signing,
                             audit trail, completion sync, former-tenant isolation (§5/§8)
  renterWorkflowUpdate.test.js  SMS invitations, the renter session model, self-serve sign-up incl.
                             the email-verification security fix, and Unassigned Renters (§4/§8)
```

No bundler, no framework, no build step — edit a `.js` file under `public/` and reload the page.

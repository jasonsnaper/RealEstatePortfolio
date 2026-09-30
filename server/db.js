const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const { findOrCreateRenter } = require('./lib/renters');

// We use Node's built-in SQLite (available natively since Node 22.5, no
// npm install required) as a real relational database with real tables,
// foreign keys, and transactions — not a JSON file pretending to be one.
// SQLite is a single file on disk, which is the right amount of database
// for one owner's portfolio, and it upgrades cleanly to Postgres later
// (the schema is plain ANSI-ish SQL) if this grows into a multi-owner,
// heavily concurrent product.

// Defaults to <project root>/data, exactly as before — but on a host where
// the deployed code directory is replaced on every deploy (Render, Railway,
// most PaaS platforms), the database must live on a separately-mounted
// persistent disk instead, so DATA_DIR can be overridden with an env var.
// Unset, this is a no-op and behaves exactly as it always has.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Same reasoning and same env-var override as DATA_DIR, for uploaded photos
// and documents. This is the ONE place that resolves it — every route that
// reads or writes an uploaded file (photos.js, documents.js, maintenance.js,
// properties.js, sampleData.js, tenantPortal.js) and server/index.js's static
// file server all import UPLOADS_DIR from here rather than recomputing their
// own copy of this path, specifically so they can never disagree about where
// an uploaded file actually lives.
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, '..', 'public', 'uploads');

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS owners (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

-- Team members table exists now so multi-user ownership is a schema
-- migration away, not a redesign. Not exposed in the UI yet (single owner
-- per the brief), but every property already carries an owner_id and every
-- query already filters by it, so adding real teams later means adding
-- rows here and an ACL table, not touching the rest of the app.
CREATE TABLE IF NOT EXISTS team_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS properties (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  address_line1 TEXT,
  address_line2 TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  timezone TEXT NOT NULL DEFAULT 'America/Denver',
  cover_photo_path TEXT,
  cover_focal_x REAL NOT NULL DEFAULT 50,
  cover_focal_y REAL NOT NULL DEFAULT 50,
  status TEXT NOT NULL DEFAULT 'active',
  is_sample INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Units exist so a multi-unit property (duplex, fourplex) is a natural
-- extension: today every property gets exactly one implicit "unit" row
-- created alongside it, and leases point at a unit rather than a property
-- directly. The V1 UI hides this distinction and treats one property as
-- one rentable thing, but the data model doesn't have to change later.
CREATE TABLE IF NOT EXISTS units (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT 'Main',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per real bank *connection* (a Plaid "Item"), which can back
-- several bank_accounts at once (a single login often exposes checking +
-- savings, say). access_token is the only credential that can read this
-- connection going forward — it is never sent to any client; every API
-- response about a connected account is built from serializeAccount()'s
-- explicit allowlist, never a raw row. status tracks the CONNECTION as a
-- whole (a bank often invalidates the whole login at once, e.g. after the
-- owner changes their password at the bank), so every account under it can
-- show the same "needs reconnect" state without each account separately losing sync.
CREATE TABLE IF NOT EXISTS bank_connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'plaid',
  institution_name TEXT,
  item_id TEXT,
  access_token TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bank_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  nickname TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'manual',
  manual_balance_cents INTEGER NOT NULL DEFAULT 0,
  manual_as_of TEXT,
  connected_provider TEXT,
  connected_status TEXT,
  last_synced_at TEXT,
  is_sample INTEGER NOT NULL DEFAULT 0,
  -- Populated only for mode='connected' rows (see the v2->v3 migration below
  -- for how these five columns get added to a database that predates them).
  bank_connection_id INTEGER REFERENCES bank_connections(id) ON DELETE SET NULL,
  external_account_id TEXT,
  mask TEXT,
  institution_name TEXT,
  balance_type TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS property_bank_accounts (
  property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  bank_account_id INTEGER NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE,
  PRIMARY KEY (property_id, bank_account_id)
);

CREATE TABLE IF NOT EXISTS property_valuations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  value_cents INTEGER NOT NULL,
  valuation_date TEXT NOT NULL,
  source TEXT,
  is_purchase INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS capital_improvements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  improvement_date TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mortgages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  lender TEXT NOT NULL,
  original_amount_cents INTEGER NOT NULL,
  current_principal_cents INTEGER NOT NULL,
  interest_rate_bps INTEGER,
  monthly_payment_cents INTEGER,
  due_day INTEGER,
  origination_date TEXT,
  term_months INTEGER,
  maturity_date TEXT,
  escrow_cents INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS leases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  unit_id INTEGER REFERENCES units(id),
  tenant_name TEXT NOT NULL,
  co_tenant_name TEXT,
  tenant_email TEXT,
  tenant_phone TEXT,
  emergency_contact TEXT,
  start_date TEXT NOT NULL,
  end_date TEXT,
  deposit_required_cents INTEGER NOT NULL DEFAULT 0,
  deposit_held_cents INTEGER NOT NULL DEFAULT 0,
  deposit_disposition TEXT,
  billing_frequency TEXT NOT NULL DEFAULT 'monthly',
  due_day INTEGER NOT NULL DEFAULT 1,
  late_after_days INTEGER NOT NULL DEFAULT 5,
  late_fee_enabled INTEGER NOT NULL DEFAULT 0,
  late_fee_type TEXT DEFAULT 'flat',
  late_fee_amount_cents INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  owner_notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT
);

-- Effective-dated rent history so changing future rent never rewrites past
-- charges: each row is "this rent amount applies from this date forward".
CREATE TABLE IF NOT EXISTS lease_rent_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lease_id INTEGER NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
  rent_cents INTEGER NOT NULL,
  effective_date TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS charges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lease_id INTEGER NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  due_date TEXT NOT NULL,
  late_date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(lease_id, period_start)
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lease_id INTEGER NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
  charge_id INTEGER REFERENCES charges(id),
  amount_cents INTEGER NOT NULL,
  type TEXT NOT NULL DEFAULT 'payment',
  method TEXT NOT NULL DEFAULT 'cash',
  status TEXT NOT NULL DEFAULT 'completed',
  paid_at TEXT NOT NULL,
  notes TEXT,
  external_ref TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  direction TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  category TEXT,
  description TEXT,
  txn_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed',
  is_operating INTEGER NOT NULL DEFAULT 1,
  is_capital INTEGER NOT NULL DEFAULT 0,
  is_debt_service INTEGER NOT NULL DEFAULT 0,
  related_payment_id INTEGER REFERENCES payments(id),
  bank_transaction_ext_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  caption TEXT,
  album TEXT,
  before_after_group_id TEXT,
  before_after_role TEXT,
  taken_at TEXT,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  filename TEXT NOT NULL,
  category TEXT,
  expiration_date TEXT,
  is_shared_with_tenant INTEGER NOT NULL DEFAULT 0,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS maintenance_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  priority TEXT NOT NULL DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'open',
  assigned_vendor TEXT,
  estimated_cost_cents INTEGER,
  actual_cost_cents INTEGER,
  scheduled_date TEXT,
  completed_date TEXT,
  created_by TEXT NOT NULL DEFAULT 'owner',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS maintenance_photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  maintenance_request_id INTEGER NOT NULL REFERENCES maintenance_requests(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER REFERENCES properties(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payment_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  lease_id INTEGER NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
  charge_id INTEGER REFERENCES charges(id),
  status TEXT NOT NULL DEFAULT 'active',
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS payment_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_link_id INTEGER NOT NULL REFERENCES payment_links(id) ON DELETE CASCADE,
  charge_id INTEGER NOT NULL REFERENCES charges(id),
  provider TEXT NOT NULL DEFAULT 'mock',
  provider_session_id TEXT,
  amount_cents INTEGER NOT NULL,
  fee_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'created',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  payload_json TEXT,
  UNIQUE(provider, event_id)
);

-- ---------------------------------------------------------------------------
-- Renter accounts. Deliberately separate from the pre-existing tenant_name /
-- co_tenant_name / tenant_email / tenant_phone columns on leases (untouched,
-- above): those stay exactly as they've always been — the owner's own quick
-- record of who's renting, always present, never requiring a renter to do
-- anything — while the tables below are the optional layer on top for a
-- renter who wants (or is given) their own sign-in. A lease's billing never
-- depends on any renter row existing.
--
-- Split into three concerns on purpose, per the brief:
--   renters        — identity (name/email/phone) + optional login credentials.
--                    Can exist with password_hash NULL forever (an owner-
--                    entered renter who never sets up an account) — billing
--                    and manual payment tracking work fully in that state.
--   lease_renters  — membership: which renter(s) are on which lease, and in
--                    what role. A renter can be on several leases over time
--                    (moved units, past tenancies); a lease can have several
--                    renters (co-renters), each with their own login.
--   renter_tokens  — every single-use, expiring "renter clicked a link"
--                    action (email verification, password reset, invitation
--                    acceptance) through one small table rather than three
--                    near-identical ones.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS renters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  password_hash TEXT,
  email_verified_at TEXT,
  merged_into_renter_id INTEGER REFERENCES renters(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lease_renters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lease_id INTEGER NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
  renter_id INTEGER NOT NULL REFERENCES renters(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'primary',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(lease_id, renter_id)
);

CREATE TABLE IF NOT EXISTS renter_sessions (
  token TEXT PRIMARY KEY,
  renter_id INTEGER NOT NULL REFERENCES renters(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

-- purpose: 'verify_email' | 'reset_password' | 'invitation'. lease_id/role
-- are only set for 'invitation' tokens (which lease + what role it grants
-- once accepted); NULL for the other two purposes.
CREATE TABLE IF NOT EXISTS renter_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  renter_id INTEGER NOT NULL REFERENCES renters(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL,
  lease_id INTEGER REFERENCES leases(id) ON DELETE CASCADE,
  role TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  used_at TEXT
);

-- Explicit per-document sharing. Exactly one of lease_id/renter_id is set:
-- a lease-scoped share is visible to every renter currently on that lease
-- (lease_renters), a renter-scoped share is visible to that one renter only
-- (e.g. a former tenant's own final statement, kept visible to them alone
-- after their lease's other renters — if any — moved on). This supersedes
-- documents.is_shared_with_tenant as the enforced source of truth (see the
-- migration below for how existing shared documents are carried forward).
CREATE TABLE IF NOT EXISTS document_shares (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  lease_id INTEGER REFERENCES leases(id) ON DELETE CASCADE,
  renter_id INTEGER REFERENCES renters(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((lease_id IS NOT NULL) != (renter_id IS NOT NULL))
);

-- A generated PDF is an immutable snapshot: once created, its file and
-- totals_json never change, even if later corrections change the ledger —
-- see server/lib/statements.js. is_sample marks one built from is_sample
-- property data, so it can be watermarked and never confused for a real record.
CREATE TABLE IF NOT EXISTS payment_statements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lease_id INTEGER NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
  range_type TEXT NOT NULL,
  range_start TEXT NOT NULL,
  range_end TEXT NOT NULL,
  generated_by TEXT NOT NULL DEFAULT 'owner',
  generated_by_renter_id INTEGER REFERENCES renters(id),
  is_sample INTEGER NOT NULL DEFAULT 0,
  file_path TEXT NOT NULL,
  totals_json TEXT,
  shared_with_renter INTEGER NOT NULL DEFAULT 0,
  emailed_at TEXT,
  emailed_to TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Reusable lease document templates. is_sample marks the one built-in demo
-- template every owner can see without creating their own (clearly labeled,
-- never described as legally reviewed — see server/lib/leaseAgreements.js);
-- an owner's own saved templates (is_sample = 0) are private to them.
CREATE TABLE IF NOT EXISTS lease_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  jurisdiction TEXT,
  body_text TEXT NOT NULL,
  is_sample INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per lease-agreement "envelope" (in e-signature terms). A lease can
-- accumulate several rows over time (a voided draft replaced by a corrected
-- one) but at most one is ever non-terminal at once per lease — enforced in
-- code (server/lib/leaseAgreements.js), not a constraint, since SQLite can't
-- easily express "at most one open row per lease_id" declaratively.
-- fields_json and body_snapshot are both frozen the instant the agreement is
-- sent (status moves past 'draft'): editing terms after that means voiding
-- this row and creating a fresh one via replaces_agreement_id, never
-- mutating a sent document in place, and never carrying a signature onto
-- changed terms.
CREATE TABLE IF NOT EXISTS lease_agreements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lease_id INTEGER NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
  template_id INTEGER REFERENCES lease_templates(id),
  status TEXT NOT NULL DEFAULT 'draft',
  version INTEGER NOT NULL DEFAULT 1,
  replaces_agreement_id INTEGER REFERENCES lease_agreements(id),
  fields_json TEXT NOT NULL,
  body_snapshot TEXT,
  provider TEXT NOT NULL DEFAULT 'demo',
  final_pdf_path TEXT,
  document_hash TEXT,
  decline_reason TEXT,
  correction_request TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT,
  completed_at TEXT,
  voided_at TEXT
);

-- One row per required signer on an agreement: the landlord (renter_id
-- NULL) plus one per tenant/co-tenant (renter_id set). Every signing action
-- is looked up by (agreement_id, the caller's OWN session identity), never
-- by a signer id the caller supplies — that, not a permissions check alone,
-- is what makes it structurally impossible for one signer to complete
-- another person's field.
CREATE TABLE IF NOT EXISTS lease_signers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agreement_id INTEGER NOT NULL REFERENCES lease_agreements(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  renter_id INTEGER REFERENCES renters(id),
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  consented_at TEXT,
  signed_at TEXT,
  signature_text TEXT,
  decline_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Append-only signing-ceremony audit trail, one row per meaningful event
-- (sent, viewed, consented, signed, correction requested, declined, voided,
-- completed). Separate from the app-wide audit_log table below (which stays
-- focused on owner-initiated writes) because this one is surfaced directly
-- as the completed agreement's own "signing audit record".
CREATE TABLE IF NOT EXISTS lease_agreement_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agreement_id INTEGER NOT NULL REFERENCES lease_agreements(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id INTEGER,
  detail_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_type TEXT NOT NULL,
  actor_id INTEGER,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id INTEGER,
  before_json TEXT,
  after_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_properties_owner ON properties(owner_id);
CREATE INDEX IF NOT EXISTS idx_leases_property ON leases(property_id);
CREATE INDEX IF NOT EXISTS idx_charges_lease ON charges(lease_id);
CREATE INDEX IF NOT EXISTS idx_payments_lease ON payments(lease_id);
CREATE INDEX IF NOT EXISTS idx_payments_charge ON payments(charge_id);
CREATE INDEX IF NOT EXISTS idx_transactions_property ON transactions(property_id);
CREATE INDEX IF NOT EXISTS idx_sessions_owner ON sessions(owner_id);
CREATE INDEX IF NOT EXISTS idx_payment_links_token ON payment_links(token);
CREATE INDEX IF NOT EXISTS idx_renters_owner ON renters(owner_id);
CREATE INDEX IF NOT EXISTS idx_lease_renters_lease ON lease_renters(lease_id);
CREATE INDEX IF NOT EXISTS idx_lease_renters_renter ON lease_renters(renter_id);
CREATE INDEX IF NOT EXISTS idx_renter_sessions_renter ON renter_sessions(renter_id);
CREATE INDEX IF NOT EXISTS idx_renter_tokens_renter ON renter_tokens(renter_id);
CREATE INDEX IF NOT EXISTS idx_document_shares_document ON document_shares(document_id);
CREATE INDEX IF NOT EXISTS idx_document_shares_lease ON document_shares(lease_id);
CREATE INDEX IF NOT EXISTS idx_document_shares_renter ON document_shares(renter_id);
CREATE INDEX IF NOT EXISTS idx_payment_statements_lease ON payment_statements(lease_id);
CREATE INDEX IF NOT EXISTS idx_lease_templates_owner ON lease_templates(owner_id);
CREATE INDEX IF NOT EXISTS idx_lease_agreements_lease ON lease_agreements(lease_id);
CREATE INDEX IF NOT EXISTS idx_lease_signers_agreement ON lease_signers(agreement_id);
CREATE INDEX IF NOT EXISTS idx_lease_signers_renter ON lease_signers(renter_id);
CREATE INDEX IF NOT EXISTS idx_lease_agreement_events_agreement ON lease_agreement_events(agreement_id);
`;

// Additive migrations for columns added after a database's initial CREATE
// TABLE ran (CREATE TABLE IF NOT EXISTS above never adds a column to a table
// that already exists). Every migration below checks its OWN precondition
// (PRAGMA table_info / sqlite_master) before touching anything, and ALL of
// them run on every single startup — see openDatabase()'s comment for why
// that's deliberate, not an oversight: a fresh database from SCHEMA above
// already has every column, so each check below is just a fast no-op for it.
const MIGRATIONS = [
  // v1 -> v2: bank_accounts.is_sample, so seed-created shared accounts can be
  // told apart from an owner's real linked accounts when sample data is removed.
  (db) => {
    const cols = db.prepare("PRAGMA table_info(bank_accounts)").all();
    if (!cols.some((c) => c.name === 'is_sample')) {
      db.exec('ALTER TABLE bank_accounts ADD COLUMN is_sample INTEGER NOT NULL DEFAULT 0');
    }
  },
  // v2 -> v3: real bank connections (Plaid-ready). bank_connections is a
  // brand-new table, so CREATE TABLE IF NOT EXISTS in SCHEMA above already
  // handles it on every startup — nothing to do here for that part. These
  // five columns on the pre-existing bank_accounts table are the part CREATE
  // TABLE IF NOT EXISTS can't add to a database that already has the table.
  (db) => {
    const cols = db.prepare("PRAGMA table_info(bank_accounts)").all();
    const names = new Set(cols.map((c) => c.name));
    if (!names.has('bank_connection_id')) db.exec('ALTER TABLE bank_accounts ADD COLUMN bank_connection_id INTEGER REFERENCES bank_connections(id) ON DELETE SET NULL');
    if (!names.has('external_account_id')) db.exec('ALTER TABLE bank_accounts ADD COLUMN external_account_id TEXT');
    if (!names.has('mask')) db.exec('ALTER TABLE bank_accounts ADD COLUMN mask TEXT');
    if (!names.has('institution_name')) db.exec('ALTER TABLE bank_accounts ADD COLUMN institution_name TEXT');
    if (!names.has('balance_type')) db.exec('ALTER TABLE bank_accounts ADD COLUMN balance_type TEXT');
  },

  // v3 -> v4: maintenance_requests.lease_id, so a tenant-submitted request can
  // be scoped to the lease that was active when it was filed. Existing rows
  // (all pre-dating this column) stay NULL — they simply won't appear in the
  // new lease-scoped renter portal view, which is the safe default (the
  // owner's own dashboard is unaffected; it was never lease-scoped).
  (db) => {
    const cols = db.prepare("PRAGMA table_info(maintenance_requests)").all();
    if (!cols.some((c) => c.name === 'lease_id')) {
      db.exec('ALTER TABLE maintenance_requests ADD COLUMN lease_id INTEGER REFERENCES leases(id) ON DELETE SET NULL');
    }
  },

  // v4 -> v5: documents.needs_sharing_review, set for a document that WAS
  // shared property-wide (is_shared_with_tenant=1) under the old model but
  // whose intended recipient can't be safely inferred once sharing becomes
  // per-lease (see the backfill migration below, which sets this flag).
  (db) => {
    const cols = db.prepare("PRAGMA table_info(documents)").all();
    if (!cols.some((c) => c.name === 'needs_sharing_review')) {
      db.exec('ALTER TABLE documents ADD COLUMN needs_sharing_review INTEGER NOT NULL DEFAULT 0');
    }
  },

  // v5 -> v6: back-fill renters/lease_renters from the tenant_name/
  // co_tenant_name/tenant_email/tenant_phone columns that already exist on
  // every lease, so every pre-existing tenant already has a (login-less)
  // renter identity ready for the owner to invite, WITHOUT the owner having
  // to re-enter anyone. Guarded by leases.renter_backfilled_at so this runs
  // exactly once per lease no matter how many times startup re-runs every
  // migration (see openDatabase()'s comment on why that's deliberate).
  //
  // De-duplication is deliberately conservative: two leases are only ever
  // treated as the same person when their tenant_email matches exactly
  // (case-insensitively). Without an email on file, every lease gets its own
  // fresh renter row, even if the name matches another lease — a name match
  // alone is not good enough evidence that two different tenants are the
  // same real person, and wrongly merging two strangers into one login would
  // be far worse than leaving the owner to invite the same person twice.
  (db) => {
    const leaseCols = db.prepare("PRAGMA table_info(leases)").all();
    if (!leaseCols.some((c) => c.name === 'renter_backfilled_at')) {
      db.exec('ALTER TABLE leases ADD COLUMN renter_backfilled_at TEXT');
    }

    const linkRenter = db.prepare('INSERT OR IGNORE INTO lease_renters (lease_id, renter_id, role) VALUES (?, ?, ?)');

    const leases = db.prepare("SELECT * FROM leases WHERE renter_backfilled_at IS NULL").all();
    for (const lease of leases) {
      const property = db.prepare('SELECT owner_id FROM properties WHERE id = ?').get(lease.property_id);
      if (property && lease.tenant_name && lease.tenant_name.trim()) {
        const primary = findOrCreateRenter(db, property.owner_id, { name: lease.tenant_name.trim(), email: lease.tenant_email, phone: lease.tenant_phone });
        linkRenter.run(lease.id, primary.id, 'primary');
        if (lease.co_tenant_name && lease.co_tenant_name.trim()) {
          // Co-tenants have no separate email/phone columns on leases today,
          // so each backfills to its own fresh identity unless a later
          // invitation links it to something more specific.
          const co = findOrCreateRenter(db, property.owner_id, { name: lease.co_tenant_name.trim(), email: null, phone: null });
          linkRenter.run(lease.id, co.id, 'co_renter');
        }
      }
      db.prepare("UPDATE leases SET renter_backfilled_at = datetime('now') WHERE id = ?").run(lease.id);
    }
  },

  // v6 -> v7: carry forward documents that were shared property-wide under
  // the old is_shared_with_tenant flag into the new per-lease document_shares
  // model — but ONLY where the recipient is unambiguous. A property with
  // exactly one lease ever (so exactly one possible intended recipient)
  // migrates cleanly. A property with more than one lease (current tenant,
  // past tenants, or both) can't be resolved safely — WHICH tenant(s) the
  // owner meant when they flipped that switch isn't recorded anywhere, so
  // rather than guess (and risk exposing a private document to the wrong
  // tenant, or to every tenant who ever lived there), the file is preserved
  // exactly as-is and flagged needs_sharing_review for the owner to look at.
  // Guarded by a schema_meta marker so this one-time reclassification never
  // repeats (unlike the per-row markers above, nothing on `documents` itself
  // is a natural "already handled" flag, since is_shared_with_tenant is
  // deliberately left untouched for anyone reading the raw column directly).
  (db) => {
    const done = db.prepare("SELECT value FROM schema_meta WHERE key = 'document_shares_backfilled'").get();
    if (done) return;

    const sharedDocs = db.prepare('SELECT * FROM documents WHERE is_shared_with_tenant = 1').all();
    const insertShare = db.prepare('INSERT INTO document_shares (document_id, lease_id) VALUES (?, ?)');
    const flagReview = db.prepare('UPDATE documents SET needs_sharing_review = 1 WHERE id = ?');
    for (const doc of sharedDocs) {
      const leases = db.prepare('SELECT id FROM leases WHERE property_id = ?').all(doc.property_id);
      if (leases.length === 1) {
        insertShare.run(doc.id, leases[0].id);
      } else {
        // Zero leases: nothing to share with anyway, nothing to flag either.
        // Two or more: genuinely ambiguous — flag for the owner, share with no one yet.
        if (leases.length > 1) flagReview.run(doc.id);
      }
    }
    db.prepare("INSERT INTO schema_meta (key, value) VALUES ('document_shares_backfilled', datetime('now'))").run();
  },
];

function openDatabase(filePath) {
  const db = new DatabaseSync(filePath);
  db.exec(SCHEMA);

  // Run every migration, every startup, unconditionally — do NOT try to
  // "resume" from a stored version number as an array index into MIGRATIONS.
  // An earlier version of this function did exactly that (skip migrations
  // already covered by a stored count), and it silently breaks the moment a
  // migration is ever APPENDED after some databases have already recorded a
  // count: e.g. a database that had already run migration 0 back when
  // MIGRATIONS had length 1 stored a "done" marker that, once a second
  // migration existed, was numerically indistinguishable from "already ran
  // both" — so the new migration silently never ran on any pre-existing
  // database, while working fine on a brand new one (which has every column
  // from SCHEMA already and would mask the bug in casual testing). Every
  // migration here already checks its own precondition before doing
  // anything, so running the full list on every startup is both correct and
  // cheap — there is no scenario where that's unsafe for THIS array.
  for (const migration of MIGRATIONS) migration(db);

  // Purely informational from here on (nothing else reads this key) — a
  // simple, honest count of how many migrations this file defines, not a
  // resume position.
  const versionRow = db.prepare('SELECT value FROM schema_meta WHERE key = ?').get('version');
  const versionValue = String(MIGRATIONS.length);
  if (!versionRow) {
    db.prepare('INSERT INTO schema_meta (key, value) VALUES (?, ?)').run('version', versionValue);
  } else if (versionRow.value !== versionValue) {
    db.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(versionValue, 'version');
  }
  return db;
}

/** Default production DB file. Tests open their own (in-memory) instance instead. */
function openDefaultDatabase() {
  return openDatabase(path.join(DATA_DIR, 'app.db'));
}

module.exports = { openDatabase, openDefaultDatabase, DATA_DIR, UPLOADS_DIR };

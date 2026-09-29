const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

// We use Node's built-in SQLite (available natively since Node 22.5, no
// npm install required) as a real relational database with real tables,
// foreign keys, and transactions — not a JSON file pretending to be one.
// SQLite is a single file on disk, which is the right amount of database
// for one owner's portfolio, and it upgrades cleanly to Postgres later
// (the schema is plain ANSI-ish SQL) if this grows into a multi-owner,
// heavily concurrent product.

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

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

module.exports = { openDatabase, openDefaultDatabase, DATA_DIR };

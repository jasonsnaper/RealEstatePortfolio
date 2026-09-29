#!/usr/bin/env node
'use strict';

// Creates a realistic, clearly-labeled sample portfolio so a new owner can
// explore every part of the app immediately, without first spending an hour
// entering their own real properties. Every property this script creates has
// is_sample = 1 (the UI badges these everywhere they appear), and the whole
// set can be removed in one action from the "Remove sample data" banner on
// the dashboard (POST /api/sample-data/remove — see server/routes/sampleData.js
// for exactly what that deletes). Safe to run more than once: it does
// nothing if sample data already exists.
//
// This script talks to the database and the same library functions the real
// routes use (money, dates, charge generation, payment allocation) rather
// than a parallel implementation, so seed data is generated through the
// exact same logic that governs real usage — e.g. rent charges here are
// produced by the identical ensureChargesGenerated() the app calls on every
// real lease, not hand-crafted rows that merely look right.
//
// All dates are computed relative to "today" at the moment this script
// runs, so the data reads as current and lived-in whenever someone actually
// runs it, rather than a canned snapshot with a fixed, eventually-stale date.
// One consequence: the exact rent-status word shown for a charge dated
// "this month" (Partial vs. Late, for instance) can depend on which day of
// the month you happen to run this — that's the live status engine working
// correctly against whatever "today" really is, not a bug in the seed data.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { openDefaultDatabase } = require('./db');
const { hashPassword } = require('./lib/auth');
const { dollarsToCents } = require('./lib/money');
const { todayInTimezone, addMonths, addDays, compareDates } = require('./lib/dates');
const { ensureChargesGenerated } = require('./lib/chargeGenerator');
const { recordChargePayment } = require('./lib/paymentAllocation');
const { saveBase64Image, saveBase64Document } = require('./lib/helpers');

const TIMEZONE = 'America/Denver';
const UPLOADS_DIR = path.join(__dirname, '..', 'public', 'uploads');
const ASSETS_DIR = path.join(__dirname, '..', 'seed-assets');

const DEMO_OWNER_NAME = 'Demo Owner';
const DEMO_OWNER_EMAIL = 'demo@example.com';
const DEMO_OWNER_PASSWORD = 'password123';

let TODAY; // set once main() knows the timezone; used by the clamp() helper below

function imageDataUrl(filename) {
  const buf = fs.readFileSync(path.join(ASSETS_DIR, filename));
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

function textDocDataUrl(text) {
  return `data:text/plain;base64,${Buffer.from(text, 'utf8').toString('base64')}`;
}

/** Never let a generated "paid on" date land in the future relative to today. */
function clampToToday(dateStr) {
  return compareDates(dateStr, TODAY) > 0 ? TODAY : dateStr;
}

function monthsAgoFirst(n) {
  return addMonths(TODAY, -n).slice(0, 8) + '01';
}

// ---------------------------------------------------------------------------
// Small builders, one per entity, mirroring the columns in server/db.js.
// These write directly to the tables (this script has no HTTP session to act
// through), but reuse the real helpers for anything with actual logic behind
// it: money parsing, file saving, charge generation, payment allocation.
// ---------------------------------------------------------------------------

function createProperty(db, ownerId, { name, addressLine1, city, state, zip, coverImage }) {
  const result = db.prepare(`
    INSERT INTO properties (owner_id, name, address_line1, city, state, zip, timezone, is_sample)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)
  `).run(ownerId, name, addressLine1 || null, city || null, state || null, zip || null, TIMEZONE);
  const id = result.lastInsertRowid;
  db.prepare("INSERT INTO units (property_id, label) VALUES (?, 'Main')").run(id);
  if (coverImage) {
    const destDir = path.join(UPLOADS_DIR, 'properties', String(id));
    const filename = saveBase64Image(imageDataUrl(coverImage), destDir, 'cover');
    db.prepare('UPDATE properties SET cover_photo_path = ? WHERE id = ?').run(filename, id);
  }
  return db.prepare('SELECT * FROM properties WHERE id = ?').get(id);
}

function linkBankAccount(db, propertyId, bankAccountId) {
  db.prepare('INSERT OR IGNORE INTO property_bank_accounts (property_id, bank_account_id) VALUES (?, ?)').run(propertyId, bankAccountId);
}

// Every lease is created ACTIVE, even one whose "end" is already in the past
// — ensureChargesGenerated() refuses to run for a non-active lease, so a
// historical lease needs to generate and get paid its real charges FIRST,
// exactly as it would have when it was actually happening, and only THEN
// get flipped to 'ended' (via endLease below). That is also, not
// coincidentally, the same order a real owner uses the app in.
function createLease(db, propertyId, opts) {
  const result = db.prepare(`
    INSERT INTO leases (property_id, unit_id, tenant_name, co_tenant_name, tenant_email, tenant_phone, emergency_contact,
                         start_date, end_date, deposit_required_cents, deposit_held_cents,
                         due_day, late_after_days, status, owner_notes)
    VALUES (?, (SELECT id FROM units WHERE property_id = ? LIMIT 1), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
  `).run(
    propertyId, propertyId, opts.tenantName, opts.coTenantName || null, opts.tenantEmail || null, opts.tenantPhone || null,
    opts.emergencyContact || null, opts.startDate, opts.endDate || null,
    dollarsToCents(opts.depositRequired || 0), dollarsToCents(opts.depositHeld || 0),
    opts.dueDay || 1, opts.lateAfterDays ?? 5, opts.ownerNotes || null
  );
  const leaseId = result.lastInsertRowid;
  db.prepare('INSERT INTO lease_rent_history (lease_id, rent_cents, effective_date) VALUES (?, ?, ?)')
    .run(leaseId, dollarsToCents(opts.rent), opts.startDate);
  return leaseId;
}

function changeRent(db, leaseId, rent, effectiveDate) {
  db.prepare('INSERT INTO lease_rent_history (lease_id, rent_cents, effective_date) VALUES (?, ?, ?)')
    .run(leaseId, dollarsToCents(rent), effectiveDate);
}

function endLease(db, leaseId, depositDisposition) {
  db.prepare("UPDATE leases SET status='ended', deposit_disposition=?, ended_at=datetime('now') WHERE id=?")
    .run(depositDisposition || null, leaseId);
}

function payCharge(db, { propertyId, leaseId, charge }, amountCents, { method, paidAt, notes }) {
  recordChargePayment(db, {
    chargeId: charge.id, propertyId, leaseId, amountCents, type: 'payment',
    method: method || 'bank_transfer', paidAt: clampToToday(paidAt), notes: notes || null,
  });
}

function getCharges(db, leaseId) {
  return db.prepare('SELECT * FROM charges WHERE lease_id = ? ORDER BY period_start').all(leaseId);
}

function addPhoto(db, propertyId, { image, caption, album, takenAt, groupId, role }) {
  const destDir = path.join(UPLOADS_DIR, 'properties', String(propertyId), 'photos');
  const filename = saveBase64Image(imageDataUrl(image), destDir, 'seed');
  db.prepare(`
    INSERT INTO photos (property_id, file_path, caption, album, before_after_group_id, before_after_role, taken_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(propertyId, filename, caption || null, album || 'general', groupId || null, role || null, takenAt || null);
}

function addDocument(db, propertyId, { text, filename, category, expirationDate, sharedWithTenant }) {
  const destDir = path.join(UPLOADS_DIR, 'properties', String(propertyId), 'documents');
  const savedName = saveBase64Document(textDocDataUrl(text), destDir, 'seed');
  db.prepare(`
    INSERT INTO documents (property_id, file_path, filename, category, expiration_date, is_shared_with_tenant)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(propertyId, savedName, filename, category || null, expirationDate || null, sharedWithTenant ? 1 : 0);
}

function addMaintenance(db, propertyId, opts) {
  const result = db.prepare(`
    INSERT INTO maintenance_requests (property_id, title, description, priority, status, assigned_vendor,
                                       estimated_cost_cents, actual_cost_cents, scheduled_date, completed_date, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'owner')
  `).run(
    propertyId, opts.title, opts.description || null, opts.priority || 'normal', opts.status || 'open',
    opts.vendor || null, opts.estimatedCost != null ? dollarsToCents(opts.estimatedCost) : null,
    opts.actualCost != null ? dollarsToCents(opts.actualCost) : null, opts.scheduledDate || null, opts.completedDate || null
  );
  const id = result.lastInsertRowid;
  if (opts.photo) {
    const destDir = path.join(UPLOADS_DIR, 'properties', String(propertyId), 'maintenance');
    const filename = saveBase64Image(imageDataUrl(opts.photo), destDir, 'maint');
    db.prepare('INSERT INTO maintenance_photos (maintenance_request_id, file_path) VALUES (?, ?)').run(id, filename);
  }
  return id;
}

function logExpenseForMaintenance(db, propertyId, title, amountCents, date) {
  db.prepare(`
    INSERT INTO transactions (property_id, type, direction, amount_cents, category, description, txn_date, is_operating)
    VALUES (?, 'expense', 'out', ?, 'Maintenance', ?, ?, 1)
  `).run(propertyId, amountCents, `Maintenance: ${title}`, date);
}

function addValuation(db, propertyId, { valueCents, date, source, isPurchase }) {
  db.prepare(`
    INSERT INTO property_valuations (property_id, value_cents, valuation_date, source, is_purchase)
    VALUES (?, ?, ?, ?, ?)
  `).run(propertyId, valueCents, date, source || 'Owner estimate', isPurchase ? 1 : 0);
}

function addCapitalImprovement(db, propertyId, description, amountCents, date) {
  db.prepare(`
    INSERT INTO capital_improvements (property_id, description, amount_cents, improvement_date) VALUES (?, ?, ?, ?)
  `).run(propertyId, description, amountCents, date);
}

function addMortgage(db, propertyId, opts) {
  const result = db.prepare(`
    INSERT INTO mortgages (property_id, lender, original_amount_cents, current_principal_cents, interest_rate_bps,
                            monthly_payment_cents, due_day, origination_date, term_months, maturity_date, escrow_cents)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    propertyId, opts.lender, opts.originalAmountCents, opts.currentPrincipalCents, opts.rateBps,
    opts.monthlyPaymentCents, opts.dueDay || 1, opts.originationDate, opts.termMonths, opts.maturityDate, opts.escrowCents || 0
  );
  return result.lastInsertRowid;
}

function recordMortgagePayment(db, mortgageId, propertyId, { amountCents, principalCents, date, lender }) {
  db.prepare(`
    INSERT INTO transactions (property_id, type, direction, amount_cents, category, description, txn_date, is_operating, is_debt_service)
    VALUES (?, 'mortgage_payment', 'out', ?, 'Mortgage', ?, ?, 0, 1)
  `).run(propertyId, amountCents, `Mortgage payment — ${lender}`, date);
  db.prepare("UPDATE mortgages SET current_principal_cents = current_principal_cents - ?, updated_at = datetime('now') WHERE id = ?")
    .run(principalCents, mortgageId);
}

function addReminder(db, propertyId, { type, title, dueDate }) {
  db.prepare('INSERT INTO reminders (property_id, type, title, due_date) VALUES (?, ?, ?, ?)').run(propertyId, type, title, dueDate);
}

// ---------------------------------------------------------------------------

function seedMapleStreetDuplex(db, ownerId, sharedAccountId) {
  const property = createProperty(db, ownerId, {
    name: 'Maple Street Duplex', addressLine1: '123 Maple St', city: 'Denver', state: 'CO', zip: '80202',
    coverImage: 'cover-maple.jpg',
  });
  linkBankAccount(db, property.id, sharedAccountId);

  const start = monthsAgoFirst(4);
  const rentBumpDate = monthsAgoFirst(2);
  const renewalDate = addDays(TODAY, 40); // upcoming lease-expiration reminder, on purpose
  const leaseId = createLease(db, property.id, {
    tenantName: 'Jordan Alvarez', tenantEmail: 'jordan.alvarez@example.com', tenantPhone: '(303) 555-0142',
    emergencyContact: 'Dana Alvarez (sister) — (303) 555-0199',
    startDate: start, endDate: renewalDate, rent: 1750, depositRequired: 1750, depositHeld: 1750,
    dueDay: 1, lateAfterDays: 5,
    ownerNotes: 'Works night shifts as a nurse — texts land better than calls before noon.',
  });
  changeRent(db, leaseId, 1850, rentBumpDate);
  ensureChargesGenerated(db, leaseId, TIMEZONE);

  // A model tenant: every period paid in full, a couple of days after due.
  for (const charge of getCharges(db, leaseId)) {
    payCharge(db, { propertyId: property.id, leaseId, charge }, charge.amount_cents, {
      method: 'bank_transfer', paidAt: addDays(charge.due_date, 2), notes: 'Rent payment',
    });
  }

  const mortgageId = addMortgage(db, property.id, {
    lender: 'Rocky Mountain Credit Union', originalAmountCents: dollarsToCents(240000),
    currentPrincipalCents: dollarsToCents(228830), rateBps: 625, monthlyPaymentCents: dollarsToCents(1478.32),
    dueDay: 1, originationDate: monthsAgoFirst(38), termMonths: 360, maturityDate: addMonths(monthsAgoFirst(38), 360),
    escrowCents: dollarsToCents(214),
  });
  recordMortgagePayment(db, mortgageId, property.id, {
    amountCents: dollarsToCents(1478.32), principalCents: dollarsToCents(465.32),
    date: clampToToday(addDays(TODAY, -3)), lender: 'Rocky Mountain Credit Union',
  });

  addValuation(db, property.id, { valueCents: dollarsToCents(265000), date: monthsAgoFirst(38), source: 'Purchase price', isPurchase: true });
  addValuation(db, property.id, { valueCents: dollarsToCents(290000), date: monthsAgoFirst(13), source: 'Owner estimate (comparables)' });
  addValuation(db, property.id, { valueCents: dollarsToCents(310000), date: monthsAgoFirst(2), source: 'Owner estimate (comparables)' });
  addCapitalImprovement(db, property.id, 'New roof (30-yr architectural shingle)', dollarsToCents(9200), monthsAgoFirst(13));

  const faucetScheduled = monthsAgoFirst(1);
  const faucetCompleted = addDays(faucetScheduled, 2);
  addMaintenance(db, property.id, {
    title: 'Fixed leaking kitchen faucet', description: 'Slow drip under the kitchen sink, tenant reported water pooling in the cabinet.',
    priority: 'normal', status: 'completed', vendor: 'Denver Plumbing Co', actualCost: 180,
    scheduledDate: faucetScheduled, completedDate: faucetCompleted,
  });
  logExpenseForMaintenance(db, property.id, 'Fixed leaking kitchen faucet', dollarsToCents(180), faucetCompleted);
  addMaintenance(db, property.id, {
    title: 'Squeaky bedroom door hinge', description: 'Minor — tenant mentioned it in passing, not urgent.',
    priority: 'low', status: 'open',
  });

  addDocument(db, property.id, {
    text: 'SAMPLE LEASE AGREEMENT (for demonstration purposes only)\n\nMaple Street Duplex — 123 Maple St, Denver, CO 80202\nTenant: Jordan Alvarez\n\nThis file stands in for a real signed lease so you can see how documents work in this app.',
    filename: 'Lease Agreement — Maple St Duplex.txt', category: 'lease', sharedWithTenant: true,
  });
  addDocument(db, property.id, {
    text: 'SAMPLE INSURANCE DECLARATION (for demonstration purposes only)\n\nHomeowners policy placeholder — replace with your real declarations page.',
    filename: 'Homeowners Insurance Policy.txt', category: 'insurance', expirationDate: addDays(TODAY, 45),
  });

  addPhoto(db, property.id, { image: 'activity-movein-living.jpg', caption: 'Move-in condition — living room', album: 'move-in', takenAt: start });
  addPhoto(db, property.id, { image: 'activity-movein-kitchen.jpg', caption: 'Move-in condition — kitchen', album: 'move-in', takenAt: start });
  addPhoto(db, property.id, { image: 'activity-inspection.jpg', caption: 'Annual walkthrough — no issues found', album: 'inspection', takenAt: monthsAgoFirst(1) });
  const groupId = crypto.randomBytes(6).toString('hex');
  addPhoto(db, property.id, { image: 'activity-before-tile.jpg', caption: 'Kitchen faucet area before repair', album: 'repair', takenAt: faucetScheduled, groupId, role: 'before' });
  addPhoto(db, property.id, { image: 'activity-after-tile.jpg', caption: 'After repair — dry and reattached', album: 'repair', takenAt: faucetCompleted, groupId, role: 'after' });

  addReminder(db, property.id, { type: 'manual', title: 'Schedule annual gutter cleaning', dueDate: addDays(TODAY, 21) });

  return property;
}

function seedBirchwoodBungalow(db, ownerId, sharedAccountId) {
  const property = createProperty(db, ownerId, {
    name: 'Birchwood Bungalow', addressLine1: '48 Birchwood Ln', city: 'Denver', state: 'CO', zip: '80207',
    coverImage: 'cover-birchwood.jpg',
  });
  linkBankAccount(db, property.id, sharedAccountId); // same account as Maple — demonstrates no double-counting

  const start = monthsAgoFirst(3);
  const leaseId = createLease(db, property.id, {
    tenantName: 'Riley Chen', tenantEmail: 'riley.chen@example.com', tenantPhone: '(303) 555-0177',
    startDate: start, rent: 1600, depositRequired: 1600, depositHeld: 1600,
    dueDay: 1, lateAfterDays: 10, // generous late window — see note below on the current-period charge
  });
  ensureChargesGenerated(db, leaseId, TIMEZONE);
  const charges = getCharges(db, leaseId); // oldest -> newest: [-3, -2, -1, current]

  if (charges[0]) {
    payCharge(db, { propertyId: property.id, leaseId, charge: charges[0] }, charges[0].amount_cents, {
      method: 'check', paidAt: addDays(charges[0].due_date, 3),
    });
  }
  if (charges[1]) {
    // Paid in full, but well after the late date — shows up as "Paid" today
    // (status only ever reflects outstanding balance, not payment history),
    // while the payment-history modal still shows it landed late.
    payCharge(db, { propertyId: property.id, leaseId, charge: charges[1] }, charges[1].amount_cents, {
      method: 'check', paidAt: addDays(charges[1].late_date, 4), notes: 'Paid late — tenant said paycheck was delayed',
    });
  }
  if (charges[2]) {
    // A real, older unpaid balance — its late date has certainly passed by
    // now regardless of when this script runs, so this reliably shows Late.
    payCharge(db, { propertyId: property.id, leaseId, charge: charges[2] }, dollarsToCents(400), {
      method: 'check', paidAt: addDays(charges[2].due_date, 6), notes: 'Partial payment received',
    });
  }
  if (charges[3]) {
    // The current period: partially paid. Whether this reads as "Partial" or
    // "Late" today depends on whether the late date (due day 1 + 10 days)
    // has passed yet this month — both are correct, live answers.
    payCharge(db, { propertyId: property.id, leaseId, charge: charges[3] }, Math.round(charges[3].amount_cents * 0.5), {
      method: 'card', paidAt: TODAY, notes: 'Partial payment received',
    });
  }

  addMaintenance(db, property.id, {
    title: 'Kitchen sink leaking under cabinet', description: 'Tenant noticed water pooling under the sink this week.',
    priority: 'high', status: 'open', scheduledDate: addDays(TODAY, 12), photo: 'maint-leak.jpg',
  });

  addDocument(db, property.id, {
    text: 'SAMPLE LEASE AGREEMENT (for demonstration purposes only)\n\nBirchwood Bungalow — 48 Birchwood Ln, Denver, CO 80207\nTenant: Riley Chen',
    filename: 'Lease Agreement — Birchwood Bungalow.txt', category: 'lease', sharedWithTenant: true,
  });

  return property;
}

function seedCedarCourtCottage(db, ownerId, cedarAccountId) {
  const property = createProperty(db, ownerId, {
    name: 'Cedar Court Cottage', addressLine1: '9 Cedar Ct', city: 'Denver', state: 'CO', zip: '80211',
    coverImage: 'cover-cedar.jpg',
  });
  linkBankAccount(db, property.id, cedarAccountId);

  const start = monthsAgoFirst(13);
  const end = monthsAgoFirst(2);
  const leaseId = createLease(db, property.id, {
    tenantName: 'Priya Shah', tenantEmail: 'priya.shah@example.com',
    startDate: start, endDate: end, rent: 1400, depositRequired: 1400, depositHeld: 1400,
    dueDay: 1, lateAfterDays: 5,
  });
  ensureChargesGenerated(db, leaseId, TIMEZONE);
  for (const charge of getCharges(db, leaseId)) {
    payCharge(db, { propertyId: property.id, leaseId, charge }, charge.amount_cents, {
      method: 'bank_transfer', paidAt: addDays(charge.due_date, 1),
    });
  }
  endLease(db, leaseId, 'Returned in full ($1,400.00) via check on move-out; no deductions.');

  addDocument(db, property.id, {
    text: 'SAMPLE LEASE AGREEMENT (for demonstration purposes only, tenant has since moved out)\n\nCedar Court Cottage — 9 Cedar Ct, Denver, CO 80211\nTenant: Priya Shah',
    filename: 'Lease Agreement — Priya Shah (past tenant).txt', category: 'lease',
  });
  addPhoto(db, property.id, { image: 'activity-movein-living.jpg', caption: 'Move-out condition — living room, left broom-clean', album: 'move-out', takenAt: end });

  return property;
}

function seedWillowLoft(db, ownerId) {
  const property = createProperty(db, ownerId, {
    name: 'Willow Loft', addressLine1: '210 Willow Way', city: 'Denver', state: 'CO', zip: '80218',
  });

  const start = monthsAgoFirst(8);
  const end = monthsAgoFirst(6);
  const leaseId = createLease(db, property.id, {
    tenantName: 'Marcus Webb', startDate: start, endDate: end, rent: 1300, depositRequired: 1300, depositHeld: 1300,
    dueDay: 1, lateAfterDays: 5,
  });
  ensureChargesGenerated(db, leaseId, TIMEZONE);
  for (const charge of getCharges(db, leaseId)) {
    payCharge(db, { propertyId: property.id, leaseId, charge }, charge.amount_cents, {
      method: 'check', paidAt: addDays(charge.due_date, 1),
    });
  }
  endLease(db, leaseId, 'Partial deduction for carpet cleaning ($150 of $1,300 held); $1,150.00 returned.');

  // Archived last: this is a property the owner no longer manages, kept
  // fully intact (per "edit/archive without losing history") rather than
  // deleted — a different concept from "sample data" being removable.
  db.prepare("UPDATE properties SET status='archived', archived_at=datetime('now') WHERE id=?").run(property.id);

  return property;
}

function main() {
  const db = openDefaultDatabase();

  const existingSample = db.prepare('SELECT COUNT(*) AS n FROM properties WHERE is_sample = 1').get();
  if (existingSample.n > 0) {
    console.log(`Sample data already exists (${existingSample.n} sample propert${existingSample.n === 1 ? 'y' : 'ies'}). Nothing to do.`);
    console.log('To regenerate it, sign in, click "Remove sample data" on the dashboard, then run `npm run seed` again.');
    return;
  }

  let owner = db.prepare('SELECT * FROM owners LIMIT 1').get();
  let createdOwner = false;
  if (!owner) {
    const passwordHash = hashPassword(DEMO_OWNER_PASSWORD);
    const result = db.prepare('INSERT INTO owners (name, email, password_hash) VALUES (?, ?, ?)')
      .run(DEMO_OWNER_NAME, DEMO_OWNER_EMAIL, passwordHash);
    owner = db.prepare('SELECT * FROM owners WHERE id = ?').get(result.lastInsertRowid);
    createdOwner = true;
  }

  TODAY = todayInTimezone(TIMEZONE);

  const sharedAccountId = db.prepare(`
    INSERT INTO bank_accounts (owner_id, nickname, mode, manual_balance_cents, manual_as_of, is_sample)
    VALUES (?, 'Chase Checking ...4821', 'manual', ?, ?, 1)
  `).run(owner.id, dollarsToCents(8450), TODAY).lastInsertRowid;

  const cedarAccountId = db.prepare(`
    INSERT INTO bank_accounts (owner_id, nickname, mode, manual_balance_cents, manual_as_of, is_sample)
    VALUES (?, 'Cedar Court Savings', 'manual', ?, ?, 1)
  `).run(owner.id, dollarsToCents(2100), TODAY).lastInsertRowid;

  seedMapleStreetDuplex(db, owner.id, sharedAccountId);
  seedBirchwoodBungalow(db, owner.id, sharedAccountId);
  seedCedarCourtCottage(db, owner.id, cedarAccountId);
  seedWillowLoft(db, owner.id);

  console.log('Sample portfolio created: 4 properties (Maple Street Duplex, Birchwood Bungalow — sharing one bank');
  console.log('account with Maple to show shared-account handling — Cedar Court Cottage, and archived Willow Loft).');
  if (createdOwner) {
    console.log('');
    console.log('A demo owner account was also created so you can sign in right away:');
    console.log(`  Email:    ${DEMO_OWNER_EMAIL}`);
    console.log(`  Password: ${DEMO_OWNER_PASSWORD}`);
    console.log('Change the password after signing in, or remove this account by editing data/app.db directly.');
  } else {
    console.log('Added to your existing account — sign in as usual to see them.');
  }
  console.log('');
  console.log('Every sample property is badged "sample" in the app, and can be removed in one step from the');
  console.log('"Remove sample data" banner on the dashboard once you are ready to add your own properties.');
}

main();

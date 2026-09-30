// The lease-agreement lifecycle: draft fields -> finalize -> landlord signs
// & sends -> renter(s) sign/decline/request changes -> completed PDF + audit
// trail -> lease/billing sync. Mirrors server/lib/statements.js's shape (a
// pure render function, a pipeline function that writes the file and a DB
// row, and a serializer) but adds the multi-step signing state machine that
// a one-shot PDF like a statement never needed.
//
// Signing implementation note (see README for the full explanation): this
// is an in-house, clearly-labeled DEMO signing mechanism — a typed full
// legal name plus an explicit electronic-signing consent checkbox plus a
// distinct final "Sign" action, with the server (never the browser) writing
// every timestamp. It is not, and must never be presented as, a real
// e-signature provider (DocuSign, Dropbox Sign, etc.) or as carrying the
// same legal/technical assurances as one (embedded identity verification,
// tamper-evident provider-side certificates, provider-hosted audit
// storage). agreements.provider is stored as 'demo' for exactly this
// reason — see the README section on wiring up a real provider instead.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { apiError } = require('./router');
const { logAudit } = require('./helpers');
const { dollarsToCents, centsToDisplay } = require('./money');
const { PdfDocument } = require('./pdf');
const { wrapText } = require('./pdfText');
const { applyTemplate, ensureSampleTemplate, getOwnedTemplateOr404 } = require('./leaseTemplates');
const { UPLOADS_DIR } = require('../db');

const OPEN_STATUSES = ['draft', 'awaiting_landlord_signature', 'awaiting_renter_signature', 'partially_signed', 'changes_requested'];
const TERMINAL_STATUSES = ['completed', 'declined', 'voided'];

function addressLine(property) {
  const line = [property.address_line1, property.address_line2, [property.city, property.state].filter(Boolean).join(', '), property.zip]
    .filter(Boolean).join(', ');
  return line ? `${property.name} — ${line}` : property.name;
}

function formatDateShort(dateStr) {
  if (!dateStr) return '—';
  const [y, m, d] = dateStr.split('-').map(Number);
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

function formatDateTimeShort(isoStr) {
  if (!isoStr) return '—';
  return `${formatDateShort(isoStr.slice(0, 10))} at ${isoStr.slice(11, 16)} UTC`;
}

function centsToPlainDollars(cents) {
  return (Number(cents || 0) / 100).toFixed(2);
}

/** Parses a dollar-amount field the same way the rest of the app does, but never throws — returns NaN on anything invalid so callers can report a clean 400 instead of a 500. */
function safeCents(v) {
  try { return dollarsToCents(v); } catch (e) { return NaN; }
}

// ---------------------------------------------------------------------------
// Fields: the structured deal terms (db.js's lease_agreements.fields_json).
// Money/day values are stored as the plain strings/numbers an editable form
// posts back, NOT pre-formatted — toDisplayFields() below produces the
// human-readable version used inside the rendered document.
// ---------------------------------------------------------------------------

function deriveTenantsFromLease(db, leaseId) {
  return db.prepare(`
    SELECT r.id AS renter_id, r.name, lr.role FROM lease_renters lr JOIN renters r ON r.id = lr.renter_id
    WHERE lr.lease_id = ? ORDER BY (lr.role = 'primary') DESC, r.name
  `).all(leaseId).map((t) => ({ renterId: t.renter_id, name: t.name, role: t.role }));
}

function buildDefaultFields(db, lease, property, owner) {
  const tenants = deriveTenantsFromLease(db, lease.id);

  const rentHistory = db.prepare('SELECT rent_cents FROM lease_rent_history WHERE lease_id = ? ORDER BY effective_date DESC LIMIT 1').get(lease.id);

  return {
    landlordName: owner.name || '',
    landlordContact: owner.email || '',
    tenants,
    propertyAddress: addressLine(property),
    monthlyRent: rentHistory ? centsToPlainDollars(rentHistory.rent_cents) : '',
    securityDeposit: centsToPlainDollars(lease.deposit_required_cents || 0),
    leaseStartDate: lease.start_date || '',
    leaseEndDate: lease.end_date || '',
    monthToMonth: !lease.end_date,
    rentDueDay: lease.due_day || 1,
    graceDays: lease.late_after_days ?? 5,
    gracePeriod: lease.late_fee_enabled
      ? `Rent is due on the day stated above. A late fee applies after ${lease.late_after_days ?? 5} day(s) past the due date` +
        (lease.late_fee_type === 'percent' ? ` (${((lease.late_fee_amount_cents || 0) / 100).toFixed(2)}% of the rent).` : ` (${centsToDisplay(lease.late_fee_amount_cents || 0)}).`)
      : `Rent is due on the day stated above. A grace period of ${lease.late_after_days ?? 5} day(s) applies before rent is considered late.`,
    additionalOccupants: '',
    utilitiesResponsibilities: '',
    additionalTerms: '',
  };
}

function toDisplayFields(fields) {
  const rentCents = safeCents(fields.monthlyRent);
  const depositCents = safeCents(fields.securityDeposit || 0);
  return {
    ...fields,
    tenantNames: (fields.tenants || []).map((t) => t.name).filter(Boolean).join(' and ') || '[no tenant named yet]',
    monthlyRent: Number.isFinite(rentCents) && rentCents > 0 ? `${centsToDisplay(rentCents)} per month` : '[monthly rent not yet set]',
    securityDeposit: Number.isFinite(depositCents) ? centsToDisplay(depositCents) : '[security deposit not yet set]',
    leaseStartDate: fields.leaseStartDate ? formatDateShort(fields.leaseStartDate) : '[start date not yet set]',
    leaseEndDate: fields.monthToMonth ? 'this is a month-to-month tenancy with no fixed end date' : (fields.leaseEndDate ? formatDateShort(fields.leaseEndDate) : '[end date not yet set]'),
    additionalOccupants: fields.additionalOccupants && fields.additionalOccupants.trim() ? fields.additionalOccupants : 'None',
    additionalTerms: fields.additionalTerms && fields.additionalTerms.trim() ? fields.additionalTerms : 'None.',
  };
}

function validateFieldsForFinalize(fields) {
  const missing = [];
  if (!fields.landlordName || !fields.landlordName.trim()) missing.push('Landlord/legal entity name');
  if (!fields.landlordContact || !fields.landlordContact.trim()) missing.push('Landlord contact information');
  if (!Array.isArray(fields.tenants) || fields.tenants.length === 0) missing.push('At least one tenant');
  if (!fields.propertyAddress || !fields.propertyAddress.trim()) missing.push('Property address');
  const rentCents = safeCents(fields.monthlyRent);
  if (!Number.isFinite(rentCents) || rentCents <= 0) missing.push('Monthly rent (a valid amount greater than $0)');
  const depositCents = safeCents(fields.securityDeposit || 0);
  if (!Number.isFinite(depositCents) || depositCents < 0) missing.push('Security deposit (a valid amount, or 0)');
  if (!fields.leaseStartDate) missing.push('Lease start / move-in date');
  if (!fields.monthToMonth && !fields.leaseEndDate) missing.push('Lease end date (or mark this month-to-month)');
  const dueDay = Number(fields.rentDueDay);
  if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) missing.push('Rent due day (1-31)');
  if (!fields.gracePeriod || !fields.gracePeriod.trim()) missing.push('Grace period / late terms');
  if (!fields.utilitiesResponsibilities || !fields.utilitiesResponsibilities.trim()) missing.push('Utilities and responsibilities');
  if (missing.length) throw apiError(400, `Before finalizing, fill in: ${missing.join('; ')}.`);
}

// ---------------------------------------------------------------------------
// Signers
// ---------------------------------------------------------------------------

/** Keeps lease_signers in lockstep with fields.tenants + fields.landlordName. Only ever called while status is still 'draft' — once sent, nothing about who must sign is allowed to change (see finalizeAgreement). */
function syncSignersFromFields(db, agreement, fields, owner) {
  const current = db.prepare('SELECT * FROM lease_signers WHERE agreement_id = ?').all(agreement.id);
  const landlordRow = current.find((s) => s.role === 'landlord');
  const landlordName = (fields.landlordName && fields.landlordName.trim()) || owner.name;
  if (landlordRow) {
    db.prepare('UPDATE lease_signers SET display_name = ? WHERE id = ?').run(landlordName, landlordRow.id);
  } else {
    db.prepare(`INSERT INTO lease_signers (agreement_id, role, renter_id, display_name) VALUES (?, 'landlord', NULL, ?)`).run(agreement.id, landlordName);
  }

  const tenants = Array.isArray(fields.tenants) ? fields.tenants : [];
  const tenantIds = new Set(tenants.map((t) => t.renterId));
  for (const s of current) {
    if (s.role !== 'landlord' && !tenantIds.has(s.renter_id)) {
      db.prepare('DELETE FROM lease_signers WHERE id = ?').run(s.id);
    }
  }
  for (const t of tenants) {
    const role = t.role === 'co_renter' ? 'co_tenant' : 'tenant';
    const existing = current.find((s) => s.renter_id === t.renterId);
    if (existing) {
      db.prepare('UPDATE lease_signers SET display_name = ?, role = ? WHERE id = ?').run(t.name, role, existing.id);
    } else {
      db.prepare(`INSERT INTO lease_signers (agreement_id, role, renter_id, display_name) VALUES (?, ?, ?, ?)`).run(agreement.id, role, t.renterId, t.name);
    }
  }
}

function serializeAgreement(db, agreement) {
  const signers = db.prepare(`SELECT * FROM lease_signers WHERE agreement_id = ? ORDER BY (role = 'landlord') DESC, id`).all(agreement.id);
  const property = db.prepare(`SELECT p.id FROM leases l JOIN properties p ON p.id = l.property_id WHERE l.id = ?`).get(agreement.lease_id);
  return {
    id: agreement.id,
    leaseId: agreement.lease_id,
    templateId: agreement.template_id,
    status: agreement.status,
    statusLabel: STATUS_LABELS[agreement.status] || agreement.status,
    version: agreement.version,
    replacesAgreementId: agreement.replaces_agreement_id,
    fields: JSON.parse(agreement.fields_json),
    bodySnapshot: agreement.body_snapshot,
    provider: agreement.provider,
    finalPdfUrl: agreement.final_pdf_path ? `/uploads/properties/${property.id}/lease-agreements/${agreement.final_pdf_path}` : null,
    documentHash: agreement.document_hash,
    declineReason: agreement.decline_reason,
    correctionRequest: agreement.correction_request,
    createdAt: agreement.created_at,
    sentAt: agreement.sent_at,
    completedAt: agreement.completed_at,
    voidedAt: agreement.voided_at,
    signers: signers.map(serializeSigner),
  };
}

function serializeSigner(s) {
  return {
    id: s.id,
    role: s.role,
    renterId: s.renter_id,
    displayName: s.display_name,
    status: s.status,
    consentedAt: s.consented_at,
    signedAt: s.signed_at,
    signatureText: s.status === 'signed' ? s.signature_text : null,
    declineMessage: s.decline_message,
  };
}

// ---------------------------------------------------------------------------
// Events (append-only signing audit trail — db.js's lease_agreement_events)
// ---------------------------------------------------------------------------

function logAgreementEvent(db, agreementId, eventType, actorType, actorId, detail) {
  db.prepare(`INSERT INTO lease_agreement_events (agreement_id, event_type, actor_type, actor_id, detail_json) VALUES (?, ?, ?, ?, ?)`)
    .run(agreementId, eventType, actorType, actorId ?? null, detail ? JSON.stringify(detail) : null);
}

function getEventsForAgreement(db, agreementId) {
  return db.prepare('SELECT * FROM lease_agreement_events WHERE agreement_id = ? ORDER BY id').all(agreementId).map((e) => ({
    id: e.id, eventType: e.event_type, actorType: e.actor_type, actorId: e.actor_id,
    detail: e.detail_json ? JSON.parse(e.detail_json) : null, createdAt: e.created_at,
  }));
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

function getOwnedAgreementOr404(db, ownerId, agreementId) {
  const row = db.prepare(`
    SELECT la.* FROM lease_agreements la JOIN leases l ON l.id = la.lease_id JOIN properties p ON p.id = l.property_id
    WHERE la.id = ? AND p.owner_id = ?
  `).get(agreementId, ownerId);
  if (!row) throw apiError(404, 'Agreement not found');
  return row;
}

/** 404s (never 403) unless this renter actually has a signer row on this agreement — the same "don't distinguish a wrong id from someone else's" convention as getRenterLeaseOr404, and what makes a former tenant's later-lease documents structurally invisible to them. */
function getRenterAgreementOr404(db, renterId, agreementId) {
  const agreement = db.prepare('SELECT * FROM lease_agreements WHERE id = ?').get(agreementId);
  if (!agreement) throw apiError(404, 'Agreement not found');
  const signer = db.prepare('SELECT id FROM lease_signers WHERE agreement_id = ? AND renter_id = ?').get(agreementId, renterId);
  if (!signer) throw apiError(404, 'Agreement not found');
  return agreement;
}

function listAgreementsForLease(db, leaseId) {
  return db.prepare('SELECT * FROM lease_agreements WHERE lease_id = ? ORDER BY id DESC').all(leaseId);
}

/** Every agreement this renter was actually a party to, on this lease — see getRenterAgreementOr404's comment on why this is what keeps a former tenant from ever seeing a subsequent tenant's documents. */
function listAgreementsForRenter(db, renterId, leaseId) {
  return db.prepare(`
    SELECT DISTINCT la.* FROM lease_agreements la JOIN lease_signers ls ON ls.agreement_id = la.id
    WHERE la.lease_id = ? AND ls.renter_id = ? ORDER BY la.id DESC
  `).all(leaseId, renterId);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Returns the lease's current in-progress agreement if one exists (never
 * creates a duplicate — this is what makes re-sending/re-opening safe), else
 * starts a fresh one. A fresh one after a declined/voided/completed
 * predecessor carries its fields forward (so correcting one mistake doesn't
 * mean retyping the whole form) and links back via replaces_agreement_id —
 * the completed/declined/voided row itself is never modified, only
 * superseded, which is what keeps a completed document immutable.
 */
function getOrCreateDraftAgreement(db, { lease, property, owner, templateId }) {
  const latest = db.prepare('SELECT * FROM lease_agreements WHERE lease_id = ? ORDER BY id DESC LIMIT 1').get(lease.id);
  if (latest && OPEN_STATUSES.includes(latest.status)) {
    if (latest.status === 'draft') {
      // Keep the tenant/signer list in sync with the lease's ACTUAL renters
      // for as long as nothing has been finalized yet — e.g. the owner added
      // a co-renter (server/routes/renterManagement.js) after starting this
      // draft, and re-opens it expecting them to already be listed as a
      // required signer, not silently missing.
      const fields = JSON.parse(latest.fields_json);
      fields.tenants = deriveTenantsFromLease(db, lease.id);
      db.prepare('UPDATE lease_agreements SET fields_json = ? WHERE id = ?').run(JSON.stringify(fields), latest.id);
      const refreshed = db.prepare('SELECT * FROM lease_agreements WHERE id = ?').get(latest.id);
      syncSignersFromFields(db, refreshed, fields, owner);
      return refreshed;
    }
    return latest;
  }

  const template = templateId ? getOwnedTemplateOr404(db, owner.id, templateId) : ensureSampleTemplate(db, owner.id);
  const fields = latest ? JSON.parse(latest.fields_json) : buildDefaultFields(db, lease, property, owner);
  const version = latest ? latest.version + 1 : 1;

  const result = db.prepare(`
    INSERT INTO lease_agreements (lease_id, template_id, status, version, replaces_agreement_id, fields_json, provider)
    VALUES (?, ?, 'draft', ?, ?, ?, 'demo')
  `).run(lease.id, template.id, version, latest ? latest.id : null, JSON.stringify(fields));
  const agreement = db.prepare('SELECT * FROM lease_agreements WHERE id = ?').get(result.lastInsertRowid);
  syncSignersFromFields(db, agreement, fields, owner);
  logAgreementEvent(db, agreement.id, 'created', 'owner', owner.id, latest ? { replacesAgreementId: latest.id } : null);
  return agreement;
}

function updateDraftFields(db, agreement, owner, { templateId, fields }) {
  if (agreement.status !== 'draft') throw apiError(409, 'This agreement has already been finalized. Void it and start a new one to change its terms.');
  const merged = { ...JSON.parse(agreement.fields_json), ...(fields || {}) };
  let template_id = agreement.template_id;
  if (templateId) {
    template_id = getOwnedTemplateOr404(db, owner.id, templateId).id;
  }
  db.prepare('UPDATE lease_agreements SET fields_json = ?, template_id = ? WHERE id = ?').run(JSON.stringify(merged), template_id, agreement.id);
  const updated = db.prepare('SELECT * FROM lease_agreements WHERE id = ?').get(agreement.id);
  syncSignersFromFields(db, updated, merged, owner);
  return updated;
}

/** Freezes fields_json's terms into body_snapshot and moves the agreement out of 'draft' — the point of no return before signing. Refuses to run on an incomplete form (see the spec's "must not immediately send an unfinished document"). */
function finalizeAgreement(db, agreement, owner) {
  if (agreement.status !== 'draft') throw apiError(409, 'This agreement is not a draft.');
  const fields = JSON.parse(agreement.fields_json);
  validateFieldsForFinalize(fields);
  const template = db.prepare('SELECT * FROM lease_templates WHERE id = ?').get(agreement.template_id);
  const bodySnapshot = applyTemplate(template.body_text, toDisplayFields(fields));
  db.prepare(`UPDATE lease_agreements SET status = 'awaiting_landlord_signature', body_snapshot = ? WHERE id = ?`).run(bodySnapshot, agreement.id);
  logAgreementEvent(db, agreement.id, 'finalized', 'owner', owner.id, null);
  return db.prepare('SELECT * FROM lease_agreements WHERE id = ?').get(agreement.id);
}

/** Steps 1-5 of the spec's landlord flow as one atomic server action: review happens client-side against the frozen body_snapshot, then this call records explicit consent + the signature + a server timestamp, and sends. */
function landlordSignAndSend(db, agreement, owner, { consent, signatureText }) {
  if (agreement.status !== 'awaiting_landlord_signature') throw apiError(409, 'This agreement is not awaiting your signature.');
  if (consent !== true) throw apiError(400, 'You must explicitly agree to sign electronically.');
  const name = String(signatureText || '').trim();
  if (!name) throw apiError(400, 'Type your full legal name to sign.');

  const signer = db.prepare(`SELECT * FROM lease_signers WHERE agreement_id = ? AND role = 'landlord'`).get(agreement.id);
  if (!signer) throw apiError(500, 'Landlord signer record is missing for this agreement.');
  if (signer.status === 'signed') throw apiError(409, 'You have already signed this agreement.');

  db.prepare(`UPDATE lease_signers SET status = 'signed', consented_at = datetime('now'), signed_at = datetime('now'), signature_text = ? WHERE id = ?`).run(name, signer.id);
  logAgreementEvent(db, agreement.id, 'consented', 'owner', owner.id, null);
  logAgreementEvent(db, agreement.id, 'signed', 'owner', owner.id, { signatureText: name });

  const tenantSigners = db.prepare(`SELECT * FROM lease_signers WHERE agreement_id = ? AND role != 'landlord'`).all(agreement.id);
  const recipients = tenantSigners
    .map((s) => (s.renter_id ? db.prepare('SELECT email FROM renters WHERE id = ?').get(s.renter_id) : null))
    .filter(Boolean).map((r) => r.email).filter(Boolean);
  db.prepare(`UPDATE lease_agreements SET sent_at = datetime('now') WHERE id = ?`).run(agreement.id);
  logAgreementEvent(db, agreement.id, 'sent', 'owner', owner.id, { recipients });
  console.log(`\n[Lease agreement] Agreement #${agreement.id} sent for signature. Tenant recipients: ${recipients.length ? recipients.join(', ') : '(no tenant email on file)'}. No email provider is configured — tenants see an "Action Required" card in their renter portal regardless. See README.\n`);
  logAudit(db, { actorType: 'owner', actorId: owner.id, action: 'send_lease_agreement', entityType: 'lease_agreement', entityId: agreement.id });

  return recomputeAgreementStatus(db, agreement.id);
}

/** Moves the agreement's overall status forward after ANY signer finishes, completing it once every signer has. Re-fetches status fresh and no-ops on a terminal one, so calling this twice for the same event (a retry, a duplicate notification) is always safe. */
function recomputeAgreementStatus(db, agreementId) {
  const agreement = db.prepare('SELECT * FROM lease_agreements WHERE id = ?').get(agreementId);
  if (TERMINAL_STATUSES.includes(agreement.status)) return agreement;
  const signers = db.prepare('SELECT * FROM lease_signers WHERE agreement_id = ?').all(agreementId);
  const allSigned = signers.length > 0 && signers.every((s) => s.status === 'signed');
  if (allSigned) return completeAgreement(db, agreement);
  // Only tenant/co-tenant signers count toward "partially signed" — by the
  // time this runs the landlord has always already signed (that's what
  // makes 'awaiting_renter_signature' reachable in the first place; see
  // landlordSignAndSend), so counting the landlord here would make every
  // freshly-sent agreement look "partially signed" before any tenant has
  // done anything.
  const tenantSigners = signers.filter((s) => s.role !== 'landlord');
  const anyTenantSigned = tenantSigners.some((s) => s.status === 'signed');
  const nextStatus = anyTenantSigned ? 'partially_signed' : 'awaiting_renter_signature';
  db.prepare('UPDATE lease_agreements SET status = ? WHERE id = ?').run(nextStatus, agreement.id);
  return db.prepare('SELECT * FROM lease_agreements WHERE id = ?').get(agreement.id);
}

function renterSign(db, agreement, renter, { consent, signatureText }) {
  if (!['awaiting_renter_signature', 'partially_signed'].includes(agreement.status)) {
    throw apiError(409, 'This agreement is not currently awaiting your signature.');
  }
  if (consent !== true) throw apiError(400, 'You must explicitly consent to sign electronically.');
  const name = String(signatureText || '').trim();
  if (!name) throw apiError(400, 'Type your full legal name to sign.');

  // Looked up by (agreement id, the CALLER's OWN renter id) — never a
  // client-supplied signer id — so one signer can never complete another
  // signer's field; there is no id here to substitute in the first place.
  const signer = db.prepare('SELECT * FROM lease_signers WHERE agreement_id = ? AND renter_id = ?').get(agreement.id, renter.id);
  if (!signer) throw apiError(404, 'Agreement not found');
  if (signer.status === 'signed') throw apiError(409, 'You have already signed this agreement.');
  if (signer.status === 'declined') throw apiError(409, 'You already declined this agreement.');

  db.prepare(`UPDATE lease_signers SET status = 'signed', consented_at = datetime('now'), signed_at = datetime('now'), signature_text = ? WHERE id = ?`).run(name, signer.id);
  logAgreementEvent(db, agreement.id, 'consented', 'renter', renter.id, null);
  logAgreementEvent(db, agreement.id, 'signed', 'renter', renter.id, { signatureText: name });
  console.log(`\n[Lease agreement] ${renter.name} signed agreement #${agreement.id}.\n`);

  return recomputeAgreementStatus(db, agreement.id);
}

function renterDecline(db, agreement, renter, { message }) {
  if (TERMINAL_STATUSES.includes(agreement.status)) throw apiError(409, 'This agreement is no longer open.');
  const text = String(message || '').trim();
  if (!text) throw apiError(400, 'Please include a short message explaining why you are declining.');
  const signer = db.prepare('SELECT * FROM lease_signers WHERE agreement_id = ? AND renter_id = ?').get(agreement.id, renter.id);
  if (!signer) throw apiError(404, 'Agreement not found');
  if (signer.status === 'signed') throw apiError(409, 'You already signed this agreement.');

  db.prepare(`UPDATE lease_signers SET status = 'declined', decline_message = ? WHERE id = ?`).run(text, signer.id);
  db.prepare(`UPDATE lease_agreements SET status = 'declined', decline_reason = ? WHERE id = ?`).run(text, agreement.id);
  logAgreementEvent(db, agreement.id, 'declined', 'renter', renter.id, { message: text });
  console.log(`\n[Lease agreement] ${renter.name} DECLINED agreement #${agreement.id}: "${text}"\n`);
  return db.prepare('SELECT * FROM lease_agreements WHERE id = ?').get(agreement.id);
}

function renterRequestCorrection(db, agreement, renter, { message }) {
  if (TERMINAL_STATUSES.includes(agreement.status)) throw apiError(409, 'This agreement is no longer open.');
  const text = String(message || '').trim();
  if (!text) throw apiError(400, 'Please describe what needs to be corrected.');
  const signer = db.prepare('SELECT * FROM lease_signers WHERE agreement_id = ? AND renter_id = ?').get(agreement.id, renter.id);
  if (!signer) throw apiError(404, 'Agreement not found');
  if (signer.status === 'signed') throw apiError(409, 'You already signed this agreement.');

  db.prepare(`UPDATE lease_agreements SET status = 'changes_requested', correction_request = ? WHERE id = ?`).run(text, agreement.id);
  logAgreementEvent(db, agreement.id, 'correction_requested', 'renter', renter.id, { message: text });
  console.log(`\n[Lease agreement] ${renter.name} requested a correction on agreement #${agreement.id}: "${text}"\n`);
  return db.prepare('SELECT * FROM lease_agreements WHERE id = ?').get(agreement.id);
}

function voidAgreement(db, agreement, owner, { reason } = {}) {
  if (TERMINAL_STATUSES.includes(agreement.status) && agreement.status !== 'declined') {
    throw apiError(409, `This agreement is already ${agreement.status}.`);
  }
  db.prepare(`UPDATE lease_agreements SET status = 'voided', voided_at = datetime('now') WHERE id = ?`).run(agreement.id);
  logAgreementEvent(db, agreement.id, 'voided', 'owner', owner.id, reason ? { reason } : null);
  logAudit(db, { actorType: 'owner', actorId: owner.id, action: 'void_lease_agreement', entityType: 'lease_agreement', entityId: agreement.id });
  return db.prepare('SELECT * FROM lease_agreements WHERE id = ?').get(agreement.id);
}

/** "Remind" — re-announces the same pending signers rather than sending anything new, so it can never create a duplicate agreement or duplicate signature. */
function remindPendingSigners(db, agreement, owner) {
  if (TERMINAL_STATUSES.includes(agreement.status)) throw apiError(409, 'This agreement is no longer open.');
  const pending = db.prepare(`SELECT * FROM lease_signers WHERE agreement_id = ? AND status = 'pending'`).all(agreement.id);
  for (const s of pending) {
    const contact = s.renter_id ? ((db.prepare('SELECT email FROM renters WHERE id = ?').get(s.renter_id) || {}).email || 'no email on file') : 'landlord';
    console.log(`\n[Lease agreement] Reminder: ${s.display_name} (${contact}) still needs to sign agreement #${agreement.id}. No email provider is configured — see README.\n`);
  }
  logAgreementEvent(db, agreement.id, 'reminded', 'owner', owner.id, { count: pending.length });
  return pending.length;
}

// ---------------------------------------------------------------------------
// Completion: final PDF + hash + lease/billing sync
// ---------------------------------------------------------------------------

function completeAgreement(db, agreement) {
  if (agreement.status === 'completed') return agreement; // idempotency guard — see recomputeAgreementStatus's header comment

  const lease = db.prepare('SELECT * FROM leases WHERE id = ?').get(agreement.lease_id);
  const property = db.prepare('SELECT * FROM properties WHERE id = ?').get(lease.property_id);
  const signerRows = db.prepare(`SELECT * FROM lease_signers WHERE agreement_id = ? ORDER BY (role = 'landlord') DESC, id`).all(agreement.id);
  const fields = JSON.parse(agreement.fields_json);
  const signersForPdf = signerRows.map((s) => ({
    ...s,
    contact: s.role === 'landlord' ? fields.landlordContact : (s.renter_id ? ((db.prepare('SELECT email FROM renters WHERE id = ?').get(s.renter_id) || {}).email || null) : null),
  }));

  const { buffer } = renderAgreementPdf({
    fields, bodyText: agreement.body_snapshot, signers: signersForPdf, property, isSample: !!property.is_sample,
    isFinal: true, statusLabel: 'COMPLETED', generatedAt: new Date().toISOString().slice(0, 10),
  });
  const documentHash = crypto.createHash('sha256').update(buffer).digest('hex');

  const destDir = path.join(UPLOADS_DIR, 'properties', String(property.id), 'lease-agreements');
  fs.mkdirSync(destDir, { recursive: true });
  const filename = `lease-agreement-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.pdf`;
  fs.writeFileSync(path.join(destDir, filename), buffer);

  db.prepare(`UPDATE lease_agreements SET status = 'completed', completed_at = datetime('now'), final_pdf_path = ?, document_hash = ? WHERE id = ?`)
    .run(filename, documentHash, agreement.id);
  logAgreementEvent(db, agreement.id, 'completed', 'system', null, { documentHash });

  const completed = db.prepare('SELECT * FROM lease_agreements WHERE id = ?').get(agreement.id);
  syncLeaseFromCompletedAgreement(db, completed, lease, fields);
  return completed;
}

/**
 * Synchronizes the agreed terms onto the real tenancy once every signature
 * is in. Every rule below exists because the spec calls it out explicitly:
 *   - never duplicate a lease: this UPDATEs the SAME leases row, never INSERTs.
 *   - never overwrite historical charges: rent only ever enters via a new,
 *     append-only lease_rent_history row (see chargeGenerator.js) — no
 *     existing charge or history row is ever touched.
 *   - never mark a deposit paid just because it's required: only
 *     deposit_required_cents is set here; deposit_held_cents is untouched.
 *   - never mark a future tenancy occupied before its start date: flipping
 *     status to 'active' is safe even for a future start date, because
 *     ensureChargesGenerated/ensureNextPeriodCharge only ever produce a
 *     charge for a period up through TODAY — see chargeGenerator.js.
 */
function syncLeaseFromCompletedAgreement(db, agreement, lease, fields) {
  const monthToMonth = !!fields.monthToMonth;
  const endDate = monthToMonth ? null : (fields.leaseEndDate || lease.end_date);
  const dueDay = Number(fields.rentDueDay) || lease.due_day;
  const graceDays = Number.isFinite(Number(fields.graceDays)) ? Number(fields.graceDays) : lease.late_after_days;
  const depositCents = Number.isFinite(safeCents(fields.securityDeposit)) ? safeCents(fields.securityDeposit) : lease.deposit_required_cents;

  if (lease.status === 'draft') {
    db.prepare(`
      UPDATE leases SET status = 'active', start_date = ?, end_date = ?, due_day = ?, late_after_days = ?, deposit_required_cents = ? WHERE id = ?
    `).run(fields.leaseStartDate || lease.start_date, endDate, dueDay, graceDays, depositCents, lease.id);
  } else {
    // An agreement completing against an already-active lease (a renewal or
    // amendment) updates only the agreed terms — never the tenancy's real,
    // historical start date or its active status.
    db.prepare(`UPDATE leases SET end_date = ?, due_day = ?, late_after_days = ?, deposit_required_cents = ? WHERE id = ?`)
      .run(endDate, dueDay, graceDays, depositCents, lease.id);
  }

  const rentCents = safeCents(fields.monthlyRent);
  if (Number.isFinite(rentCents) && rentCents > 0) {
    const effectiveDate = fields.leaseStartDate || lease.start_date;
    const alreadyRecorded = db.prepare('SELECT id FROM lease_rent_history WHERE lease_id = ? AND effective_date = ? AND rent_cents = ?')
      .get(lease.id, effectiveDate, rentCents);
    if (!alreadyRecorded) {
      db.prepare('INSERT INTO lease_rent_history (lease_id, rent_cents, effective_date) VALUES (?, ?, ?)').run(lease.id, rentCents, effectiveDate);
    }
  }

  logAudit(db, { actorType: 'system', actorId: null, action: 'lease_sync_from_agreement', entityType: 'lease', entityId: lease.id, after: { agreementId: agreement.id } });
}

// ---------------------------------------------------------------------------
// PDF rendering
// ---------------------------------------------------------------------------

const MARGIN = 50;
const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const CONTENT_BOTTOM = 60;
const BODY_WIDTH = PAGE_WIDTH - MARGIN * 2;

const STATUS_LABELS = {
  draft: 'DRAFT — not yet finalized',
  awaiting_landlord_signature: 'AWAITING LANDLORD SIGNATURE',
  awaiting_renter_signature: 'AWAITING TENANT SIGNATURE',
  partially_signed: 'PARTIALLY SIGNED',
  changes_requested: 'CHANGES REQUESTED',
  declined: 'DECLINED',
  voided: 'VOIDED',
  completed: 'COMPLETED',
  expired: 'EXPIRED',
};

/**
 * Pure render — takes plain data in, returns a PDF Buffer out. Used both for
 * an on-the-fly, never-saved "preview" at any point in the lifecycle (always
 * reflecting whatever has actually happened so far — blank lines for a
 * pending signer, filled ones for a signer who's already signed) and, with
 * isFinal, for the one-time completed document that completeAgreement()
 * writes to disk. Never touches the database or the filesystem itself.
 */
function renderAgreementPdf({ fields, bodyText, signers, property, isSample, isFinal, statusLabel, generatedAt }) {
  const doc = new PdfDocument();
  let page = doc.addPage();
  let y = PAGE_HEIGHT - 56;

  function footer(pg) {
    pg.line(MARGIN, 40, PAGE_WIDTH - MARGIN, 40);
    pg.text(MARGIN, 28, `Generated ${generatedAt} · Rental Portfolio Manager`, { size: 8 });
    if (isSample) pg.text(PAGE_WIDTH - MARGIN - 195, 28, 'SAMPLE DATA — for demonstration only', { size: 8, font: 'F2' });
  }
  function newPageIfNeeded(space = 14) {
    if (y - space < CONTENT_BOTTOM) {
      footer(page);
      page = doc.addPage();
      y = PAGE_HEIGHT - 56;
    }
  }
  function writeLines(lines, { size = 10, font = 'F1', gap = 13 } = {}) {
    for (const line of lines) {
      newPageIfNeeded(gap);
      if (line) page.text(MARGIN, y, line, { size, font });
      y -= gap;
    }
  }

  page.text(MARGIN, y, 'Residential Lease Agreement', { size: 18, font: 'F2' }); y -= 22;
  page.text(MARGIN, y, addressLine(property), { size: 11 }); y -= 16;
  page.text(MARGIN, y, `Status: ${statusLabel || ''}`, { size: 10, font: 'F2' }); y -= 20;

  if (!isFinal) {
    page.text(MARGIN, y, 'PREVIEW — this reflects the agreement as it stands right now and is not the final signed document.', { size: 9, font: 'F2' });
    y -= 18;
  }
  if (isSample) {
    page.text(MARGIN, y, 'Built from a SAMPLE template. Demonstration only — not legal advice, not reviewed for this jurisdiction.', { size: 9, font: 'F2' });
    y -= 18;
  }
  y -= 6;

  const paragraphs = String(bodyText || '').split('\n\n');
  for (const para of paragraphs) {
    const isHeading = /^\d+\.\s/.test(para.trim());
    const lines = wrapText(para.trim(), BODY_WIDTH, { size: 10, font: isHeading ? 'F2' : 'F1' });
    writeLines(lines, { size: 10, font: isHeading ? 'F2' : 'F1', gap: 13 });
    y -= 6;
  }

  newPageIfNeeded(30);
  y -= 10;
  page.line(MARGIN, y, PAGE_WIDTH - MARGIN, y); y -= 20;
  page.text(MARGIN, y, 'SIGNATURES', { size: 12, font: 'F2' }); y -= 18;

  for (const s of signers || []) {
    newPageIfNeeded(52);
    const roleLabel = s.role === 'landlord' ? 'Landlord' : (s.role === 'co_tenant' ? 'Co-Tenant' : 'Tenant');
    page.text(MARGIN, y, `${roleLabel}: ${s.display_name || s.displayName}`, { size: 10, font: 'F2' }); y -= 14;
    if (s.status === 'signed') {
      page.text(MARGIN + 12, y, `Signed: ${s.signature_text || s.signatureText}`, { size: 10 }); y -= 13;
      page.text(MARGIN + 12, y, `Date: ${formatDateTimeShort(s.signed_at || s.signedAt)}`, { size: 9 }); y -= 18;
    } else if (s.status === 'declined') {
      page.text(MARGIN + 12, y, `Declined: ${s.decline_message || s.declineMessage || ''}`, { size: 9, font: 'F2' }); y -= 18;
    } else {
      page.line(MARGIN + 12, y - 2, MARGIN + 220, y - 2); y -= 14;
      page.text(MARGIN + 12, y, 'Signature pending', { size: 9 }); y -= 16;
    }
  }

  if (isFinal) {
    newPageIfNeeded(30);
    y -= 10;
    page.line(MARGIN, y, PAGE_WIDTH - MARGIN, y); y -= 20;
    page.text(MARGIN, y, 'CERTIFICATE OF COMPLETION — SIGNING RECORD', { size: 12, font: 'F2' }); y -= 16;
    writeLines(wrapText(
      'This record lists every recipient and signing event for this agreement, each with a server-recorded timestamp. ' +
      'It was produced by this application\'s own built-in demo signing workflow (see the README) — it is not a certificate ' +
      'issued by a third-party e-signature provider.', BODY_WIDTH, { size: 9 }), { size: 9, gap: 12 });
    y -= 6;
    for (const s of signers || []) {
      newPageIfNeeded(28);
      const roleLabel = s.role === 'landlord' ? 'Landlord' : (s.role === 'co_tenant' ? 'Co-Tenant' : 'Tenant');
      page.text(MARGIN, y, `${roleLabel}: ${s.display_name || s.displayName}${s.contact ? ` <${s.contact}>` : ''}`, { size: 9, font: 'F2' }); y -= 12;
      const consented = s.consented_at || s.consentedAt;
      const signed = s.signed_at || s.signedAt;
      page.text(MARGIN + 12, y, consented ? `Consented to electronic signature: ${formatDateTimeShort(consented)}` : 'Consent: not recorded', { size: 8 }); y -= 11;
      page.text(MARGIN + 12, y, signed ? `Signed: ${formatDateTimeShort(signed)}` : 'Signed: not recorded', { size: 8 }); y -= 14;
    }
  }

  footer(page);
  return { buffer: doc.save() };
}

module.exports = {
  buildDefaultFields, toDisplayFields, validateFieldsForFinalize,
  getOwnedAgreementOr404, getRenterAgreementOr404, listAgreementsForLease, listAgreementsForRenter,
  getOrCreateDraftAgreement, updateDraftFields, finalizeAgreement,
  landlordSignAndSend, renterSign, renterDecline, renterRequestCorrection,
  voidAgreement, remindPendingSigners, recomputeAgreementStatus, completeAgreement,
  serializeSigner, serializeAgreement, getEventsForAgreement, logAgreementEvent,
  renderAgreementPdf, addressLine, STATUS_LABELS,
};

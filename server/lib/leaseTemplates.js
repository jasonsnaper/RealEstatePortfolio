// Reusable lease document templates (db.js's lease_templates table).
//
// A template's body_text is plain paragraph text with {{placeholder}}
// tokens (see PLACEHOLDERS below) standing in for the deal-specific terms —
// that's this app's "fillable fields" mechanism (see README for why: a
// coordinate-based visual field-placement designer over an arbitrary
// uploaded PDF/DOCX would need a PDF-parsing/rendering library, and this
// app has zero npm dependencies by design and no reachable npm registry in
// this sandbox — see server/lib/pdf.js's header). Signature fields are NOT
// placed inside the body text at all: every agreement gets a fixed,
// structured signature block (one line per required signer) appended after
// the body, generated from server/lib/leaseAgreements.js, not authored by
// the template. This is a deliberate scope simplification, disclosed in the
// README rather than hidden.
//
// Every owner gets their own copy of the one built-in sample template
// (ensureSampleTemplate, called lazily) rather than a single shared global
// row, purely so ownership stays uniform everywhere else in the code (every
// lease_templates row has a real owner_id and the normal
// "WHERE id=? AND owner_id=?" check works with no special case for a
// "global" template). Owners can freely look at, copy from, but never edit
// or delete the sample row itself — it's a fixed reference/demo, always
// available to fall back to.

const { apiError } = require('./router');

const PLACEHOLDERS = [
  { token: 'landlord_name', label: 'Landlord / legal entity name' },
  { token: 'landlord_contact', label: 'Landlord contact information' },
  { token: 'tenant_names', label: 'Tenant and co-tenant name(s)' },
  { token: 'property_address', label: 'Property address and unit' },
  { token: 'monthly_rent', label: 'Monthly rent' },
  { token: 'security_deposit', label: 'Security deposit' },
  { token: 'lease_start_date', label: 'Lease start / move-in date' },
  { token: 'lease_end_date', label: 'Lease end date (or "month-to-month")' },
  { token: 'rent_due_day', label: 'Rent due day' },
  { token: 'grace_period', label: 'Grace period / late terms' },
  { token: 'additional_occupants', label: 'Additional occupants' },
  { token: 'utilities_responsibilities', label: 'Utilities and responsibilities' },
  { token: 'additional_terms', label: 'Additional terms / addenda notes' },
];

// Deliberately generic and procedural rather than asserting specific
// numbers (notice periods, entry rules, etc.) that vary by jurisdiction —
// see the SAMPLE_DISCLAIMER clause and this app's standing rule against
// silently inventing legal clauses. This is demonstration boilerplate, not
// legal advice, and is never described as compliant with any specific
// jurisdiction's law.
const SAMPLE_DISCLAIMER =
  'SAMPLE TEMPLATE — FOR DEMONSTRATION ONLY. This text is generic, illustrative lease language. ' +
  'It has not been reviewed by an attorney, is not tailored to any jurisdiction, and is not a substitute for ' +
  'a lease prepared or reviewed by a qualified professional for the property\'s actual location. Replace it with ' +
  'your own approved lease template before using this for a real tenancy.';

const SAMPLE_BODY_TEXT = `${SAMPLE_DISCLAIMER}

1. PARTIES
This Residential Lease Agreement ("Agreement") is between {{landlord_name}} ("Landlord"), reachable at {{landlord_contact}}, and {{tenant_names}} ("Tenant").

2. PREMISES
Landlord leases to Tenant the residential property at {{property_address}} ("the Premises"), for use as a private residence only.

3. TERM
The lease term begins on {{lease_start_date}} and ends on {{lease_end_date}}. If either party wishes to end a month-to-month tenancy, notice should be given as required by the law of the Premises' location.

4. RENT
Tenant agrees to pay Landlord monthly rent of {{monthly_rent}}, due on day {{rent_due_day}} of each month. Late payment terms: {{grace_period}}.

5. SECURITY DEPOSIT
Tenant will pay a security deposit of {{security_deposit}} before move-in. The deposit will be handled, and returned or accounted for after move-out, as required by the law of the Premises' location.

6. OCCUPANTS
The Premises will be occupied by Tenant and the following additional occupants, if any: {{additional_occupants}}.

7. UTILITIES AND RESPONSIBILITIES
Responsibility for utilities and related services is as follows: {{utilities_responsibilities}}.

8. ADDITIONAL TERMS
{{additional_terms}}

9. QUIET ENJOYMENT AND ENTRY
Tenant is entitled to quiet enjoyment of the Premises. Landlord will provide advance notice before entering, consistent with the notice period required by the law of the Premises' location, except in a genuine emergency.

10. MAINTENANCE
Landlord is responsible for maintaining the Premises in a habitable condition as required by applicable law. Tenant agrees to promptly report needed repairs and to avoid causing damage beyond normal wear and tear.

11. GOVERNING LAW
This Agreement is governed by the law of the state or locality where the Premises is located. Nothing in this Agreement overrides a legal protection that applies to Tenant under that law.

By signing below, each party acknowledges they have read this entire Agreement, including any attachments or addenda, and agrees to its terms.`;

function ensureSampleTemplate(db, ownerId) {
  const existing = db.prepare('SELECT * FROM lease_templates WHERE owner_id = ? AND is_sample = 1').get(ownerId);
  if (existing) return existing;
  const result = db.prepare(`
    INSERT INTO lease_templates (owner_id, name, jurisdiction, body_text, is_sample) VALUES (?, ?, ?, ?, 1)
  `).run(ownerId, 'Standard Residential Lease (Sample)', 'Not jurisdiction-specific — sample only', SAMPLE_BODY_TEXT);
  return db.prepare('SELECT * FROM lease_templates WHERE id = ?').get(result.lastInsertRowid);
}

function listTemplatesForOwner(db, ownerId) {
  ensureSampleTemplate(db, ownerId);
  return db.prepare('SELECT * FROM lease_templates WHERE owner_id = ? ORDER BY is_sample DESC, name').all(ownerId);
}

function getOwnedTemplateOr404(db, ownerId, templateId) {
  const template = db.prepare('SELECT * FROM lease_templates WHERE id = ? AND owner_id = ?').get(templateId, ownerId);
  if (!template) throw apiError(404, 'Template not found');
  return template;
}

function createTemplate(db, ownerId, { name, jurisdiction, bodyText }) {
  if (!name || !name.trim()) throw apiError(400, 'Template name is required');
  if (!bodyText || !bodyText.trim()) throw apiError(400, 'Template text is required');
  const result = db.prepare(`
    INSERT INTO lease_templates (owner_id, name, jurisdiction, body_text, is_sample) VALUES (?, ?, ?, ?, 0)
  `).run(ownerId, name.trim(), jurisdiction || null, bodyText);
  return db.prepare('SELECT * FROM lease_templates WHERE id = ?').get(result.lastInsertRowid);
}

function updateTemplate(db, ownerId, templateId, { name, jurisdiction, bodyText }) {
  const template = getOwnedTemplateOr404(db, ownerId, templateId);
  if (template.is_sample) throw apiError(409, 'The built-in sample template cannot be edited — duplicate it to create your own editable copy.');
  db.prepare(`
    UPDATE lease_templates SET name = ?, jurisdiction = ?, body_text = ?, updated_at = datetime('now') WHERE id = ?
  `).run(
    name != null && name.trim() ? name.trim() : template.name,
    jurisdiction !== undefined ? jurisdiction : template.jurisdiction,
    bodyText != null && bodyText.trim() ? bodyText : template.body_text,
    template.id
  );
  return db.prepare('SELECT * FROM lease_templates WHERE id = ?').get(template.id);
}

function deleteTemplate(db, ownerId, templateId) {
  const template = getOwnedTemplateOr404(db, ownerId, templateId);
  if (template.is_sample) throw apiError(409, 'The built-in sample template cannot be deleted.');
  const inUse = db.prepare('SELECT id FROM lease_agreements WHERE template_id = ? LIMIT 1').get(template.id);
  if (inUse) throw apiError(409, 'This template is used by an existing lease agreement and cannot be deleted.');
  db.prepare('DELETE FROM lease_templates WHERE id = ?').run(template.id);
}

function duplicateTemplate(db, ownerId, templateId, { name } = {}) {
  const template = getOwnedTemplateOr404(db, ownerId, templateId);
  const result = db.prepare(`
    INSERT INTO lease_templates (owner_id, name, jurisdiction, body_text, is_sample) VALUES (?, ?, ?, ?, 0)
  `).run(ownerId, (name && name.trim()) || `${template.name} (copy)`, template.jurisdiction, template.body_text);
  return db.prepare('SELECT * FROM lease_templates WHERE id = ?').get(result.lastInsertRowid);
}

/**
 * Substitutes every {{token}} in bodyText with the matching value from
 * `fields` (see leaseAgreements.js's field shape). A token with no matching
 * field, or a typo'd token that isn't one of PLACEHOLDERS at all, is left
 * verbatim rather than silently blanked — a visibly-wrong placeholder in the
 * preview is a signal something needs fixing, whereas a silently blank line
 * could pass for an intentionally empty clause.
 */
function applyTemplate(bodyText, fields) {
  return String(bodyText || '').replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (match, token) => {
    const value = fields ? fields[toCamel(token)] : undefined;
    return value !== undefined && value !== null && String(value).trim() !== '' ? String(value) : match;
  });
}

function toCamel(snake) {
  return snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function serializeTemplate(t) {
  return {
    id: t.id,
    name: t.name,
    jurisdiction: t.jurisdiction,
    bodyText: t.body_text,
    isSample: !!t.is_sample,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
  };
}

module.exports = {
  PLACEHOLDERS, SAMPLE_DISCLAIMER,
  ensureSampleTemplate, listTemplatesForOwner, getOwnedTemplateOr404,
  createTemplate, updateTemplate, deleteTemplate, duplicateTemplate,
  applyTemplate, serializeTemplate,
};

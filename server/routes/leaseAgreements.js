const { apiError, sendJson } = require('../lib/router');
const { requireAuth, logAudit } = require('../lib/helpers');
const { requireRenterAuth } = require('../lib/renterAuth');
const { getRenterLeaseOr404 } = require('../lib/renterAccess');
const { applyTemplate } = require('../lib/leaseTemplates');
const {
  getOwnedAgreementOr404, getRenterAgreementOr404, listAgreementsForLease, listAgreementsForRenter,
  getOrCreateDraftAgreement, updateDraftFields, finalizeAgreement,
  landlordSignAndSend, renterSign, renterDecline, renterRequestCorrection,
  voidAgreement, remindPendingSigners, serializeAgreement, getEventsForAgreement,
  toDisplayFields, renderAgreementPdf, STATUS_LABELS,
} = require('../lib/leaseAgreements');

// Same three-line pattern as every other route file in this app (see
// server/lib/statements.js's header comment on why this is duplicated
// rather than shared) — confirms the lease belongs to this owner.
function getOwnedLeaseOr404(db, ownerId, leaseId) {
  const lease = db.prepare(`
    SELECT l.*, p.owner_id FROM leases l JOIN properties p ON p.id = l.property_id WHERE l.id = ? AND p.owner_id = ?
  `).get(leaseId, ownerId);
  if (!lease) throw apiError(404, 'Lease not found');
  return lease;
}

function getPropertyForLease(db, leaseId) {
  return db.prepare(`SELECT p.* FROM leases l JOIN properties p ON p.id = l.property_id WHERE l.id = ?`).get(leaseId);
}

function sendPdf(res, buffer, filename) {
  res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': buffer.length, 'Content-Disposition': `inline; filename="${filename}"` });
  res.end(buffer);
}

/** Renders the agreement exactly as it stands right now — a live, never-persisted PDF, used for "preview"/"download for review" at any point before completion. Once completed, callers should use the persisted final_pdf_path (served as a normal upload) instead of re-rendering. */
function renderLivePreview(db, agreement) {
  const lease = db.prepare('SELECT * FROM leases WHERE id = ?').get(agreement.lease_id);
  const property = db.prepare('SELECT * FROM properties WHERE id = ?').get(lease.property_id);
  const fields = JSON.parse(agreement.fields_json);
  const signerRows = db.prepare(`SELECT * FROM lease_signers WHERE agreement_id = ? ORDER BY (role = 'landlord') DESC, id`).all(agreement.id);
  const signers = signerRows.map((s) => ({
    ...s,
    contact: s.role === 'landlord' ? fields.landlordContact : (s.renter_id ? ((db.prepare('SELECT email FROM renters WHERE id = ?').get(s.renter_id) || {}).email || null) : null),
  }));
  let bodyText = agreement.body_snapshot;
  if (!bodyText) {
    const template = db.prepare('SELECT * FROM lease_templates WHERE id = ?').get(agreement.template_id);
    bodyText = applyTemplate(template.body_text, toDisplayFields(fields));
  }
  const { buffer } = renderAgreementPdf({
    fields, bodyText, signers, property, isSample: !!property.is_sample,
    isFinal: agreement.status === 'completed', statusLabel: STATUS_LABELS[agreement.status] || agreement.status,
    generatedAt: new Date().toISOString().slice(0, 10),
  });
  return buffer;
}

function registerLeaseAgreementRoutes(router, { db }) {
  // -------------------------------------------------------------- Owner --
  router.get('/api/leases/:id/agreements', async (req, res) => {
    const owner = requireAuth(db, req);
    const lease = getOwnedLeaseOr404(db, owner.id, req.params.id);
    sendJson(res, 200, listAgreementsForLease(db, lease.id).map((a) => serializeAgreement(db, a)));
  });

  // Idempotent by design (getOrCreateDraftAgreement never makes a duplicate
  // open agreement) — this is what backs the prominent "Send Lease
  // Agreement" button; clicking it again just re-opens the same in-progress
  // draft/sent agreement rather than starting over.
  router.post('/api/leases/:id/agreements', async (req, res) => {
    const owner = requireAuth(db, req);
    const lease = getOwnedLeaseOr404(db, owner.id, req.params.id);
    const property = getPropertyForLease(db, lease.id);
    const agreement = getOrCreateDraftAgreement(db, { lease, property, owner, templateId: req.body ? req.body.templateId : null });
    sendJson(res, 201, serializeAgreement(db, agreement));
  });

  router.get('/api/lease-agreements/:id', async (req, res) => {
    const owner = requireAuth(db, req);
    const agreement = getOwnedAgreementOr404(db, owner.id, req.params.id);
    sendJson(res, 200, serializeAgreement(db, agreement));
  });

  router.put('/api/lease-agreements/:id', async (req, res) => {
    const owner = requireAuth(db, req);
    const agreement = getOwnedAgreementOr404(db, owner.id, req.params.id);
    const updated = updateDraftFields(db, agreement, owner, req.body || {});
    sendJson(res, 200, serializeAgreement(db, updated));
  });

  router.post('/api/lease-agreements/:id/finalize', async (req, res) => {
    const owner = requireAuth(db, req);
    const agreement = getOwnedAgreementOr404(db, owner.id, req.params.id);
    const updated = finalizeAgreement(db, agreement, owner);
    sendJson(res, 200, serializeAgreement(db, updated));
  });

  // Landlord review + explicit consent + sign + send, as one atomic action —
  // see leaseAgreements.js's landlordSignAndSend for why this is a single
  // server call rather than separate steps a client could interrupt partway.
  router.post('/api/lease-agreements/:id/sign', async (req, res) => {
    const owner = requireAuth(db, req);
    const agreement = getOwnedAgreementOr404(db, owner.id, req.params.id);
    const updated = landlordSignAndSend(db, agreement, owner, req.body || {});
    sendJson(res, 200, serializeAgreement(db, updated));
  });

  router.post('/api/lease-agreements/:id/void', async (req, res) => {
    const owner = requireAuth(db, req);
    const agreement = getOwnedAgreementOr404(db, owner.id, req.params.id);
    const updated = voidAgreement(db, agreement, owner, req.body || {});
    sendJson(res, 200, serializeAgreement(db, updated));
  });

  router.post('/api/lease-agreements/:id/remind', async (req, res) => {
    const owner = requireAuth(db, req);
    const agreement = getOwnedAgreementOr404(db, owner.id, req.params.id);
    const count = remindPendingSigners(db, agreement, owner);
    sendJson(res, 200, { ok: true, remindedCount: count });
  });

  router.get('/api/lease-agreements/:id/events', async (req, res) => {
    const owner = requireAuth(db, req);
    const agreement = getOwnedAgreementOr404(db, owner.id, req.params.id);
    sendJson(res, 200, getEventsForAgreement(db, agreement.id));
  });

  router.get('/api/lease-agreements/:id/preview.pdf', async (req, res) => {
    const owner = requireAuth(db, req);
    const agreement = getOwnedAgreementOr404(db, owner.id, req.params.id);
    sendPdf(res, renderLivePreview(db, agreement), `lease-agreement-${agreement.id}-preview.pdf`);
  });

  // Same honest "no email provider configured" stand-in as every other
  // email action in this app (see statements.js's /email route) — only
  // meaningful once the document is actually finished; a still-in-progress
  // agreement should be shared via the portal itself, not emailed as if final.
  router.post('/api/lease-agreements/:id/email', async (req, res) => {
    const owner = requireAuth(db, req);
    const agreement = getOwnedAgreementOr404(db, owner.id, req.params.id);
    if (agreement.status !== 'completed') throw apiError(409, 'This agreement is not completed yet — nothing final to email.');
    const lease = db.prepare('SELECT * FROM leases WHERE id = ?').get(agreement.lease_id);
    const recipients = db.prepare(`
      SELECT DISTINCT r.email FROM lease_renters lr JOIN renters r ON r.id = lr.renter_id WHERE lr.lease_id = ? AND r.email IS NOT NULL
    `).all(lease.id).map((r) => r.email);
    const to = req.body.to || recipients[0];
    if (!to) throw apiError(400, 'No email address on file for this tenant — pass "to" explicitly.');
    console.log(`\n[Lease agreement] Completed agreement #${agreement.id} would be emailed to ${to}. No email provider is configured — see README.\n`);
    logAudit(db, { actorType: 'owner', actorId: owner.id, action: 'email_lease_agreement', entityType: 'lease_agreement', entityId: agreement.id, after: { to } });
    sendJson(res, 200, { ok: true, simulated: true, to });
  });

  // ------------------------------------------------------------- Renter --
  router.get('/api/renter/leases/:id/agreements', async (req, res) => {
    const renter = requireRenterAuth(db, req);
    const lease = getRenterLeaseOr404(db, renter.id, req.params.id);
    sendJson(res, 200, listAgreementsForRenter(db, renter.id, lease.id).map((a) => serializeAgreement(db, a)));
  });

  router.get('/api/renter/agreements/:id', async (req, res) => {
    const renter = requireRenterAuth(db, req);
    const agreement = getRenterAgreementOr404(db, renter.id, req.params.id);
    sendJson(res, 200, serializeAgreement(db, agreement));
  });

  router.get('/api/renter/agreements/:id/events', async (req, res) => {
    const renter = requireRenterAuth(db, req);
    const agreement = getRenterAgreementOr404(db, renter.id, req.params.id);
    sendJson(res, 200, getEventsForAgreement(db, agreement.id));
  });

  router.get('/api/renter/agreements/:id/preview.pdf', async (req, res) => {
    const renter = requireRenterAuth(db, req);
    const agreement = getRenterAgreementOr404(db, renter.id, req.params.id);
    sendPdf(res, renderLivePreview(db, agreement), `lease-agreement-${agreement.id}.pdf`);
  });

  router.post('/api/renter/agreements/:id/sign', async (req, res) => {
    const renter = requireRenterAuth(db, req);
    const agreement = getRenterAgreementOr404(db, renter.id, req.params.id);
    const updated = renterSign(db, agreement, renter, req.body || {});
    sendJson(res, 200, serializeAgreement(db, updated));
  });

  router.post('/api/renter/agreements/:id/decline', async (req, res) => {
    const renter = requireRenterAuth(db, req);
    const agreement = getRenterAgreementOr404(db, renter.id, req.params.id);
    const updated = renterDecline(db, agreement, renter, req.body || {});
    sendJson(res, 200, serializeAgreement(db, updated));
  });

  router.post('/api/renter/agreements/:id/request-correction', async (req, res) => {
    const renter = requireRenterAuth(db, req);
    const agreement = getRenterAgreementOr404(db, renter.id, req.params.id);
    const updated = renterRequestCorrection(db, agreement, renter, req.body || {});
    sendJson(res, 200, serializeAgreement(db, updated));
  });
}

module.exports = { registerLeaseAgreementRoutes };

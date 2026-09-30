// Shared lease-invitation / lease-agreement UI, loaded by BOTH index.html
// (owner dashboard + property page) and renter.html (renter portal) — the
// consent+typed-signature ceremony and the document-review layout are
// nearly identical for a landlord and a tenant, so this lives in one place
// rather than two near-duplicate copies. Nothing here assumes which page
// it's running on; each function is only ever called from the page that
// actually has the DOM it touches.

const LeaseAgreementUI = (function () {
  const STATUS_BADGE = {
    draft: 'warn', awaiting_landlord_signature: 'warn', awaiting_renter_signature: 'warn',
    partially_signed: 'warn', changes_requested: 'warn', declined: 'sample', voided: 'sample',
    completed: 'shared', expired: 'sample',
  };
  function statusBadge(agreement) {
    return '<span class="badge ' + (STATUS_BADGE[agreement.status] || 'warn') + '">' + escapeHtml(agreement.statusLabel || agreement.status) + '</span>';
  }

  // A local, click-and-run action helper — the same shape as components.js's
  // wireAction, but for a button living INSIDE a modal that should show its
  // error inline (showFormError) rather than as a toast, and that should NOT
  // auto-close the modal (see wireSave's doc comment on why that would be
  // wrong for a "Save draft"/"Preview" button that's meant to leave the form open).
  function formButtonAction(modal, btn, busyLabel, fn) {
    btn.addEventListener('click', async () => {
      if (modal.dataset.busyAction === '1') return;
      modal.dataset.busyAction = '1';
      clearFormError(modal);
      setButtonBusy(btn, true, busyLabel);
      try {
        await fn();
      } catch (err) {
        showFormError(modal, describeApiError(err));
      } finally {
        modal.dataset.busyAction = '0';
        setButtonBusy(btn, false);
      }
    });
  }

  /** A small "type a message and submit" modal — used for decline / request-correction, which both need a required explanatory message rather than a bare confirm(). */
  function openMessageModal({ title, label, submitLabel, danger }, onSubmit) {
    const modal = Modal.open(
      '<h2>' + escapeHtml(title) + '</h2>' +
      '<form id="la-msg-form">' +
        '<div class="field"><label>' + escapeHtml(label) + '</label><textarea name="message" rows="3" required></textarea></div>' +
        '<div id="la-msg-error"></div>' +
        '<div class="modal-actions"><button type="button" class="btn" data-act="cancel">Cancel</button>' +
          '<button type="submit" class="btn' + (danger ? ' danger' : ' primary') + '">' + escapeHtml(submitLabel) + '</button></div>' +
      '</form>'
    );
    modal.querySelector('[data-act="cancel"]').addEventListener('click', Modal.close);
    const form = modal.querySelector('#la-msg-form');
    wireSave(form, async () => { await onSubmit(formData(form).message); }, { savedMessage: 'Sent.' });
  }

  // ---------------------------------------------------------------------------
  // Invite / assign (used from the dashboard, and from the property page's
  // "no lease yet" empty state)
  // ---------------------------------------------------------------------------

  /** Same copy-link pattern as property.js's per-lease invite modal — no email/SMS provider is connected, so the owner copies and sends this themselves. */
  function renderInviteLinkModal(renter, link) {
    const modal = Modal.open(
      '<h2>Invite ' + escapeHtml(renter.name) + '</h2>' +
      '<p class="field-hint">Share this secure link so they can create their portal account. It expires in ' + link.expiresInDays + ' days — their account and access will persist regardless of that. Until you assign them to a property, they will appear under "Unassigned Renters".</p>' +
      '<div class="field"><input readonly value="' + escapeHtml(link.url) + '" onclick="this.select()"></div>' +
      '<div class="modal-actions"><button type="button" class="btn" id="la-copy-invite">Copy link</button><button type="button" class="btn primary" data-act="close">Done</button></div>'
    );
    modal.querySelector('[data-act="close"]').addEventListener('click', () => Modal.close(true));
    modal.querySelector('#la-copy-invite').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(link.url); Toast.show('Link copied.', 'success'); }
      catch (e) { Toast.show('Could not copy automatically — select and copy the link manually.', 'error'); }
    });
  }

  /** The generic (lease-less) "Invite Renter" action — dashboard.js. */
  function openInviteRenterModal(onChange) {
    const modal = Modal.open(
      '<h2>Invite a renter</h2>' +
      '<p class="field-hint">They can open the link, create their account, and will show up under "Unassigned Renters" until you assign them to a property.</p>' +
      '<form id="la-invite-form">' +
        '<div class="field"><label>Name <span class="field-hint">(optional — they can set this themselves)</span></label><input name="name"></div>' +
        '<div class="field"><label>Email</label><input name="email" type="email" required><span class="field-hint">Required — this is also how they sign in.</span></div>' +
        '<div class="field"><label>Phone <span class="field-hint">(optional)</span></label><input name="phone"></div>' +
        '<div class="modal-actions"><button type="button" class="btn" data-act="cancel">Cancel</button><button type="submit" class="btn primary">Generate invite link</button></div>' +
      '</form>'
    );
    modal.querySelector('[data-act="cancel"]').addEventListener('click', Modal.close);
    const form = modal.querySelector('#la-invite-form');
    // NOT wireSave: its onSave-then-auto-close would fire AFTER this callback
    // already swaps in the invite-link modal, closing that new modal right
    // back out from under the owner instead of the form it actually replaced
    // (see formButtonAction's doc comment above for the same reasoning).
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = qs('button[type="submit"]', form);
      if (modal.dataset.saving === '1') return;
      modal.dataset.saving = '1';
      clearFormError(modal);
      setButtonBusy(btn, true, 'Generating…');
      try {
        const link = await Api.post('/api/renters/invite', formData(form));
        await Modal.close(true);
        renderInviteLinkModal(link.renter, link);
        if (onChange) onChange();
      } catch (err) {
        modal.dataset.saving = '0';
        setButtonBusy(btn, false);
        showFormError(modal, describeApiError(err));
      }
    });
  }

  /**
   * Assigns an unassigned renter to a property as a new draft ("Lease
   * Pending") tenancy. `renter` is required; `properties` is the list to pick
   * from (pass a single-item array + lockedPropertyId to pre-select and lock
   * it, as property.js does when the property is already known).
   */
  function openAssignRenterModal({ renter, properties, lockedPropertyId, onChange }) {
    const locked = lockedPropertyId && properties.length === 1;
    const modal = Modal.open(
      '<h2>Assign ' + escapeHtml(renter.name) + ' to a property</h2>' +
      '<form id="la-assign-form">' +
        '<div class="field"><label>Property</label>' +
          (locked
            ? '<input type="text" value="' + escapeHtml(properties[0].name) + '" disabled><input type="hidden" name="propertyId" value="' + properties[0].id + '">'
            : '<select name="propertyId" required>' + properties.map((p) => '<option value="' + p.id + '">' + escapeHtml(p.name) + '</option>').join('') + '</select>') +
        '</div>' +
        '<div class="field"><label>Proposed lease start / move-in date</label><input type="date" name="startDate" required value="' + todayStr() + '"></div>' +
        '<p class="field-hint">This creates a pending tenancy — nothing is billed and no lease is active until a lease agreement is prepared and signed by both sides.</p>' +
        '<div class="modal-actions"><button type="button" class="btn" data-act="cancel">Cancel</button><button type="submit" class="btn primary">Assign</button></div>' +
      '</form>'
    );
    modal.querySelector('[data-act="cancel"]').addEventListener('click', Modal.close);
    const form = modal.querySelector('#la-assign-form');
    wireSave(form, async () => {
      const lease = await Api.post('/api/renters/' + renter.id + '/assign', formData(form));
      if (onChange) onChange(lease);
    }, { savedMessage: 'Renter assigned — lease pending.' });
  }

  // ---------------------------------------------------------------------------
  // Dashboard: "Unassigned Renters" panel
  // ---------------------------------------------------------------------------

  function unassignedPanelHtml(renters) {
    if (!renters || renters.length === 0) return '';
    return (
      '<div class="card panel" style="margin-bottom:22px;" id="unassigned-renters-panel">' +
        '<div class="section-heading"><h2>Unassigned renters</h2></div>' +
        '<p class="field-hint" style="margin-top:-6px;">Accepted an invitation but not yet on a lease.</p>' +
        renters.map((r) => (
          '<div class="list-row">' +
            '<span>' + escapeHtml(r.name) + (r.email ? ' <span class="field-hint">' + escapeHtml(r.email) + '</span>' : '') + '</span>' +
            '<button class="btn small" data-assign-renter="' + r.id + '">Assign to property</button>' +
          '</div>'
        )).join('') +
      '</div>'
    );
  }

  function wireUnassignedPanel(root, renters, onChange) {
    const panel = qs('#unassigned-renters-panel', root);
    if (!panel) return;
    qsa('[data-assign-renter]', panel).forEach((btn) => btn.addEventListener('click', async () => {
      const renter = renters.find((r) => String(r.id) === btn.dataset.assignRenter);
      let properties;
      try { properties = await Api.get('/api/properties'); } catch (err) { Toast.show(describeApiError(err), 'error'); return; }
      if (properties.length === 0) { Toast.show('Add a property first.', 'error'); return; }
      openAssignRenterModal({ renter, properties, onChange: () => onChange() });
    }));
  }

  // ---------------------------------------------------------------------------
  // Owner: property page — the draft ("Lease Pending") tenancy's agreement area
  // ---------------------------------------------------------------------------

  async function renderOwnerLeaseSection(container, property, lease, onChange) {
    let agreements;
    try { agreements = await Api.get('/api/leases/' + lease.id + '/agreements'); } catch (err) {
      container.innerHTML = '<div class="banner error">' + escapeHtml(describeApiError(err)) + '</div>';
      return;
    }
    const current = agreements[0] || null;
    container.innerHTML = ownerSectionHtml(current);
    wireOwnerSection(container, property, lease, current, onChange);
  }

  function signerLineHtml(s) {
    const roleLabel = s.role === 'landlord' ? 'Landlord' : (s.role === 'co_tenant' ? 'Co-Tenant' : 'Tenant');
    let statusText;
    if (s.status === 'signed') statusText = 'Signed ' + formatDateTime(s.signedAt);
    else if (s.status === 'declined') statusText = 'Declined: ' + escapeHtml(s.declineMessage || '');
    else statusText = 'Pending';
    return '<div class="list-row"><span>' + roleLabel + ': ' + escapeHtml(s.displayName) + '</span><span class="field-hint">' + statusText + '</span></div>';
  }

  function ownerSectionHtml(agreement) {
    if (!agreement) {
      return (
        '<div class="card panel" style="margin:18px 0;">' +
          '<div class="section-heading"><h3 style="margin:0;">Lease agreement</h3></div>' +
          '<p class="field-hint">Nothing prepared yet. Sending a lease agreement opens a preparation workflow — it is never sent unfinished.</p>' +
          '<button class="btn primary" id="la-send-btn">Send Lease Agreement</button>' +
        '</div>'
      );
    }
    if (agreement.status === 'draft') {
      return (
        '<div class="card panel" style="margin:18px 0;">' +
          '<div class="section-heading"><h3 style="margin:0;">Lease agreement</h3>' + statusBadge(agreement) + '</div>' +
          '<p class="field-hint">A draft is in progress but hasn’t been sent yet.</p>' +
          '<div class="btn-row"><button class="btn primary" id="la-continue-btn">Continue preparing</button>' +
            '<button class="btn small danger" id="la-void-btn">Discard draft</button></div>' +
        '</div>'
      );
    }
    if (agreement.status === 'completed') {
      return (
        '<div class="card panel" style="margin:18px 0;">' +
          '<div class="section-heading"><h3 style="margin:0;">Lease agreement</h3>' + statusBadge(agreement) + '</div>' +
          '<p class="field-hint">Signed ' + formatDateTime(agreement.completedAt) + '. Document hash (integrity check): <code>' + escapeHtml((agreement.documentHash || '').slice(0, 20)) + '…</code></p>' +
          '<div class="btn-row">' +
            '<a class="btn small" href="' + agreement.finalPdfUrl + '" target="_blank" rel="noopener">Download signed PDF</a>' +
            '<button class="btn small" id="la-email-btn">Email to tenant</button>' +
            '<button class="btn small" id="la-audit-btn">Signing record</button>' +
            '<button class="btn small" id="la-amend-btn">Start a new agreement</button>' +
          '</div>' +
        '</div>'
      );
    }
    // awaiting_renter_signature | partially_signed | changes_requested | declined | voided | expired
    const noteHtml = agreement.status === 'changes_requested'
      ? '<div class="banner warn">Tenant requested a correction: “' + escapeHtml(agreement.correctionRequest || '') + '”. Void this and start a corrected version.</div>'
      : agreement.status === 'declined'
        ? '<div class="banner error">Declined: “' + escapeHtml(agreement.declineReason || '') + '”. Void this and start a new agreement.</div>'
        : '';
    const canRemind = agreement.status === 'awaiting_renter_signature' || agreement.status === 'partially_signed';
    return (
      '<div class="card panel" style="margin:18px 0;">' +
        '<div class="section-heading"><h3 style="margin:0;">Lease agreement</h3>' + statusBadge(agreement) + '</div>' +
        noteHtml +
        agreement.signers.map(signerLineHtml).join('') +
        '<div class="btn-row" style="margin-top:12px;">' +
          '<button class="btn small" id="la-view-btn">View document</button>' +
          (canRemind ? '<button class="btn small" id="la-remind-btn">Remind</button>' : '') +
          '<button class="btn small" id="la-audit-btn">Signing record</button>' +
          '<button class="btn small danger" id="la-void-btn">Void</button>' +
        '</div>' +
      '</div>'
    );
  }

  function wireOwnerSection(container, property, lease, agreement, onChange) {
    const sendBtn = qs('#la-send-btn', container);
    if (sendBtn) sendBtn.addEventListener('click', () => startOrContinueAgreement(property, lease, onChange));
    const continueBtn = qs('#la-continue-btn', container);
    if (continueBtn) continueBtn.addEventListener('click', () => startOrContinueAgreement(property, lease, onChange));
    const viewBtn = qs('#la-view-btn', container);
    if (viewBtn) viewBtn.addEventListener('click', () => window.open('/api/lease-agreements/' + agreement.id + '/preview.pdf', '_blank'));
    const remindBtn = qs('#la-remind-btn', container);
    if (remindBtn) wireAction(remindBtn, async () => {
      const result = await Api.post('/api/lease-agreements/' + agreement.id + '/remind', {});
      Toast.show('Reminded ' + result.remindedCount + ' pending signer(s) (logged to the server console — no email provider configured).', 'success');
    });
    const voidBtn = qs('#la-void-btn', container);
    if (voidBtn) wireAction(voidBtn, async () => {
      if (!(await confirmDialog('Void this lease agreement? You can start a fresh one afterward, carrying the same details forward to edit.', 'Void'))) return;
      await Api.post('/api/lease-agreements/' + agreement.id + '/void', {});
      Toast.show('Agreement voided.', 'success');
      onChange();
    });
    const amendBtn = qs('#la-amend-btn', container);
    if (amendBtn) amendBtn.addEventListener('click', () => startOrContinueAgreement(property, lease, onChange));
    const emailBtn = qs('#la-email-btn', container);
    if (emailBtn) wireAction(emailBtn, async () => {
      const result = await Api.post('/api/lease-agreements/' + agreement.id + '/email', {});
      Toast.show('Lease "emailed" (simulated) to ' + result.to + ' — no real email provider is connected yet, see the README.', 'success');
    });
    const auditBtn = qs('#la-audit-btn', container);
    if (auditBtn) auditBtn.addEventListener('click', () => openAuditModal(agreement.id, false));
  }

  /** Fetches or creates the lease's current draft, and the owner's templates, then opens the prep form. Also handles jumping straight to the sign step if the draft is already finalized (e.g. re-opened after a page refresh). */
  async function startOrContinueAgreement(property, lease, onChange) {
    let agreement, templates;
    try {
      [agreement, templates] = await Promise.all([
        Api.post('/api/leases/' + lease.id + '/agreements', {}),
        Api.get('/api/lease-templates'),
      ]);
    } catch (err) {
      Toast.show(describeApiError(err), 'error');
      return;
    }
    if (agreement.status === 'draft') openPrepModal(agreement, templates, onChange);
    else openOwnerSignModal(agreement, onChange);
  }

  function prepFormHtml(agreement, templates) {
    const f = agreement.fields;
    const selectedTemplate = templates.find((t) => t.id === agreement.templateId);
    return (
      '<h2>Prepare lease agreement</h2>' +
      '<form id="la-prep-form">' +
        '<div class="field"><label>Template</label>' +
          '<select name="templateId">' +
            templates.map((t) => '<option value="' + t.id + '"' + (t.id === agreement.templateId ? ' selected' : '') + '>' + escapeHtml(t.name) + (t.isSample ? ' (sample)' : '') + (t.jurisdiction ? ' — ' + escapeHtml(t.jurisdiction) : '') + '</option>').join('') +
          '</select>' +
          '<button type="button" class="btn small" id="la-manage-templates-btn" style="margin-top:8px;">Manage templates</button>' +
        '</div>' +
        (selectedTemplate && selectedTemplate.isSample
          ? '<div class="banner warn">Built from the built-in SAMPLE template — demonstration only, not legal advice, not reviewed for any jurisdiction. Use “Manage templates” to create your own before using this for a real tenancy.</div>'
          : '') +
        '<h3 style="font-size:15px;margin:18px 0 8px;">Parties</h3>' +
        '<div class="field-row">' +
          '<div class="field"><label>Landlord / legal entity name</label><input name="landlordName" required value="' + escapeHtml(f.landlordName || '') + '"></div>' +
          '<div class="field"><label>Landlord contact info</label><input name="landlordContact" required value="' + escapeHtml(f.landlordContact || '') + '"></div>' +
        '</div>' +
        '<p class="field-hint">Tenant(s): ' + (f.tenants && f.tenants.length ? f.tenants.map((t) => escapeHtml(t.name) + (t.role === 'co_renter' ? ' (co-tenant)' : '')).join(', ') : 'none yet') + ' — add or remove renters from the Renters section below, then reopen this to refresh the signer list.</p>' +
        '<h3 style="font-size:15px;margin:18px 0 8px;">Property &amp; term</h3>' +
        '<div class="field"><label>Property address</label><input name="propertyAddress" required value="' + escapeHtml(f.propertyAddress || '') + '"></div>' +
        '<div class="field-row">' +
          '<div class="field"><label>Lease start / move-in date</label><input type="date" name="leaseStartDate" required value="' + escapeHtml(f.leaseStartDate || '') + '"></div>' +
          '<div class="field"><label>Lease end date</label><input type="date" name="leaseEndDate" value="' + escapeHtml(f.leaseEndDate || '') + '"' + (f.monthToMonth ? ' disabled' : '') + '></div>' +
        '</div>' +
        '<div class="checkbox-field"><input type="checkbox" name="monthToMonth" id="la-mtm"' + (f.monthToMonth ? ' checked' : '') + '><label for="la-mtm">Month-to-month (no fixed end date)</label></div>' +
        '<h3 style="font-size:15px;margin:18px 0 8px;">Rent &amp; deposit</h3>' +
        '<div class="field-row">' +
          '<div class="field"><label>Monthly rent ($)</label><input name="monthlyRent" required placeholder="0.00" value="' + escapeHtml(f.monthlyRent || '') + '"></div>' +
          '<div class="field"><label>Security deposit ($)</label><input name="securityDeposit" required placeholder="0.00" value="' + escapeHtml(f.securityDeposit != null ? f.securityDeposit : '') + '"></div>' +
          '<div class="field"><label>Rent due day</label><input type="number" min="1" max="31" name="rentDueDay" required value="' + (f.rentDueDay || 1) + '"></div>' +
        '</div>' +
        '<div class="field"><label>Grace period / late terms</label><textarea name="gracePeriod" rows="2" required>' + escapeHtml(f.gracePeriod || '') + '</textarea></div>' +
        '<h3 style="font-size:15px;margin:18px 0 8px;">Occupants &amp; utilities</h3>' +
        '<div class="field"><label>Additional occupants</label><textarea name="additionalOccupants" rows="2" placeholder="None">' + escapeHtml(f.additionalOccupants || '') + '</textarea></div>' +
        '<div class="field"><label>Utilities and responsibilities</label><textarea name="utilitiesResponsibilities" rows="2" required placeholder="e.g. Tenant pays electric and internet; Landlord pays water, sewer, trash.">' + escapeHtml(f.utilitiesResponsibilities || '') + '</textarea></div>' +
        '<h3 style="font-size:15px;margin:18px 0 8px;">Additional terms / addenda</h3>' +
        '<textarea name="additionalTerms" rows="3" placeholder="None">' + escapeHtml(f.additionalTerms || '') + '</textarea>' +
        '<div id="la-prep-error"></div>' +
        '<div class="modal-actions">' +
          '<button type="button" class="btn" data-act="cancel">Close</button>' +
          '<button type="button" class="btn" data-act="preview">Preview PDF</button>' +
          '<button type="button" class="btn" data-act="save">Save draft</button>' +
          '<button type="submit" class="btn primary">Finalize &amp; continue to signing</button>' +
        '</div>' +
      '</form>'
    );
  }

  function readPrepFields(form) {
    const d = formData(form);
    return {
      landlordName: d.landlordName, landlordContact: d.landlordContact, propertyAddress: d.propertyAddress,
      leaseStartDate: d.leaseStartDate, leaseEndDate: d.monthToMonth ? '' : d.leaseEndDate, monthToMonth: !!d.monthToMonth,
      monthlyRent: d.monthlyRent, securityDeposit: d.securityDeposit, rentDueDay: Number(d.rentDueDay) || 1,
      gracePeriod: d.gracePeriod, additionalOccupants: d.additionalOccupants, utilitiesResponsibilities: d.utilitiesResponsibilities,
      additionalTerms: d.additionalTerms,
    };
  }

  function openPrepModal(agreement, templates, onChange) {
    const modal = Modal.open(prepFormHtml(agreement, templates));
    const form = modal.querySelector('#la-prep-form');
    modal.querySelector('[data-act="cancel"]').addEventListener('click', Modal.close);
    modal.querySelector('#la-manage-templates-btn').addEventListener('click', () => {
      openTemplateManagerModal(async () => {
        const freshTemplates = await Api.get('/api/lease-templates');
        await Modal.close(true);
        openPrepModal(agreement, freshTemplates, onChange);
      });
    });
    const mtmBox = qs('[name="monthToMonth"]', form);
    mtmBox.addEventListener('change', () => { qs('[name="leaseEndDate"]', form).disabled = mtmBox.checked; });

    async function saveDraft() {
      agreement = await Api.put('/api/lease-agreements/' + agreement.id, {
        templateId: Number(qs('[name="templateId"]', form).value), fields: readPrepFields(form),
      });
      return agreement;
    }
    formButtonAction(modal, modal.querySelector('[data-act="preview"]'), 'Saving…', async () => {
      await saveDraft();
      window.open('/api/lease-agreements/' + agreement.id + '/preview.pdf', '_blank');
    });
    formButtonAction(modal, modal.querySelector('[data-act="save"]'), 'Saving…', async () => {
      await saveDraft();
      Toast.show('Draft saved.', 'success');
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = qs('button[type="submit"]', form);
      if (modal.dataset.busyAction === '1') return;
      modal.dataset.busyAction = '1';
      clearFormError(modal);
      setButtonBusy(btn, true, 'Finalizing…');
      try {
        await saveDraft();
        const finalized = await Api.post('/api/lease-agreements/' + agreement.id + '/finalize', {});
        await Modal.close(true);
        openOwnerSignModal(finalized, onChange);
      } catch (err) {
        modal.dataset.busyAction = '0';
        setButtonBusy(btn, false);
        showFormError(modal, describeApiError(err));
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Shared review + sign layout
  // ---------------------------------------------------------------------------

  function documentReviewHtml(agreement, previewUrl, extraNote) {
    return (
      '<p class="field-hint">Read the complete agreement below, or <a href="' + previewUrl + '" target="_blank" rel="noopener">open the full document as a PDF</a>.' + (extraNote || '') + '</p>' +
      '<div style="max-height:280px;overflow:auto;border:1px solid var(--line);border-radius:var(--radius);padding:14px;white-space:pre-wrap;font-size:12.5px;line-height:1.5;margin-bottom:16px;background:#fafafa;">' +
        escapeHtml(agreement.bodySnapshot || '(No content yet.)') +
      '</div>'
    );
  }

  function openOwnerSignModal(agreement, onChange) {
    const tenantEmails = agreement.signers.filter((s) => s.role !== 'landlord').map((s) => s.displayName);
    const modal = Modal.open(
      '<h2>Review &amp; sign</h2>' +
      documentReviewHtml(agreement, '/api/lease-agreements/' + agreement.id + '/preview.pdf') +
      (tenantEmails.length ? '<p class="field-hint">Once signed, this will be sent to: ' + escapeHtml(tenantEmails.join(', ')) + '.</p>' : '<div class="banner warn">No tenant is on this lease yet — add one before sending.</div>') +
      '<div class="checkbox-field"><input type="checkbox" id="la-consent"><label for="la-consent">I have reviewed this agreement and explicitly agree to sign it electronically.</label></div>' +
      '<div class="field"><label>Type your full legal name to sign</label><input id="la-signature" autocomplete="off"></div>' +
      '<div id="la-sign-error"></div>' +
      '<div class="modal-actions"><button type="button" class="btn" data-act="close">Close</button><button type="button" class="btn primary" data-act="sign">Sign &amp; send for signature</button></div>'
    );
    modal.querySelector('[data-act="close"]').addEventListener('click', Modal.close);
    formButtonAction(modal, modal.querySelector('[data-act="sign"]'), 'Signing…', async () => {
      const consent = qs('#la-consent', modal).checked;
      const signatureText = qs('#la-signature', modal).value;
      if (!consent) throw new Error('You must check the box to explicitly consent to sign electronically.');
      if (!signatureText.trim()) throw new Error('Type your full legal name to sign.');
      await Api.post('/api/lease-agreements/' + agreement.id + '/sign', { consent, signatureText });
      await Modal.close(true);
      Toast.show('Signed and sent for signature.', 'success');
      onChange();
    });
  }

  function openAuditModal(agreementId, isRenter) {
    Modal.open('<h2>Signing record</h2><div id="la-audit-body"><div class="loading-block"><span class="spinner-inline"></span></div></div><div class="modal-actions"><button type="button" class="btn" data-act="close">Close</button></div>');
    qs('[data-act="close"]').addEventListener('click', Modal.close);
    const base = isRenter ? '/api/renter/agreements/' : '/api/lease-agreements/';
    Api.get(base + agreementId + '/events').then((events) => {
      const body = qs('#la-audit-body');
      if (!body) return;
      body.innerHTML = events.length === 0 ? '<p class="field-hint">No events yet.</p>' :
        '<div class="table-wrap"><table><thead><tr><th>Event</th><th>By</th><th>When</th></tr></thead><tbody>' +
        events.map((e) => (
          '<tr><td>' + escapeHtml(e.eventType.replace(/_/g, ' ')) + '</td><td>' + escapeHtml(e.actorType) + '</td><td>' + formatDateTime(e.createdAt) + '</td></tr>'
        )).join('') + '</tbody></table></div>';
    }).catch((err) => {
      const body = qs('#la-audit-body');
      if (body) body.innerHTML = '<div class="banner error">' + escapeHtml(describeApiError(err)) + '</div>';
    });
  }

  // ---------------------------------------------------------------------------
  // Owner: lease-template manager
  // ---------------------------------------------------------------------------

  async function openTemplateManagerModal(onClose) {
    let templates, placeholders;
    try {
      [templates, placeholders] = await Promise.all([Api.get('/api/lease-templates'), Api.get('/api/lease-templates/placeholders')]);
    } catch (err) {
      Toast.show(describeApiError(err), 'error');
      return;
    }
    paintTemplateList(templates, placeholders, onClose);
  }

  function paintTemplateList(templates, placeholders, onClose) {
    const modal = Modal.open(
      '<h2>Lease templates</h2>' +
      '<div id="la-template-list">' +
        templates.map((t) => (
          '<div class="list-row">' +
            '<span>' + escapeHtml(t.name) + (t.isSample ? ' <span class="badge sample">sample</span>' : '') + (t.jurisdiction ? ' <span class="field-hint">' + escapeHtml(t.jurisdiction) + '</span>' : '') + '</span>' +
            '<span class="btn-row">' +
              (t.isSample
                ? '<button class="btn small" data-duplicate="' + t.id + '">Duplicate to customize</button>'
                : '<button class="btn small" data-edit="' + t.id + '">Edit</button><button class="btn small danger" data-delete="' + t.id + '">Delete</button>') +
            '</span>' +
          '</div>'
        )).join('') +
      '</div>' +
      '<div class="modal-actions"><button type="button" class="btn" data-act="close">Close</button><button type="button" class="btn primary" data-act="new">New template</button></div>'
    );
    modal.querySelector('[data-act="close"]').addEventListener('click', () => { Modal.close(true); if (onClose) onClose(); });
    modal.querySelector('[data-act="new"]').addEventListener('click', () => openTemplateEditModal(null, placeholders, () => openTemplateManagerModal(onClose)));
    qsa('[data-edit]', modal).forEach((btn) => btn.addEventListener('click', () => {
      const t = templates.find((x) => String(x.id) === btn.dataset.edit);
      openTemplateEditModal(t, placeholders, () => openTemplateManagerModal(onClose));
    }));
    qsa('[data-duplicate]', modal).forEach((btn) => wireAction(btn, async () => {
      await Api.post('/api/lease-templates/' + btn.dataset.duplicate + '/duplicate', {});
      Toast.show('Template duplicated — edit your copy.', 'success');
      openTemplateManagerModal(onClose);
    }));
    qsa('[data-delete]', modal).forEach((btn) => wireAction(btn, async () => {
      if (!(await confirmDialog('Delete this template? This cannot be undone.', 'Delete'))) return;
      await Api.del('/api/lease-templates/' + btn.dataset.delete);
      Toast.show('Template deleted.', 'success');
      openTemplateManagerModal(onClose);
    }));
  }

  function openTemplateEditModal(template, placeholders, onDone) {
    const isNew = !template;
    const modal = Modal.open(
      '<h2>' + (isNew ? 'New template' : 'Edit template') + '</h2>' +
      '<form id="la-tpl-form">' +
        '<div class="field"><label>Name</label><input name="name" required value="' + escapeHtml(template ? template.name : '') + '"></div>' +
        '<div class="field"><label>Jurisdiction <span class="field-hint">(optional — e.g. a state or "Not jurisdiction-specific")</span></label><input name="jurisdiction" value="' + escapeHtml(template ? (template.jurisdiction || '') : '') + '"></div>' +
        '<div class="field"><label>Insert a field</label><select id="la-tpl-insert"><option value="">Choose a field to insert…</option>' +
          placeholders.map((p) => '<option value="{{' + p.token + '}}">' + escapeHtml(p.label) + '</option>').join('') +
        '</select></div>' +
        '<div class="field"><label>Template text</label><textarea name="bodyText" rows="14" required style="font-family:var(--mono,monospace);font-size:12.5px;">' + escapeHtml(template ? template.bodyText : '') + '</textarea>' +
          '<span class="field-hint">Use the fields above as {{tokens}} anywhere in the text — they are replaced with the actual deal terms when an agreement is prepared. Do not invent legal clauses you are not sure are appropriate; leave jurisdiction-specific details general or blank.</span></div>' +
        '<div class="modal-actions"><button type="button" class="btn" data-act="cancel">Cancel</button><button type="submit" class="btn primary">Save template</button></div>' +
      '</form>'
    );
    modal.querySelector('[data-act="cancel"]').addEventListener('click', () => { Modal.close(); });
    const textarea = modal.querySelector('[name="bodyText"]');
    modal.querySelector('#la-tpl-insert').addEventListener('change', (e) => {
      const token = e.target.value;
      if (!token) return;
      const start = textarea.selectionStart || textarea.value.length;
      const end = textarea.selectionEnd || textarea.value.length;
      textarea.value = textarea.value.slice(0, start) + token + textarea.value.slice(end);
      textarea.focus();
      textarea.selectionStart = textarea.selectionEnd = start + token.length;
      e.target.value = '';
    });
    const form = modal.querySelector('#la-tpl-form');
    // NOT wireSave: onDone() re-opens the template list modal (async — it
    // re-fetches first) once this one closes. wireSave's own
    // auto-close-after-success runs AFTER onSave resolves with no idea a
    // different modal may already be current by then, so it can end up
    // closing the wrong one — see openInviteRenterModal's comment above for
    // the same failure mode. Sequencing it explicitly here (close, THEN
    // trigger onDone) removes any dependency on how fast that re-fetch runs.
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = qs('button[type="submit"]', form);
      if (modal.dataset.saving === '1') return;
      modal.dataset.saving = '1';
      clearFormError(modal);
      setButtonBusy(btn, true, 'Saving…');
      try {
        const data = formData(form);
        if (isNew) await Api.post('/api/lease-templates', data);
        else await Api.put('/api/lease-templates/' + template.id, data);
        await Modal.close(true);
        Toast.show('Template saved.', 'success');
        if (onDone) onDone();
      } catch (err) {
        modal.dataset.saving = '0';
        setButtonBusy(btn, false);
        showFormError(modal, describeApiError(err));
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Owner: compact "completed agreement" summary for the ACTIVE lease view
  // ---------------------------------------------------------------------------

  async function ownerCompletedSummaryHtml(leaseId) {
    let agreements;
    try { agreements = await Api.get('/api/leases/' + leaseId + '/agreements'); } catch (err) { return ''; }
    const completed = agreements.find((a) => a.status === 'completed');
    if (!completed) return '';
    return (
      '<div class="list-row" id="la-completed-summary" data-agreement-id="' + completed.id + '">' +
        '<span>Signed lease agreement <span class="field-hint">(' + formatDateShort(completed.completedAt ? completed.completedAt.slice(0, 10) : '') + ')</span></span>' +
        '<span class="btn-row">' +
          '<a class="btn small" href="' + completed.finalPdfUrl + '" target="_blank" rel="noopener">Download</a>' +
          '<button class="btn small" id="la-completed-audit-btn">Signing record</button>' +
        '</span>' +
      '</div>'
    );
  }
  function wireOwnerCompletedSummary(container) {
    const btn = qs('#la-completed-audit-btn', container);
    const el = qs('#la-completed-summary', container);
    if (btn && el) btn.addEventListener('click', () => openAuditModal(el.dataset.agreementId, false));
  }

  // ---------------------------------------------------------------------------
  // Renter: "Action Required" card + review/sign modal
  // ---------------------------------------------------------------------------

  const OPEN_RENTER_STATUSES = ['awaiting_renter_signature', 'partially_signed'];

  function actionRequiredCardHtml(agreement) {
    if (!agreement) return '';
    if (OPEN_RENTER_STATUSES.includes(agreement.status)) {
      return (
        '<div class="banner warn" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;">' +
          '<span><strong>Action required:</strong> review and sign your lease agreement.</span>' +
          '<button class="btn small" id="la-action-required-btn" data-agreement-id="' + agreement.id + '">Review &amp; sign</button>' +
        '</div>'
      );
    }
    if (agreement.status === 'changes_requested') {
      return '<div class="banner info">You requested a correction on your lease agreement. Your landlord has been notified and will send an updated version.</div>';
    }
    return '';
  }

  function wireActionRequiredCard(container, onChange) {
    const btn = qs('#la-action-required-btn', container);
    if (btn) btn.addEventListener('click', async () => {
      const agreement = await Api.get('/api/renter/agreements/' + btn.dataset.agreementId);
      openRenterSignModal(agreement, onChange);
    });
  }

  function openRenterSignModal(agreement, onChange) {
    const modal = Modal.open(
      '<h2>Review &amp; sign your lease</h2>' +
      documentReviewHtml(agreement, '/api/renter/agreements/' + agreement.id + '/preview.pdf', ' You can also download it for your records.') +
      '<div class="checkbox-field"><input type="checkbox" id="la-r-consent"><label for="la-r-consent">I have reviewed this agreement and explicitly consent to sign it electronically.</label></div>' +
      '<div class="field"><label>Type your full legal name to sign</label><input id="la-r-signature" autocomplete="off"></div>' +
      '<div id="la-r-error"></div>' +
      '<div class="modal-actions">' +
        '<button type="button" class="btn" data-act="close">Close</button>' +
        '<button type="button" class="btn danger" data-act="decline">Decline</button>' +
        '<button type="button" class="btn" data-act="correction">Request a correction</button>' +
        '<button type="button" class="btn primary" data-act="sign">Sign and accept agreement</button>' +
      '</div>'
    );
    modal.querySelector('[data-act="close"]').addEventListener('click', Modal.close);
    modal.querySelector('[data-act="decline"]').addEventListener('click', () => {
      openMessageModal({ title: 'Decline this agreement', label: 'Please explain why you’re declining', submitLabel: 'Decline', danger: true }, async (message) => {
        await Api.post('/api/renter/agreements/' + agreement.id + '/decline', { message });
        if (onChange) onChange();
      });
    });
    modal.querySelector('[data-act="correction"]').addEventListener('click', () => {
      openMessageModal({ title: 'Request a correction', label: 'What needs to be fixed?', submitLabel: 'Send request' }, async (message) => {
        await Api.post('/api/renter/agreements/' + agreement.id + '/request-correction', { message });
        if (onChange) onChange();
      });
    });
    formButtonAction(modal, modal.querySelector('[data-act="sign"]'), 'Signing…', async () => {
      const consent = qs('#la-r-consent', modal).checked;
      const signatureText = qs('#la-r-signature', modal).value;
      if (!consent) throw new Error('You must check the box to explicitly consent to sign electronically.');
      if (!signatureText.trim()) throw new Error('Type your full legal name to sign.');
      await Api.post('/api/renter/agreements/' + agreement.id + '/sign', { consent, signatureText });
      await Modal.close(true);
      Toast.show('Signed. Thank you!', 'success');
      if (onChange) onChange();
    });
  }

  /** Past agreements this renter was a party to on this lease (their own completed copy, or a declined/voided one) — shown below the overview facts. Former tenants on a LATER lease never see this at all (the API itself excludes it), and never see a later tenant's own agreements on the same lease (scoped to their own signer rows). */
  async function renterAgreementHistoryHtml(leaseId) {
    let agreements;
    try { agreements = await Api.get('/api/renter/leases/' + leaseId + '/agreements'); } catch (err) { return { html: '', agreements: [] }; }
    if (agreements.length === 0) return { html: '', agreements: [] };
    const html = (
      '<div class="section-heading" style="margin-top:30px;"><h2>Lease agreements</h2></div>' +
      agreements.map((a) => (
        '<div class="list-row">' +
          '<span>' + statusBadge(a) + ' <span class="field-hint">v' + a.version + ' · ' + formatDateShort((a.completedAt || a.sentAt || a.createdAt || '').slice(0, 10)) + '</span></span>' +
          '<span class="btn-row">' +
            (a.status === 'completed' ? '<a class="btn small" href="' + a.finalPdfUrl + '" target="_blank" rel="noopener">Download</a>' : '<button class="btn small" data-renter-preview="' + a.id + '">View</button>') +
          '</span>' +
        '</div>'
      )).join('')
    );
    return { html, agreements };
  }
  function wireRenterAgreementHistory(container, agreements) {
    qsa('[data-renter-preview]', container).forEach((btn) => btn.addEventListener('click', () => window.open('/api/renter/agreements/' + btn.dataset.renterPreview + '/preview.pdf', '_blank')));
  }

  return {
    renderInviteLinkModal, openInviteRenterModal, openAssignRenterModal,
    unassignedPanelHtml, wireUnassignedPanel,
    renderOwnerLeaseSection, ownerCompletedSummaryHtml, wireOwnerCompletedSummary,
    openTemplateManagerModal, openAuditModal,
    actionRequiredCardHtml, wireActionRequiredCard, openRenterSignModal,
    renterAgreementHistoryHtml, wireRenterAgreementHistory,
  };
})();

// Individual rental property page: header, quick actions, and the ten
// sections from the spec. Each tab lazily fetches only what it needs.

const PropertyView = (function () {
  let propertyId, activeTab = 'overview', propertyCache;

  const TABS = [
    ['overview', 'Overview'], ['photos', 'Photos & Activity'], ['documents', 'Documents'],
    ['transactions', 'Transactions'], ['value', 'Property Value'], ['mortgage', 'Mortgage'],
    ['tenant', 'Tenant & Lease'], ['history', 'Historical Tenants'], ['maintenance', 'Maintenance'], ['reminders', 'Reminders'],
  ];

  async function render(id, tab) {
    propertyId = id; activeTab = tab || 'overview';
    qs('#view-root').innerHTML = '<div class="loading-block"><span class="spinner-inline"></span> Loading property…</div>';
    let property;
    try {
      property = await Api.get('/api/properties/' + propertyId);
    } catch (err) {
      qs('#view-root').innerHTML = '<div class="banner error">' + escapeHtml(err.message) + '</div><a class="back-link" href="#/">&larr; Back to portfolio</a>';
      return;
    }
    propertyCache = property;
    paint(property);
  }

  function paint(property) {
    // The Overview tab's "Record payment" / "Get payment link" buttons need
    // the active lease's id, but the Tenant & Lease tab (the only other place
    // that used to set this) may never have been opened this visit — it
    // wasn't safe to rely on tab-visit order. currentTenant.id IS the active
    // lease's id (there's no separate tenant record in this schema), and it
    // comes back on every property fetch, so seed it here, unconditionally,
    // before any button gets wired up.
    currentLeaseIdCache = property.currentTenant ? property.currentTenant.id : null;
    qs('#view-root').innerHTML =
      '<a class="back-link" href="#/">&larr; Back to portfolio</a>' +
      renderHeader(property) +
      renderFacts(property) +
      renderQuickActions(property) +
      renderBankAccountsSection(property) +
      '<div class="tabbar">' + TABS.map(([key, label]) => '<button data-tab="' + key + '" class="' + (key === activeTab ? 'active' : '') + '">' + label + '</button>').join('') + '</div>' +
      '<div id="tab-content"><div class="loading-block"><span class="spinner-inline"></span></div></div>';

    qsa('.tabbar button').forEach((btn) => btn.addEventListener('click', () => { location.hash = '#/property/' + propertyId + '/' + btn.dataset.tab; }));
    wireHeaderActions(property);
    wireQuickActions(property);
    wireBankAccountsSection(property);
    renderTab(property);
  }

  function renderHeader(p) {
    return (
      '<div class="prop-header">' +
        '<div class="cover-banner" id="cover-banner">' +
          (p.coverPhotoUrl ? '<img src="' + p.coverPhotoUrl + '" style="object-position:' + p.coverFocal.x + '% ' + p.coverFocal.y + '%">' : '<div class="cover-placeholder">No cover photo yet</div>') +
          '<div class="cover-controls">' +
            '<button class="btn small" id="replace-cover-btn">' + (p.coverPhotoUrl ? 'Replace photo' : 'Add cover photo') + '</button>' +
            (p.coverPhotoUrl ? '<button class="btn small" id="reposition-cover-btn">Reposition</button>' : '') +
          '</div>' +
        '</div>' +
        '<div class="prop-title-row">' +
          '<div>' +
            '<h1>' + escapeHtml(p.name) + (p.isSample ? ' <span class="badge sample">sample data</span>' : '') + (p.status === 'archived' ? ' <span class="badge">archived</span>' : '') + '</h1>' +
            '<div class="addr">' + escapeHtml([p.address.line1, p.address.line2, p.address.city, p.address.state, p.address.zip].filter(Boolean).join(', ') || 'No address on file') + '</div>' +
          '</div>' +
          '<div class="btn-row">' +
            '<button class="btn small" id="edit-property-btn">Edit details</button>' +
            (p.status === 'archived'
              ? '<button class="btn small" id="unarchive-btn">Unarchive</button>'
              : '<button class="btn small" id="archive-btn">Archive</button>') +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }

  function renderFacts(p) {
    const cc = p.currentCharge;
    // "Rent status" here is paired with the current period's due/late dates
    // and paid/owed figures right beside it, so it must describe that SAME
    // charge (cc.status) — not the portfolio-style "worst status across this
    // tenant's whole history" (p.rentStatus), or the two would routinely
    // contradict each other (e.g. "Late" next to "Owed this period: $0" when
    // an OLDER period is what's actually unpaid). p.rentStatus is still the
    // right field for the dashboard card, where "something needs attention"
    // is the point. Here, an older unpaid balance is instead called out
    // explicitly below, keyed off the actual dollar amount still owed on
    // other charges — not off whether the status label happens to differ
    // from the current period's, which stays silent when BOTH periods are
    // late (two different debts can share the same worst-case label).
    const currentStatus = cc ? cc.status : p.rentStatus;
    const hasOlderIssue = !p.hasNoLeaseYet && cc && p.olderOutstandingCents > 0;
    return (
      (hasOlderIssue
        ? '<div class="banner warn">This tenant also owes ' + centsToDisplay(p.olderOutstandingCents) + ' from an earlier period, on top of what\'s shown below — see the Tenant &amp; Lease tab for the full charge history.</div>'
        : '') +
      '<div class="facts-grid">' +
        fact('Occupancy', p.occupancyStatus === 'occupied' ? 'Occupied' : 'Vacant') +
        fact('Current tenant', p.currentTenant ? p.currentTenant.name : '—') +
        fact('Monthly rent', centsToDisplay(p.monthlyRentCents), true) +
        fact('Rent status', p.hasNoLeaseYet ? 'No lease yet' : statusPill(currentStatus), true) +
        fact('Due date', cc ? formatDateShort(cc.dueDate) : '—') +
        fact('Late after', cc ? formatDateShort(cc.lateDate) : '—') +
        fact('Paid this period', cc ? centsToDisplay(cc.paidCents) : '—', true) +
        fact('Owed this period', cc ? centsToDisplay(cc.outstandingCents) : '—', true) +
      '</div>'
    );
  }
  function fact(label, value, money) {
    return '<div class="fact"><div class="fact-label">' + label + '</div><div class="fact-value' + (money ? '' : ' small') + (money ? ' money' : '') + '">' + value + '</div></div>';
  }

  // ---- Bank accounts (row rendering/wiring lives in views/bankAccounts.js,
  // shared with the portfolio-wide Bank Accounts page so there's one
  // implementation of the account list, the Plaid Link flow, and the
  // add/edit form rather than two that can drift apart) ----
  function renderBankAccountsSection(p) {
    const accounts = p.bankAccounts || [];
    return (
      '<div class="card panel" style="margin-bottom:22px;">' +
        '<div class="section-heading"><h2>Bank accounts</h2><button class="btn small" id="link-bank-account-btn">Link Bank Account</button></div>' +
        (accounts.length === 0
          ? '<p class="field-hint">No bank account linked to this rental yet.</p>'
          : '<div class="bank-account-list" id="property-bank-account-list">' + accounts.map((a) => BankAccountsView.bankAccountRowHtml(a, { context: 'property', propertyId: p.id })).join('') + '</div>') +
      '</div>'
    );
  }
  function wireBankAccountsSection(p) {
    qs('#link-bank-account-btn').addEventListener('click', () => {
      BankAccountsView.openLinkChoiceModal({ propertyId: p.id, propertyName: p.name, onDone: () => render(propertyId, activeTab) });
    });
    const list = qs('#property-bank-account-list');
    if (list) BankAccountsView.wireBankAccountRowActions(list, p.bankAccounts || [], { propertyId: p.id, onChange: () => render(propertyId, activeTab) });
  }

  function renderQuickActions(p) {
    return (
      '<div class="btn-row" style="margin-bottom:26px;">' +
        '<button class="btn accent small" id="qa-record-payment"' + (p.hasNoLeaseYet ? ' disabled title="Add a lease first"' : '') + '>Record payment</button>' +
        '<button class="btn small" id="qa-payment-link"' + (p.hasNoLeaseYet ? ' disabled title="Add a lease first"' : '') + '>Get payment link</button>' +
        '<button class="btn small" id="qa-upload-photo">Upload photo</button>' +
        '<button class="btn small" id="qa-add-document">Add document</button>' +
        '<button class="btn small" id="qa-add-expense">Add expense</button>' +
      '</div>'
    );
  }

  function wireHeaderActions(p) {
    qs('#edit-property-btn').addEventListener('click', () => openEditPropertyModal(p));
    const archiveBtn = qs('#archive-btn');
    if (archiveBtn) wireAction(archiveBtn, async () => {
      if (!(await confirmDialog('Archive ' + p.name + '? Its history stays intact and it can be unarchived anytime.', 'Archive'))) return;
      await Api.post('/api/properties/' + propertyId + '/archive');
      Toast.show('Property archived.', 'success');
      location.hash = '#/';
    }, { busyLabel: 'Archiving…' });
    const unarchiveBtn = qs('#unarchive-btn');
    if (unarchiveBtn) wireAction(unarchiveBtn, async () => {
      await Api.post('/api/properties/' + propertyId + '/unarchive');
      Toast.show('Property unarchived.', 'success');
      render(propertyId, activeTab);
    }, { busyLabel: 'Unarchiving…' });
    qs('#replace-cover-btn').addEventListener('click', () => openCoverPhotoModal());
    const repositionBtn = qs('#reposition-cover-btn');
    if (repositionBtn) repositionBtn.addEventListener('click', () => openRepositionModal(p));
  }

  function openCoverPhotoModal() {
    const picker = PhotoPicker({ multiple: false });
    const modal = Modal.open(
      '<h2>Cover photo</h2>' +
      '<div class="field">' + picker.html() + '</div>' +
      '<div class="modal-actions"><button class="btn" data-act="cancel">Cancel</button><button class="btn primary" data-act="save">Save</button></div>'
    );
    picker.wire(modal);
    const cancel = async () => { if (await Modal.close()) picker.destroy(); };
    modal.querySelector('[data-act="cancel"]').addEventListener('click', cancel);
    wireSave(modal.querySelector('[data-act="save"]'), async () => {
      if (picker.hasPendingConversions()) throw new Error('Still converting the photo — try again in a moment.');
      const file = picker.getFiles()[0];
      if (!file) throw new Error('Choose a photo first.');
      const dataUrl = await compressImage(file, 1800, 0.85);
      await Api.post('/api/properties/' + propertyId + '/cover-photo', { dataUrl });
      picker.destroy();
      render(propertyId, activeTab);
    }, { savedMessage: 'Cover photo updated.' });
  }

  function openRepositionModal(p) {
    const modal = Modal.open(
      '<h2>Reposition cover photo</h2>' +
      '<p class="field-hint">Drag the sliders until the photo is framed the way you want on the dashboard card.</p>' +
      '<div class="cover-banner" style="aspect-ratio:16/7;margin-bottom:14px;"><img src="' + p.coverPhotoUrl + '" id="reposition-preview" style="object-position:' + p.coverFocal.x + '% ' + p.coverFocal.y + '%"></div>' +
      '<div class="field"><label>Horizontal</label><input type="range" id="focal-x" min="0" max="100" value="' + p.coverFocal.x + '"></div>' +
      '<div class="field"><label>Vertical</label><input type="range" id="focal-y" min="0" max="100" value="' + p.coverFocal.y + '"></div>' +
      '<div class="modal-actions"><button class="btn" data-act="cancel">Cancel</button><button class="btn primary" data-act="save">Save position</button></div>'
    );
    const preview = qs('#reposition-preview', modal);
    const update = () => { preview.style.objectPosition = qs('#focal-x', modal).value + '% ' + qs('#focal-y', modal).value + '%'; };
    qs('#focal-x', modal).addEventListener('input', update);
    qs('#focal-y', modal).addEventListener('input', update);
    modal.querySelector('[data-act="cancel"]').addEventListener('click', Modal.close);
    wireSave(modal.querySelector('[data-act="save"]'), async () => {
      await Api.put('/api/properties/' + propertyId + '/cover-focal', { x: Number(qs('#focal-x', modal).value), y: Number(qs('#focal-y', modal).value) });
      render(propertyId, activeTab);
    }, { savedMessage: 'Cover photo repositioned.' });
  }

  function openEditPropertyModal(p) {
    const modal = Modal.open(
      '<h2>Edit property details</h2>' +
      '<form id="edit-form">' +
        '<div class="field"><label>Property name</label><input name="name" required value="' + escapeHtml(p.name) + '"></div>' +
        '<div class="field"><label>Address line 1</label><input name="addressLine1" value="' + escapeHtml(p.address.line1 || '') + '"></div>' +
        '<div class="field"><label>Address line 2</label><input name="addressLine2" value="' + escapeHtml(p.address.line2 || '') + '"></div>' +
        '<div class="field-row">' +
          '<div class="field"><label>City</label><input name="city" value="' + escapeHtml(p.address.city || '') + '"></div>' +
          '<div class="field"><label>State</label><input name="state" value="' + escapeHtml(p.address.state || '') + '"></div>' +
          '<div class="field"><label>ZIP</label><input name="zip" value="' + escapeHtml(p.address.zip || '') + '"></div>' +
        '</div>' +
        '<div class="field"><label>Timezone</label><input name="timezone" value="' + escapeHtml(p.timezone) + '"><span class="field-hint">IANA name, e.g. America/Denver</span></div>' +
        '<div class="modal-actions"><button type="button" class="btn" data-act="cancel">Cancel</button><button type="submit" class="btn primary">Save changes</button></div>' +
      '</form>'
    );
    modal.querySelector('[data-act="cancel"]').addEventListener('click', Modal.close);
    const form = modal.querySelector('#edit-form');
    wireSave(form, async () => {
      await Api.put('/api/properties/' + propertyId, formData(form));
      render(propertyId, activeTab);
    });
  }

  function wireQuickActions(p) {
    qs('#qa-upload-photo').addEventListener('click', () => openUploadPhotoModal());
    qs('#qa-add-document').addEventListener('click', () => openAddDocumentModal());
    qs('#qa-add-expense').addEventListener('click', () => openAddExpenseModal());
    const rp = qs('#qa-record-payment'); if (rp && !rp.disabled) rp.addEventListener('click', () => openRecordPaymentFlow(p, rp));
    const pl = qs('#qa-payment-link'); if (pl && !pl.disabled) pl.addEventListener('click', () => openPaymentLinkModal(p, pl));
  }

  // Turns a failed lease-related request into one plain-language sentence,
  // shared by "Record payment" and "Get payment link" so the two behave
  // consistently. `err` is whatever Api.* rejected with: either an
  // Api.ApiError — the server answered with an error status, or the request
  // never got a response at all (timeout/network, see api.js) — or some
  // other unexpected exception (a bug here, not a server/network problem).
  function describeLeaseActionError(err) {
    if (err instanceof Api.ApiError) {
      if (err.status === 401) return 'Your session has expired. Please log in again.';
      if (err.status === 404) return 'This lease no longer exists — the tenant record may have been removed or the property reassigned.';
      if (err.status === 409) return err.message; // e.g. "lease has ended" / "no outstanding balance" — already plain sentences from the server
      if (err.code === 'timeout') return err.message;
      if (err.code === 'network') return err.message;
      if (err.status >= 500 || err.code === 'server') return 'The server hit a problem handling this. Please try again in a moment.';
      return err.message;
    }
    return 'Something went wrong. Please try again.';
  }

  // Failures the server would just repeat unchanged on an immediate retry
  // (bad auth, a lease that's genuinely gone or ended, nothing owed) — a
  // Retry action for these would just be misleading. Timeouts, network
  // blips, and 5xxs are worth offering a retry for.
  function isRetryableError(err) {
    return err instanceof Api.ApiError && (err.code === 'timeout' || err.code === 'network' || err.code === 'server' || err.status >= 500);
  }

  async function openRecordPaymentFlow(p, triggerBtn) {
    // Capture the lease id synchronously, before any await, so a slow
    // request can't finish against whatever property the owner has since
    // navigated to (paint() reseeds currentLeaseIdCache on every property
    // page load).
    const leaseId = currentLeaseIdCache;
    if (!leaseId) { Toast.show('Add a lease first.', 'info'); return; }
    if (triggerBtn) setButtonBusy(triggerBtn, true, 'Loading…');
    try {
      const lease = await Api.get('/api/leases/' + leaseId);
      const open = lease.charges.filter((c) => c.status !== 'paid');
      if (open.length === 0) { Toast.show('Nothing outstanding — every charge is paid.', 'info'); return; }
      openRecordPaymentModal(open[0]);
    } catch (err) {
      if (err instanceof Api.ApiError && err.status === 401) { AuthView.renderLogin(); return; }
      Toast.show(describeLeaseActionError(err), 'error');
    } finally {
      if (triggerBtn) setButtonBusy(triggerBtn, false);
    }
  }

  function openPaymentLinkModal(p, triggerBtn) {
    // Same capture-before-starting reasoning as openRecordPaymentFlow above.
    const leaseId = currentLeaseIdCache;
    if (!leaseId) { Toast.show('Add a lease first.', 'info'); return; }
    requestPaymentLink(leaseId, p, triggerBtn);
  }

  function requestPaymentLink(leaseId, p, triggerBtn) {
    // Disabling the trigger button for the whole request (not just until the
    // modal opens) is what actually prevents duplicate submissions — a second
    // click can't reach the handler while this one is still in flight.
    if (triggerBtn) setButtonBusy(triggerBtn, true, 'Generating…');
    const modal = Modal.open(
      '<h2>Payment link</h2>' +
      '<div class="loading-block"><span class="spinner-inline"></span> Generating a secure payment link…</div>' +
      '<div class="modal-actions"><button class="btn" data-act="cancel">Cancel</button></div>'
    );
    modal.querySelector('[data-act="cancel"]').addEventListener('click', Modal.close);

    Api.post('/api/leases/' + leaseId + '/payment-links')
      .then((link) => {
        // The owner may have closed this modal, or opened a different one
        // (Modal.open() always tears down any previous backdrop first —
        // components.js), while the request was in flight. Either way this
        // exact `modal` node is no longer on the page, and writing into it
        // would be invisible at best and clobber an unrelated modal at worst.
        if (!document.body.contains(modal)) return;
        renderPaymentLinkSuccess(modal, p, link);
      })
      .catch((err) => {
        if (!document.body.contains(modal)) return;
        renderPaymentLinkError(modal, err, () => requestPaymentLink(leaseId, p, triggerBtn));
      })
      .finally(() => { if (triggerBtn) setButtonBusy(triggerBtn, false); });
  }

  function renderPaymentLinkSuccess(modal, p, link) {
    const isLocalLink = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(link.url);
    const provider = link.provider || { mode: 'test', notice: 'No real payment provider is connected. Payments made here are simulated — no real money moves.' };
    modal.innerHTML =
      '<h2>Payment link</h2>' +
      '<p class="field-hint">Share this secure link with ' + escapeHtml(p.currentTenant.name) + ' so they can view and pay their bill. It expires ' + formatDate(link.expiresAt.slice(0, 10)) + '.</p>' +
      '<div class="field"><input readonly value="' + escapeHtml(link.url) + '" id="link-text" onclick="this.select()"></div>' +
      (isLocalLink
        ? '<div class="banner error">This link points at localhost, so it will only open on this computer — a tenant elsewhere won’t be able to use it. Set the APP_BASE_URL environment variable to your app’s public web address so generated links work for tenants. See the README for details.</div>'
        : '') +
      (provider.mode === 'live'
        ? ''
        : '<div class="banner warn"><strong>Simulated payment link.</strong> ' + escapeHtml(provider.notice || 'No real payment provider is connected — no real money moves.') + '</div>') +
      '<div class="banner info">No email/SMS provider is connected, so sending is manual — copy the link and send it yourself. See the README to connect a provider so this can be sent automatically.</div>' +
      '<div class="modal-actions">' +
        '<button class="btn" data-act="close">Close</button>' +
        '<button class="btn" data-act="open">Open link</button>' +
        '<button class="btn primary" data-act="copy">Copy link</button>' +
      '</div>';
    modal.querySelector('[data-act="close"]').addEventListener('click', Modal.close);
    modal.querySelector('[data-act="open"]').addEventListener('click', () => window.open(link.url, '_blank', 'noopener'));
    const copyBtn = modal.querySelector('[data-act="copy"]');
    const defaultLabel = copyBtn.textContent;
    copyBtn.addEventListener('click', async () => {
      try {
        if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('Clipboard API unavailable');
        await navigator.clipboard.writeText(link.url);
        copyBtn.textContent = 'Copied!';
      } catch (e) {
        // Only ever claim success when the copy actually happened. When it
        // didn't (permissions, insecure context, older browser), select the
        // text so a manual Ctrl/Cmd+C still works, and say so rather than
        // lying with a "Copied!" that didn't.
        qs('#link-text', modal).select();
        copyBtn.textContent = 'Couldn’t copy — text selected, use Ctrl/Cmd+C';
      }
      setTimeout(() => { copyBtn.textContent = defaultLabel; }, 2500);
    });
  }

  function renderPaymentLinkError(modal, err, retry) {
    const message = describeLeaseActionError(err);
    const isAuthError = err instanceof Api.ApiError && err.status === 401;
    const canRetry = !isAuthError && isRetryableError(err);
    modal.innerHTML =
      '<h2>Payment link</h2>' +
      '<div class="banner error">' + escapeHtml(message) + '</div>' +
      '<div class="modal-actions">' +
        '<button class="btn" data-act="close">Close</button>' +
        (isAuthError ? '<button class="btn primary" data-act="login">Log in again</button>' : '') +
        (canRetry ? '<button class="btn primary" data-act="retry">Retry</button>' : '') +
      '</div>';
    modal.querySelector('[data-act="close"]').addEventListener('click', Modal.close);
    const loginBtn = modal.querySelector('[data-act="login"]');
    if (loginBtn) loginBtn.addEventListener('click', () => { Modal.close(); AuthView.renderLogin(); });
    const retryBtn = modal.querySelector('[data-act="retry"]');
    if (retryBtn) retryBtn.addEventListener('click', () => { Modal.close(); retry(); });
  }

  // ---- Tab dispatch ----
  let currentLeaseIdCache = null;

  async function renderTab(p) {
    const container = qs('#tab-content');
    try {
      if (activeTab === 'overview') return await renderOverview(p, container);
      if (activeTab === 'photos') return await renderPhotos(p, container);
      if (activeTab === 'documents') return await renderDocuments(p, container);
      if (activeTab === 'transactions') return await renderTransactions(p, container);
      if (activeTab === 'value') return await renderValue(p, container);
      if (activeTab === 'mortgage') return await renderMortgage(p, container);
      if (activeTab === 'tenant') return await renderTenantLease(p, container);
      if (activeTab === 'history') return await renderHistory(p, container);
      if (activeTab === 'maintenance') return await renderMaintenance(p, container);
      if (activeTab === 'reminders') return await renderReminders(p, container);
    } catch (err) {
      container.innerHTML = '<div class="banner error">' + escapeHtml(err.message) + '</div>';
    }
  }

  // ---- Overview ----
  async function renderOverview(p, container) {
    const [txns, maint, reminders] = await Promise.all([
      Api.get('/api/properties/' + propertyId + '/transactions'),
      Api.get('/api/properties/' + propertyId + '/maintenance?status=open'),
      Api.get('/api/properties/' + propertyId + '/reminders'),
    ]);
    const recentTxns = txns.slice(0, 6);
    container.innerHTML =
      '<div class="field-row" style="align-items:flex-start;">' +
        '<div class="card panel"><h3 style="font-size:15px;margin-bottom:12px;">Recent activity</h3>' +
          (recentTxns.length ? recentTxns.map((t) => txnRowHtml(t)).join('') : '<p class="field-hint">Nothing recorded yet.</p>') +
        '</div>' +
        '<div class="card panel"><h3 style="font-size:15px;margin-bottom:12px;">Open maintenance</h3>' +
          (maint.length ? maint.map((m) => '<div class="list-row"><span>' + escapeHtml(m.title) + '</span><span class="field-hint">' + m.priority + '</span></div>').join('') : '<p class="field-hint">No open issues.</p>') +
        '</div>' +
        '<div class="card panel"><h3 style="font-size:15px;margin-bottom:12px;">Deadlines</h3>' +
          (reminders.length ? reminders.slice(0, 6).map((r) => '<div class="list-row"><span>' + escapeHtml(r.title) + '</span><span class="field-hint">' + formatDateShort(r.dueDate) + '</span></div>').join('') : '<p class="field-hint">Nothing coming up.</p>') +
        '</div>' +
      '</div>';
  }
  function txnRowHtml(t) {
    return '<div class="list-row"><span>' + escapeHtml(t.description || t.type) + '<br><span class="field-hint">' + formatDateShort(t.date) + '</span></span><span class="money' + (t.direction === 'out' ? '' : '') + '">' + (t.direction === 'out' ? '-' : '+') + centsToDisplay(t.amountCents) + '</span></div>';
  }

  // ---- Photos & Activity ----
  const ALBUMS = ['move-in', 'move-out', 'inspection', 'repair', 'receipt', 'general'];
  async function renderPhotos(p, container) {
    let currentAlbum = '';
    async function load() {
      const photos = await Api.get('/api/properties/' + propertyId + '/photos' + (currentAlbum ? '?album=' + currentAlbum : ''));
      container.innerHTML =
        '<div class="section-heading"><h2>Photos & activity</h2><button class="btn small" id="upload-photo-btn">Upload photos</button></div>' +
        '<div class="album-tabs">' +
          '<button data-a="" class="' + (currentAlbum === '' ? 'active' : '') + '">All</button>' +
          ALBUMS.map((a) => '<button data-a="' + a + '" class="' + (currentAlbum === a ? 'active' : '') + '">' + a.replace('-', ' ') + '</button>').join('') +
        '</div>' +
        (photos.length ? '<div class="photo-grid">' + photos.map(photoTileHtml).join('') + '</div>' : '<p class="field-hint">No photos in this album yet.</p>');
      qsa('.album-tabs button', container).forEach((btn) => btn.addEventListener('click', () => { currentAlbum = btn.dataset.a; load(); }));
      qs('#upload-photo-btn', container).addEventListener('click', () => openUploadPhotoModal(load));
      qsa('.photo-tile', container).forEach((tile) => tile.addEventListener('click', () => openPhotoLightbox(photos, Number(tile.dataset.idx))));
    }
    await load();
  }
  function photoTileHtml(photo, i) {
    return '<div class="photo-tile" data-idx="' + i + '"><img src="' + photo.url + '" loading="lazy" alt="">' + (photo.caption ? '<div class="caption">' + escapeHtml(photo.caption) + '</div>' : '') + '</div>';
  }
  function openPhotoLightbox(photos, idx) {
    const p = photos[idx];
    const modal = Modal.open(
      '<img src="' + p.url + '" style="width:100%;border-radius:3px;margin-bottom:12px;">' +
      '<div class="field-row">' +
        '<div class="field"><label>Caption</label><input id="lb-caption" value="' + escapeHtml(p.caption || '') + '"></div>' +
        '<div class="field"><label>Album</label><select id="lb-album">' + ALBUMS.map((a) => '<option value="' + a + '"' + (a === p.album ? ' selected' : '') + '>' + a + '</option>').join('') + '</select></div>' +
      '</div>' +
      '<div class="modal-actions"><button class="btn danger" data-act="delete">Delete photo</button><button class="btn" data-act="close">Close</button><button class="btn primary" data-act="save">Save</button></div>'
    );
    modal.querySelector('[data-act="close"]').addEventListener('click', Modal.close);
    wireSave(modal.querySelector('[data-act="save"]'), async () => {
      await Api.put('/api/photos/' + p.id, { caption: qs('#lb-caption', modal).value, album: qs('#lb-album', modal).value });
      renderTab(propertyCache);
    });
    wireAction(modal.querySelector('[data-act="delete"]'), async () => {
      if (!(await confirmDialog('Delete this photo? This cannot be undone.', 'Delete'))) return;
      await Api.del('/api/photos/' + p.id);
      await Modal.close(true);
      Toast.show('Photo deleted.', 'success');
      renderTab(propertyCache);
    }, { busyLabel: 'Deleting…' });
  }
  function openUploadPhotoModal(onDone) {
    const picker = PhotoPicker({ multiple: true });
    const modal = Modal.open(
      '<h2>Upload photos</h2>' +
      '<div class="field"><label>Photos</label>' + picker.html() + '</div>' +
      '<div class="field"><label>Album</label><select id="photo-album">' + ALBUMS.map((a) => '<option value="' + a + '">' + a + '</option>').join('') + '</select></div>' +
      '<div class="field"><label>Caption (optional, applies to all)</label><input id="photo-caption"></div>' +
      '<div class="checkbox-field"><input type="checkbox" id="photo-before-after"><label for="photo-before-after">Mark first two as a before/after pair</label></div>' +
      '<div id="upload-progress"></div>' +
      '<div class="modal-actions"><button class="btn" data-act="cancel">Cancel</button><button class="btn primary" data-act="upload">Upload</button></div>'
    );
    picker.wire(modal);
    const cancel = async () => { if (await Modal.close()) picker.destroy(); };
    modal.querySelector('[data-act="cancel"]').addEventListener('click', cancel);
    wireSave(modal.querySelector('[data-act="upload"]'), async () => {
      if (picker.hasPendingConversions()) throw new Error('Still converting a photo — try again in a moment.');
      const files = picker.getFiles();
      if (files.length === 0) throw new Error('Choose at least one photo first.');
      const images = await Promise.all(files.map((f) => compressImage(f)));
      await Api.post('/api/properties/' + propertyId + '/photos', {
        images, album: qs('#photo-album', modal).value, caption: qs('#photo-caption', modal).value,
        markBeforeAfter: qs('#photo-before-after', modal).checked,
      });
      picker.destroy();
      if (onDone) onDone(); else renderTab(propertyCache);
      return files.length + ' photo(s) uploaded.';
    }, { savingLabel: 'Uploading…' });
  }

  // ---- Documents ----
  const DOC_CATEGORIES = ['lease', 'lease_amendment', 'insurance', 'tax', 'inspection', 'invoice', 'receipt', 'mortgage_statement', 'other'];
  async function renderDocuments(p, container) {
    const docs = await Api.get('/api/properties/' + propertyId + '/documents');
    container.innerHTML =
      '<div class="section-heading"><h2>Documents</h2><button class="btn small" id="add-doc-btn">Add document</button></div>' +
      (docs.length === 0 ? '<p class="field-hint">No documents yet.</p>' :
        '<div class="table-wrap"><table><thead><tr><th>File</th><th>Category</th><th>Expires</th><th>Tenant access</th><th></th></tr></thead><tbody>' +
        docs.map((d) => (
          '<tr><td><a href="' + d.url + '" target="_blank">' + escapeHtml(d.filename) + '</a></td>' +
          '<td>' + d.category.replace('_', ' ') + '</td>' +
          '<td>' + (d.expirationDate ? formatDateShort(d.expirationDate) : '—') + '</td>' +
          '<td>' + (d.isSharedWithTenant ? '<span class="badge shared">shared</span>' : 'Private') + '</td>' +
          '<td><button class="btn small" data-share="' + d.id + '" data-shared="' + d.isSharedWithTenant + '">' + (d.isSharedWithTenant ? 'Unshare' : 'Share') + '</button> <button class="btn small danger" data-del="' + d.id + '">Delete</button></td></tr>'
        )).join('') + '</tbody></table></div>');
    qs('#add-doc-btn', container).addEventListener('click', () => openAddDocumentModal());
    qsa('[data-share]', container).forEach((btn) => wireAction(btn, async () => {
      const nowShared = btn.dataset.shared !== 'true';
      await Api.put('/api/documents/' + btn.dataset.share, { isSharedWithTenant: nowShared });
      Toast.show(nowShared ? 'Document shared with tenant.' : 'Document unshared.', 'success');
      renderTab(propertyCache);
    }));
    qsa('[data-del]', container).forEach((btn) => wireAction(btn, async () => {
      if (!(await confirmDialog('Delete this document?', 'Delete'))) return;
      await Api.del('/api/documents/' + btn.dataset.del);
      Toast.show('Document deleted.', 'success');
      renderTab(propertyCache);
    }, { busyLabel: 'Deleting…' }));
  }
  function openAddDocumentModal() {
    const modal = Modal.open(
      '<h2>Add document</h2>' +
      '<div class="field"><label>File</label><input type="file" id="doc-file"></div>' +
      '<div class="field"><label>Category</label><select id="doc-category">' + DOC_CATEGORIES.map((c) => '<option value="' + c + '">' + c.replace('_', ' ') + '</option>').join('') + '</select></div>' +
      '<div class="field"><label>Expiration date (optional)</label><input type="date" id="doc-expiration"></div>' +
      '<div class="checkbox-field"><input type="checkbox" id="doc-shared"><label for="doc-shared">Share with tenant in their portal</label></div>' +
      '<div class="modal-actions"><button class="btn" data-act="cancel">Cancel</button><button class="btn primary" data-act="save">Add document</button></div>'
    );
    modal.querySelector('[data-act="cancel"]').addEventListener('click', Modal.close);
    wireSave(modal.querySelector('[data-act="save"]'), async () => {
      const file = qs('#doc-file', modal).files[0];
      if (!file) throw new Error('Choose a file first.');
      const dataUrl = await readFileAsDataUrl(file);
      await Api.post('/api/properties/' + propertyId + '/documents', {
        dataUrl, filename: file.name, category: qs('#doc-category', modal).value,
        expirationDate: qs('#doc-expiration', modal).value || null, isSharedWithTenant: qs('#doc-shared', modal).checked,
      });
      renderTab(propertyCache);
    }, { savingLabel: 'Uploading…', savedMessage: 'Document added.' });
  }

  // ---- Transactions ----
  async function renderTransactions(p, container) {
    const txns = await Api.get('/api/properties/' + propertyId + '/transactions');
    container.innerHTML =
      '<div class="section-heading"><h2>Transactions</h2><div class="btn-row">' +
        '<a class="btn small" href="/api/properties/' + propertyId + '/transactions/export.csv">Export CSV</a>' +
        '<button class="btn small" id="add-txn-btn">Add expense / transaction</button>' +
      '</div></div>' +
      (txns.length === 0 ? '<p class="field-hint">No transactions recorded yet.</p>' :
        '<div class="table-wrap"><table><thead><tr><th>Date</th><th>Type</th><th>Category</th><th>Description</th><th>Status</th><th style="text-align:right">Amount</th></tr></thead><tbody>' +
        txns.map((t) => (
          '<tr><td>' + formatDateShort(t.date) + '</td><td>' + t.type.replace('_', ' ') + '</td><td>' + escapeHtml(t.category || '—') + '</td>' +
          '<td>' + escapeHtml(t.description || '—') + (t.isCapital ? ' <span class="badge">capital</span>' : '') + (t.isDebtService ? ' <span class="badge">debt service</span>' : '') + '</td>' +
          '<td>' + t.status + '</td>' +
          '<td style="text-align:right" class="money">' + (t.direction === 'out' ? '-' : '+') + centsToDisplay(t.amountCents) + '</td></tr>'
        )).join('') + '</tbody></table></div>');
    qs('#add-txn-btn', container).addEventListener('click', () => openAddExpenseModal());
  }
  const TXN_TYPES = ['expense', 'fee', 'owner_contribution', 'owner_withdrawal', 'transfer', 'deposit', 'deposit_refund'];
  function openAddExpenseModal() {
    const modal = Modal.open(
      '<h2>Add transaction</h2>' +
      '<div class="field-row">' +
        '<div class="field"><label>Type</label><select id="txn-type">' + TXN_TYPES.map((t) => '<option value="' + t + '">' + t.replace('_', ' ') + '</option>').join('') + '</select></div>' +
        '<div class="field"><label>Direction</label><select id="txn-direction"><option value="out">Money out</option><option value="in">Money in</option></select></div>' +
      '</div>' +
      '<div class="field-row">' +
        '<div class="field"><label>Amount</label><input id="txn-amount" placeholder="0.00"></div>' +
        '<div class="field"><label>Date</label><input type="date" id="txn-date" value="' + todayStr() + '"></div>' +
      '</div>' +
      '<div class="field"><label>Category</label><input id="txn-category" placeholder="e.g. Landscaping"></div>' +
      '<div class="field"><label>Description</label><input id="txn-description"></div>' +
      '<div class="checkbox-field"><input type="checkbox" id="txn-capital"><label for="txn-capital">This is a capital improvement (excluded from NOI, included in cash flow)</label></div>' +
      '<div class="modal-actions"><button class="btn" data-act="cancel">Cancel</button><button class="btn primary" data-act="save">Add</button></div>'
    );
    modal.querySelector('[data-act="cancel"]').addEventListener('click', Modal.close);
    wireSave(modal.querySelector('[data-act="save"]'), async () => {
      await Api.post('/api/properties/' + propertyId + '/transactions', {
        type: qs('#txn-type', modal).value, direction: qs('#txn-direction', modal).value, amount: qs('#txn-amount', modal).value,
        date: qs('#txn-date', modal).value, category: qs('#txn-category', modal).value, description: qs('#txn-description', modal).value,
        isCapital: qs('#txn-capital', modal).checked,
      });
      render(propertyId, activeTab);
    }, { savedMessage: 'Transaction added.' });
  }

  // ---- Property Value ----
  async function renderValue(p, container) {
    const [valuations, improvements] = await Promise.all([
      Api.get('/api/properties/' + propertyId + '/valuations'),
      Api.get('/api/properties/' + propertyId + '/capital-improvements'),
    ]);
    const latest = valuations[0];
    const purchase = valuations.find((v) => v.isPurchase);
    container.innerHTML =
      '<div class="section-heading"><h2>Property value</h2><button class="btn small" id="add-valuation-btn">Add valuation</button></div>' +
      '<div class="facts-grid" style="margin-bottom:24px;">' +
        fact('Current estimated value', latest ? centsToDisplay(latest.valueCents) : '—', true) +
        fact('As of / source', latest ? formatDateShort(latest.valuationDate) + ' · ' + escapeHtml(latest.source || 'Manual') : '—') +
        fact('Purchase price', purchase ? centsToDisplay(purchase.valueCents) : '—', true) +
        fact('Purchase date', purchase ? formatDateShort(purchase.valuationDate) : '—') +
      '</div>' +
      '<div class="banner info">Manual estimates only — no automated valuation (like an AVM) is connected. See the README for how to add one.</div>' +
      '<h3 style="font-size:15px;margin:20px 0 10px;">Valuation history</h3>' +
      (valuations.length ? valuations.map((v) => '<div class="list-row"><span>' + formatDateShort(v.valuationDate) + ' — ' + escapeHtml(v.source || 'Manual estimate') + (v.isPurchase ? ' <span class="badge">purchase</span>' : '') + '</span><span class="money">' + centsToDisplay(v.valueCents) + '</span></div>').join('') : '<p class="field-hint">No valuations recorded.</p>') +
      '<div class="section-heading" style="margin-top:24px;"><h2 style="font-size:16px;">Capital improvements</h2><button class="btn small" id="add-improvement-btn">Add improvement</button></div>' +
      (improvements.length ? improvements.map((i) => '<div class="list-row"><span>' + escapeHtml(i.description) + '<br><span class="field-hint">' + formatDateShort(i.date) + '</span></span><span class="money">' + centsToDisplay(i.amountCents) + '</span></div>').join('') : '<p class="field-hint">None recorded.</p>');

    qs('#add-valuation-btn', container).addEventListener('click', () => openAddValuationModal());
    qs('#add-improvement-btn', container).addEventListener('click', () => openAddImprovementModal());
  }
  function openAddValuationModal() {
    const modal = Modal.open(
      '<h2>Add valuation</h2>' +
      '<div class="field-row">' +
        '<div class="field"><label>Estimated value</label><input id="val-amount" placeholder="0.00"></div>' +
        '<div class="field"><label>Valuation date</label><input type="date" id="val-date" value="' + todayStr() + '"></div>' +
      '</div>' +
      '<div class="field"><label>Source</label><input id="val-source" placeholder="e.g. Recent appraisal, Zestimate, agent CMA"></div>' +
      '<div class="checkbox-field"><input type="checkbox" id="val-purchase"><label for="val-purchase">This is the original purchase price</label></div>' +
      '<div class="modal-actions"><button class="btn" data-act="cancel">Cancel</button><button class="btn primary" data-act="save">Add</button></div>'
    );
    modal.querySelector('[data-act="cancel"]').addEventListener('click', Modal.close);
    wireSave(modal.querySelector('[data-act="save"]'), async () => {
      await Api.post('/api/properties/' + propertyId + '/valuations', {
        value: qs('#val-amount', modal).value, valuationDate: qs('#val-date', modal).value,
        source: qs('#val-source', modal).value, isPurchase: qs('#val-purchase', modal).checked,
      });
      renderTab(propertyCache);
    }, { savedMessage: 'Valuation added.' });
  }
  function openAddImprovementModal() {
    const modal = Modal.open(
      '<h2>Add capital improvement</h2>' +
      '<div class="field"><label>Description</label><input id="imp-desc" placeholder="e.g. New roof"></div>' +
      '<div class="field-row">' +
        '<div class="field"><label>Amount</label><input id="imp-amount" placeholder="0.00"></div>' +
        '<div class="field"><label>Date</label><input type="date" id="imp-date" value="' + todayStr() + '"></div>' +
      '</div>' +
      '<div class="modal-actions"><button class="btn" data-act="cancel">Cancel</button><button class="btn primary" data-act="save">Add</button></div>'
    );
    modal.querySelector('[data-act="cancel"]').addEventListener('click', Modal.close);
    wireSave(modal.querySelector('[data-act="save"]'), async () => {
      await Api.post('/api/properties/' + propertyId + '/capital-improvements', { description: qs('#imp-desc', modal).value, amount: qs('#imp-amount', modal).value, date: qs('#imp-date', modal).value });
      renderTab(propertyCache);
    }, { savedMessage: 'Capital improvement added.' });
  }

  // ---- Mortgage ----
  async function renderMortgage(p, container) {
    const mortgages = await Api.get('/api/properties/' + propertyId + '/mortgages');
    container.innerHTML =
      '<div class="section-heading"><h2>Mortgage</h2><button class="btn small" id="add-mortgage-btn">Add loan</button></div>' +
      (mortgages.length === 0 ? '<p class="field-hint">No loans recorded for this property.</p>' : mortgages.map(mortgageCardHtml).join(''));
    qs('#add-mortgage-btn', container).addEventListener('click', () => openAddMortgageModal());
    qsa('[data-pay-mortgage]', container).forEach((btn) => btn.addEventListener('click', () => openMortgagePaymentModal(btn.dataset.payMortgage)));
  }
  function mortgageCardHtml(m) {
    return (
      '<div class="card panel" style="margin-bottom:14px;">' +
        '<div class="facts-grid" style="border:none;">' +
          fact('Lender', escapeHtml(m.lender)) +
          fact('Current principal', centsToDisplay(m.currentPrincipalCents), true) +
          fact('Original amount', centsToDisplay(m.originalAmountCents), true) +
          fact('Interest rate', m.interestRatePct != null ? m.interestRatePct + '%' : '—') +
          fact('Monthly payment', m.monthlyPaymentCents != null ? centsToDisplay(m.monthlyPaymentCents) : '—', true) +
          fact('Due day', m.dueDay || '—') +
          fact('Escrow', centsToDisplay(m.escrowCents), true) +
          fact('Maturity', m.maturityDate ? formatDateShort(m.maturityDate) : '—') +
        '</div>' +
        '<div class="btn-row" style="margin-top:14px;"><button class="btn small" data-pay-mortgage="' + m.id + '">Record mortgage payment</button></div>' +
        (m.notes ? '<p class="field-hint" style="margin-top:10px;">' + escapeHtml(m.notes) + '</p>' : '') +
      '</div>'
    );
  }
  function openAddMortgageModal() {
    const modal = Modal.open(
      '<h2>Add loan</h2>' +
      '<div class="field"><label>Lender</label><input id="m-lender" required></div>' +
      '<div class="field-row">' +
        '<div class="field"><label>Original amount</label><input id="m-original" placeholder="0.00"></div>' +
        '<div class="field"><label>Current principal</label><input id="m-principal" placeholder="0.00"></div>' +
      '</div>' +
      '<div class="field-row">' +
        '<div class="field"><label>Interest rate (%)</label><input id="m-rate" placeholder="6.5"></div>' +
        '<div class="field"><label>Monthly payment</label><input id="m-payment" placeholder="0.00"></div>' +
      '</div>' +
      '<div class="field-row">' +
        '<div class="field"><label>Due day of month</label><input id="m-due-day" type="number" min="1" max="31"></div>' +
        '<div class="field"><label>Escrow (monthly)</label><input id="m-escrow" placeholder="0.00"></div>' +
      '</div>' +
      '<div class="field-row">' +
        '<div class="field"><label>Origination date</label><input type="date" id="m-origination"></div>' +
        '<div class="field"><label>Maturity date</label><input type="date" id="m-maturity"></div>' +
      '</div>' +
      '<div class="field"><label>Notes</label><textarea id="m-notes"></textarea></div>' +
      '<div class="modal-actions"><button class="btn" data-act="cancel">Cancel</button><button class="btn primary" data-act="save">Add loan</button></div>'
    );
    modal.querySelector('[data-act="cancel"]').addEventListener('click', Modal.close);
    wireSave(modal.querySelector('[data-act="save"]'), async () => {
      await Api.post('/api/properties/' + propertyId + '/mortgages', {
        lender: qs('#m-lender', modal).value, originalAmount: qs('#m-original', modal).value, currentPrincipal: qs('#m-principal', modal).value,
        interestRatePct: qs('#m-rate', modal).value, monthlyPayment: qs('#m-payment', modal).value, dueDay: qs('#m-due-day', modal).value,
        escrow: qs('#m-escrow', modal).value, originationDate: qs('#m-origination', modal).value, maturityDate: qs('#m-maturity', modal).value,
        notes: qs('#m-notes', modal).value,
      });
      renderTab(propertyCache);
    }, { savedMessage: 'Loan added.' });
  }
  function openMortgagePaymentModal(mortgageId) {
    const modal = Modal.open(
      '<h2>Record mortgage payment</h2>' +
      '<div class="field-row">' +
        '<div class="field"><label>Total payment amount</label><input id="mp-amount" placeholder="0.00"></div>' +
        '<div class="field"><label>Of which, principal</label><input id="mp-principal" placeholder="0.00"><span class="field-hint">Rest is treated as interest/escrow</span></div>' +
      '</div>' +
      '<div class="field"><label>Date</label><input type="date" id="mp-date" value="' + todayStr() + '"></div>' +
      '<div class="modal-actions"><button class="btn" data-act="cancel">Cancel</button><button class="btn primary" data-act="save">Record</button></div>'
    );
    modal.querySelector('[data-act="cancel"]').addEventListener('click', Modal.close);
    wireSave(modal.querySelector('[data-act="save"]'), async () => {
      await Api.post('/api/mortgages/' + mortgageId + '/payments', { amount: qs('#mp-amount', modal).value, principalPortion: qs('#mp-principal', modal).value, date: qs('#mp-date', modal).value });
      renderTab(propertyCache);
    }, { savedMessage: 'Mortgage payment recorded.' });
  }

  // ---- Tenant & Lease ----
  async function renderTenantLease(p, container) {
    const leases = await Api.get('/api/properties/' + propertyId + '/leases?status=active');
    const lease = leases[0];
    currentLeaseIdCache = lease ? lease.id : null;
    if (!lease) {
      container.innerHTML = '<div class="empty-state card panel"><h3>No active lease</h3><p>Add a lease to start tracking rent for this property.</p><button class="btn primary" id="add-lease-btn">Add lease</button></div>';
      qs('#add-lease-btn', container).addEventListener('click', () => openAddLeaseModal());
      return;
    }
    container.innerHTML =
      '<div class="section-heading"><h2>Tenant & lease</h2><div class="btn-row">' +
        '<button class="btn small" id="edit-lease-btn">Edit lease</button>' +
        '<button class="btn small" id="rent-change-btn">Change future rent</button>' +
        '<button class="btn small danger" id="end-lease-btn">End lease</button>' +
      '</div></div>' +
      '<div class="facts-grid" style="margin-bottom:22px;">' +
        fact('Tenant', escapeHtml(lease.tenantName)) +
        fact('Co-tenant', lease.coTenantName ? escapeHtml(lease.coTenantName) : '—') +
        fact('Email', lease.tenantEmail ? escapeHtml(lease.tenantEmail) : '—') +
        fact('Phone', lease.tenantPhone ? escapeHtml(lease.tenantPhone) : '—') +
        fact('Lease start', formatDateShort(lease.startDate)) +
        fact('Lease end', lease.endDate ? formatDateShort(lease.endDate) : '—') +
        fact('Current rent', centsToDisplay(lease.currentRentCents), true) +
        fact('Deposit required', centsToDisplay(lease.depositRequiredCents), true) +
        fact('Deposit held', centsToDisplay(lease.depositHeldCents), true) +
        fact('Due day', 'Day ' + lease.dueDay + ' of month') +
        fact('Late after', lease.lateAfterDays + ' days') +
        fact('Late fee', lease.lateFeeEnabled ? (lease.lateFeeType === 'flat' ? centsToDisplay(lease.lateFeeAmountCents) + ' flat' : (lease.lateFeeAmountCents / 100) + '%') : 'Disabled') +
      '</div>' +
      (lease.emergencyContact ? '<p><strong>Emergency contact:</strong> ' + escapeHtml(lease.emergencyContact) + '</p>' : '') +
      (lease.ownerNotes ? '<div class="banner warn"><strong>Private owner notes</strong> (never visible to tenant): ' + escapeHtml(lease.ownerNotes) + '</div>' : '') +
      '<h3 style="font-size:15px;margin:22px 0 10px;">Rent history</h3>' +
      lease.rentHistory.map((h) => '<div class="list-row"><span>Effective ' + formatDateShort(h.effectiveDate) + '</span><span class="money">' + centsToDisplay(h.rentCents) + '</span></div>').join('') +
      '<h3 style="font-size:15px;margin:22px 0 10px;">Charges</h3>' +
      '<div class="table-wrap"><table><thead><tr><th>Period</th><th>Due</th><th>Late after</th><th>Amount</th><th>Paid</th><th>Status</th><th></th></tr></thead><tbody>' +
      lease.charges.map((c) => (
        '<tr><td>' + formatDateShort(c.periodStart) + ' – ' + formatDateShort(c.periodEnd) + '</td><td>' + formatDateShort(c.dueDate) + '</td><td>' + formatDateShort(c.lateDate) + '</td>' +
        '<td class="money">' + centsToDisplay(c.amountCents) + '</td><td class="money">' + centsToDisplay(c.paidCents) + '</td><td>' + statusPill(c.status) + '</td>' +
        '<td><button class="btn small" data-record-charge="' + c.id + '">Record payment</button></td></tr>'
      )).join('') + '</tbody></table></div>';

    qs('#edit-lease-btn', container).addEventListener('click', () => openEditLeaseModal(lease));
    qs('#rent-change-btn', container).addEventListener('click', () => openRentChangeModal(lease));
    qs('#end-lease-btn', container).addEventListener('click', () => openEndLeaseModal(lease));
    qsa('[data-record-charge]', container).forEach((btn) => btn.addEventListener('click', () => {
      const charge = lease.charges.find((c) => String(c.id) === btn.dataset.recordCharge);
      openRecordPaymentModal(charge);
    }));
  }

  function openAddLeaseModal() {
    const modal = Modal.open(leaseFormHtml());
    modal.querySelector('[data-act="cancel"]').addEventListener('click', Modal.close);
    const form = modal.querySelector('#lease-form');
    wireSave(form, async () => {
      await Api.post('/api/properties/' + propertyId + '/leases', formData(form));
      render(propertyId, 'tenant');
    }, { savedMessage: 'Lease added.' });
  }
  function leaseFormHtml() {
    return (
      '<h2>Add lease</h2>' +
      '<form id="lease-form">' +
        '<div class="field-row">' +
          '<div class="field"><label>Tenant name</label><input name="tenantName" required></div>' +
          '<div class="field"><label>Co-tenant (optional)</label><input name="coTenantName"></div>' +
        '</div>' +
        '<div class="field-row">' +
          '<div class="field"><label>Tenant email</label><input name="tenantEmail" type="email"></div>' +
          '<div class="field"><label>Tenant phone</label><input name="tenantPhone"></div>' +
        '</div>' +
        '<div class="field"><label>Emergency contact</label><input name="emergencyContact"></div>' +
        '<div class="field-row">' +
          '<div class="field"><label>Lease start</label><input name="startDate" type="date" required value="' + todayStr() + '"></div>' +
          '<div class="field"><label>Lease end (optional)</label><input name="endDate" type="date"></div>' +
        '</div>' +
        '<div class="field-row">' +
          '<div class="field"><label>Monthly rent</label><input name="rent" required placeholder="0.00"></div>' +
          '<div class="field"><label>Billing frequency</label><select name="billingFrequency"><option value="monthly">Monthly</option></select></div>' +
        '</div>' +
        '<div class="field-row">' +
          '<div class="field"><label>Deposit required</label><input name="depositRequired" placeholder="0.00"></div>' +
          '<div class="field"><label>Deposit held</label><input name="depositHeld" placeholder="0.00"></div>' +
        '</div>' +
        '<div class="field-row">' +
          '<div class="field"><label>Due day of month</label><input name="dueDay" type="number" min="1" max="31" value="1"></div>' +
          '<div class="field"><label>Days until late</label><input name="lateAfterDays" type="number" min="0" value="5"></div>' +
        '</div>' +
        '<div class="checkbox-field"><input type="checkbox" name="lateFeeEnabled" id="late-fee-enabled"><label for="late-fee-enabled">Enable a late fee (disabled by default)</label></div>' +
        '<div class="field-row">' +
          '<div class="field"><label>Late fee type</label><select name="lateFeeType"><option value="flat">Flat amount</option><option value="percent">Percent of rent</option></select></div>' +
          '<div class="field"><label>Late fee amount</label><input name="lateFeeAmount" placeholder="0.00 or 5 for 5%"></div>' +
        '</div>' +
        '<div class="field"><label>Owner notes (never shown to tenant)</label><textarea name="ownerNotes"></textarea></div>' +
        '<div class="modal-actions"><button type="button" class="btn" data-act="cancel">Cancel</button><button type="submit" class="btn primary">Save lease</button></div>' +
      '</form>'
    );
  }
  function openEditLeaseModal(lease) {
    const modal = Modal.open(
      '<h2>Edit lease</h2>' +
      '<form id="edit-lease-form">' +
        '<div class="field-row">' +
          '<div class="field"><label>Tenant name</label><input name="tenantName" required value="' + escapeHtml(lease.tenantName) + '"></div>' +
          '<div class="field"><label>Co-tenant</label><input name="coTenantName" value="' + escapeHtml(lease.coTenantName || '') + '"></div>' +
        '</div>' +
        '<div class="field-row">' +
          '<div class="field"><label>Email</label><input name="tenantEmail" value="' + escapeHtml(lease.tenantEmail || '') + '"></div>' +
          '<div class="field"><label>Phone</label><input name="tenantPhone" value="' + escapeHtml(lease.tenantPhone || '') + '"></div>' +
        '</div>' +
        '<div class="field"><label>Emergency contact</label><input name="emergencyContact" value="' + escapeHtml(lease.emergencyContact || '') + '"></div>' +
        '<div class="field-row">' +
          '<div class="field"><label>Deposit required</label><input name="depositRequired" value="' + (lease.depositRequiredCents / 100).toFixed(2) + '"></div>' +
          '<div class="field"><label>Deposit held</label><input name="depositHeld" value="' + (lease.depositHeldCents / 100).toFixed(2) + '"></div>' +
        '</div>' +
        '<div class="field-row">' +
          '<div class="field"><label>Due day</label><input name="dueDay" type="number" value="' + lease.dueDay + '"></div>' +
          '<div class="field"><label>Days until late</label><input name="lateAfterDays" type="number" value="' + lease.lateAfterDays + '"></div>' +
        '</div>' +
        '<div class="checkbox-field"><input type="checkbox" name="lateFeeEnabled" id="edit-late-fee"' + (lease.lateFeeEnabled ? ' checked' : '') + '><label for="edit-late-fee">Late fee enabled</label></div>' +
        '<div class="field-row">' +
          '<div class="field"><label>Late fee type</label><select name="lateFeeType"><option value="flat"' + (lease.lateFeeType === 'flat' ? ' selected' : '') + '>Flat</option><option value="percent"' + (lease.lateFeeType === 'percent' ? ' selected' : '') + '>Percent</option></select></div>' +
          '<div class="field"><label>Late fee amount</label><input name="lateFeeAmount" value="' + (lease.lateFeeAmountCents / 100).toFixed(2) + '"></div>' +
        '</div>' +
        '<div class="field"><label>Owner notes</label><textarea name="ownerNotes">' + escapeHtml(lease.ownerNotes || '') + '</textarea></div>' +
        '<div class="modal-actions"><button type="button" class="btn" data-act="cancel">Cancel</button><button type="submit" class="btn primary">Save</button></div>' +
      '</form>'
    );
    modal.querySelector('[data-act="cancel"]').addEventListener('click', Modal.close);
    const form = modal.querySelector('#edit-lease-form');
    wireSave(form, async () => {
      await Api.put('/api/leases/' + lease.id, formData(form));
      renderTab(propertyCache);
    }, { savedMessage: 'Lease updated.' });
  }
  function openRentChangeModal(lease) {
    const modal = Modal.open(
      '<h2>Change future rent</h2>' +
      '<p class="field-hint">This only affects charges from the effective date forward — bills already sent keep their original amount.</p>' +
      '<div class="field"><label>New monthly rent</label><input id="rc-amount" placeholder="0.00" value="' + (lease.currentRentCents / 100).toFixed(2) + '"></div>' +
      '<div class="field"><label>Effective date</label><input type="date" id="rc-date" value="' + todayStr() + '"></div>' +
      '<div class="modal-actions"><button class="btn" data-act="cancel">Cancel</button><button class="btn primary" data-act="save">Save</button></div>'
    );
    modal.querySelector('[data-act="cancel"]').addEventListener('click', Modal.close);
    wireSave(modal.querySelector('[data-act="save"]'), async () => {
      await Api.post('/api/leases/' + lease.id + '/rent-change', { rent: qs('#rc-amount', modal).value, effectiveDate: qs('#rc-date', modal).value });
      renderTab(propertyCache);
    }, { savedMessage: 'Future rent updated.' });
  }
  function openEndLeaseModal(lease) {
    const modal = Modal.open(
      '<h2>End lease</h2>' +
      '<p class="field-hint">This preserves the full tenant history — charges, payments, and documents all stay intact under Historical Tenants.</p>' +
      '<div class="field"><label>Move-out date</label><input type="date" id="el-date" value="' + todayStr() + '"></div>' +
      '<div class="field"><label>Deposit disposition</label><textarea id="el-disposition" placeholder="e.g. Returned $1,200 of $1,500; $300 withheld for cleaning"></textarea></div>' +
      '<div class="modal-actions"><button class="btn" data-act="cancel">Cancel</button><button class="btn danger" data-act="save">End lease</button></div>'
    );
    modal.querySelector('[data-act="cancel"]').addEventListener('click', Modal.close);
    wireSave(modal.querySelector('[data-act="save"]'), async () => {
      await Api.post('/api/leases/' + lease.id + '/end', { endDate: qs('#el-date', modal).value, depositDisposition: qs('#el-disposition', modal).value });
      render(propertyId, 'tenant');
    }, { savedMessage: 'Lease ended.' });
  }
  function openRecordPaymentModal(charge) {
    const modal = Modal.open(
      '<h2>Record payment</h2>' +
      '<p class="field-hint">' + formatDate(charge.periodStart) + ' – ' + formatDate(charge.periodEnd) + ' · outstanding ' + centsToDisplay(charge.outstandingCents) + '</p>' +
      '<div class="field-row">' +
        '<div class="field"><label>Type</label><select id="rp-type"><option value="payment">Payment</option><option value="credit">Credit</option><option value="refund">Refund</option><option value="reversal">Reversal</option></select></div>' +
        '<div class="field"><label>Method</label><select id="rp-method"><option value="cash">Cash</option><option value="check">Check</option><option value="card">Card</option><option value="bank_transfer">Bank transfer</option><option value="other">Other</option></select></div>' +
      '</div>' +
      '<div class="field-row">' +
        '<div class="field"><label>Amount</label><input id="rp-amount" placeholder="0.00" value="' + (charge.outstandingCents / 100).toFixed(2) + '"></div>' +
        '<div class="field"><label>Date</label><input type="date" id="rp-date" value="' + todayStr() + '"></div>' +
      '</div>' +
      '<div class="field"><label>Notes</label><input id="rp-notes"></div>' +
      '<div class="modal-actions"><button class="btn" data-act="cancel">Cancel</button><button class="btn primary" data-act="save">Record</button></div>'
    );
    modal.querySelector('[data-act="cancel"]').addEventListener('click', Modal.close);
    wireSave(modal.querySelector('[data-act="save"]'), async () => {
      await Api.post('/api/charges/' + charge.id + '/payments', {
        type: qs('#rp-type', modal).value, method: qs('#rp-method', modal).value,
        amount: qs('#rp-amount', modal).value, paidAt: qs('#rp-date', modal).value, notes: qs('#rp-notes', modal).value,
      });
      render(propertyId, activeTab);
    }, { savedMessage: 'Payment recorded.' });
  }

  // ---- Historical Tenants ----
  async function renderHistory(p, container) {
    const leases = await Api.get('/api/properties/' + propertyId + '/leases?status=ended');
    container.innerHTML =
      '<h2 style="margin-bottom:16px;">Historical tenants</h2>' +
      (leases.length === 0 ? '<p class="field-hint">No past tenants yet.</p>' : leases.map((l) => (
        '<div class="card panel" style="margin-bottom:14px;">' +
          '<div class="facts-grid" style="border:none;">' +
            fact('Tenant', escapeHtml(l.tenantName)) + fact('Lease dates', formatDateRange(l.startDate, l.endDate)) +
            fact('Final rent', centsToDisplay(l.currentRentCents), true) + fact('Deposit disposition', l.depositDisposition ? escapeHtml(l.depositDisposition) : '—') +
          '</div>' +
          '<button class="btn small" data-view-lease="' + l.id + '" style="margin-top:12px;">View full charge/payment history</button>' +
        '</div>'
      )).join(''));
    qsa('[data-view-lease]', container).forEach((btn) => btn.addEventListener('click', async () => {
      const lease = await Api.get('/api/leases/' + btn.dataset.viewLease);
      Modal.open(
        '<h2>' + escapeHtml(lease.tenantName) + '</h2>' +
        '<div class="table-wrap"><table><thead><tr><th>Period</th><th>Amount</th><th>Paid</th><th>Status</th></tr></thead><tbody>' +
        lease.charges.map((c) => '<tr><td>' + formatDateShort(c.periodStart) + '</td><td class="money">' + centsToDisplay(c.amountCents) + '</td><td class="money">' + centsToDisplay(c.paidCents) + '</td><td>' + statusPill(c.status) + '</td></tr>').join('') +
        '</tbody></table></div><div class="modal-actions"><button class="btn" data-act="close">Close</button></div>'
      );
      qs('[data-act="close"]').addEventListener('click', Modal.close);
    }));
  }

  // ---- Maintenance ----
  async function renderMaintenance(p, container) {
    const requests = await Api.get('/api/properties/' + propertyId + '/maintenance');
    container.innerHTML =
      '<div class="section-heading"><h2>Maintenance</h2><button class="btn small" id="add-maint-btn">Add request</button></div>' +
      (requests.length === 0 ? '<p class="field-hint">No maintenance requests.</p>' : requests.map(maintenanceRowHtml).join(''));
    qs('#add-maint-btn', container).addEventListener('click', () => openAddMaintenanceModal());
    qsa('[data-edit-maint]', container).forEach((btn) => btn.addEventListener('click', () => openEditMaintenanceModal(requests.find((r) => String(r.id) === btn.dataset.editMaint))));
  }
  function maintenanceRowHtml(r) {
    return (
      '<div class="card panel" style="margin-bottom:12px;">' +
        '<div style="display:flex;justify-content:space-between;gap:12px;">' +
          '<div><strong>' + escapeHtml(r.title) + '</strong> <span class="field-hint">' + r.priority + (r.createdBy === 'tenant' ? ' · submitted by tenant' : '') + '</span>' +
          (r.description ? '<p class="field-hint" style="margin:4px 0 0;">' + escapeHtml(r.description) + '</p>' : '') + '</div>' +
          '<div style="text-align:right;"><span class="badge">' + r.status.replace('_', ' ') + '</span>' +
          (r.assignedVendor ? '<div class="field-hint" style="margin-top:6px;">' + escapeHtml(r.assignedVendor) + '</div>' : '') +
          (r.estimatedCostCents ? '<div class="field-hint">Est. ' + centsToDisplay(r.estimatedCostCents) + '</div>' : '') + '</div>' +
        '</div>' +
        (r.photos.length ? '<div class="photo-grid" style="margin-top:12px;grid-template-columns:repeat(auto-fill,minmax(90px,1fr));">' + r.photos.map((ph) => '<div class="photo-tile" style="cursor:default;"><img src="' + ph.url + '"></div>').join('') + '</div>' : '') +
        '<div class="btn-row" style="margin-top:12px;"><button class="btn small" data-edit-maint="' + r.id + '">Update</button></div>' +
      '</div>'
    );
  }
  function openAddMaintenanceModal() {
    const picker = PhotoPicker({ multiple: true });
    const modal = Modal.open(maintenanceFormHtml(null, picker));
    picker.wire(modal);
    wireMaintenanceForm(modal, null, picker);
  }
  function openEditMaintenanceModal(r) {
    const picker = PhotoPicker({ multiple: true });
    const modal = Modal.open(maintenanceFormHtml(r, picker));
    picker.wire(modal);
    wireMaintenanceForm(modal, r, picker);
  }
  function maintenanceFormHtml(r, picker) {
    r = r || {};
    return (
      '<h2>' + (r.id ? 'Update maintenance request' : 'Add maintenance request') + '</h2>' +
      '<div class="field"><label>Title</label><input id="mt-title" value="' + escapeHtml(r.title || '') + '"></div>' +
      '<div class="field"><label>Description</label><textarea id="mt-desc">' + escapeHtml(r.description || '') + '</textarea></div>' +
      '<div class="field-row">' +
        '<div class="field"><label>Priority</label><select id="mt-priority">' + ['low', 'normal', 'high', 'urgent'].map((x) => '<option value="' + x + '"' + (r.priority === x ? ' selected' : '') + '>' + x + '</option>').join('') + '</select></div>' +
        '<div class="field"><label>Status</label><select id="mt-status">' + ['open', 'scheduled', 'in_progress', 'completed', 'cancelled'].map((x) => '<option value="' + x + '"' + (r.status === x ? ' selected' : '') + '>' + x.replace('_', ' ') + '</option>').join('') + '</select></div>' +
      '</div>' +
      '<div class="field"><label>Assigned vendor</label><input id="mt-vendor" value="' + escapeHtml(r.assignedVendor || '') + '"></div>' +
      '<div class="field-row">' +
        '<div class="field"><label>Estimated cost</label><input id="mt-est" value="' + (r.estimatedCostCents ? (r.estimatedCostCents / 100).toFixed(2) : '') + '"></div>' +
        '<div class="field"><label>Actual cost</label><input id="mt-actual" value="' + (r.actualCostCents ? (r.actualCostCents / 100).toFixed(2) : '') + '"></div>' +
      '</div>' +
      '<div class="field-row">' +
        '<div class="field"><label>Scheduled date</label><input type="date" id="mt-scheduled" value="' + (r.scheduledDate || '') + '"></div>' +
        '<div class="field"><label>Completed date</label><input type="date" id="mt-completed" value="' + (r.completedDate || '') + '"></div>' +
      '</div>' +
      '<div class="field"><label>Photos</label>' + picker.html() + '</div>' +
      '<div class="modal-actions"><button type="button" class="btn" data-act="cancel">Cancel</button><button type="button" class="btn primary" data-act="save">Save</button></div>'
    );
  }
  function wireMaintenanceForm(modal, existing, picker) {
    const cancel = async () => { if (await Modal.close()) picker.destroy(); };
    modal.querySelector('[data-act="cancel"]').addEventListener('click', cancel);
    wireSave(modal.querySelector('[data-act="save"]'), async () => {
      if (picker.hasPendingConversions()) throw new Error('Still converting a photo — try again in a moment.');
      const files = picker.getFiles();
      const images = files.length ? await Promise.all(files.map((f) => compressImage(f))) : [];
      const payload = {
        title: qs('#mt-title', modal).value, description: qs('#mt-desc', modal).value, priority: qs('#mt-priority', modal).value,
        status: qs('#mt-status', modal).value, assignedVendor: qs('#mt-vendor', modal).value,
        estimatedCost: qs('#mt-est', modal).value, actualCost: qs('#mt-actual', modal).value,
        scheduledDate: qs('#mt-scheduled', modal).value || null, completedDate: qs('#mt-completed', modal).value || null, images,
      };
      if (existing) await Api.put('/api/maintenance/' + existing.id, payload);
      else await Api.post('/api/properties/' + propertyId + '/maintenance', payload);
      picker.destroy();
      renderTab(propertyCache);
    }, { savedMessage: existing ? 'Maintenance request updated.' : 'Maintenance request added.' });
  }

  // ---- Reminders ----
  async function renderReminders(p, container) {
    const reminders = await Api.get('/api/properties/' + propertyId + '/reminders');
    container.innerHTML =
      '<div class="section-heading"><h2>Reminders</h2><button class="btn small" id="add-reminder-btn">Add reminder</button></div>' +
      (reminders.length === 0 ? '<p class="field-hint">Nothing scheduled.</p>' : reminders.map((r) => (
        '<div class="list-row"><span>' + escapeHtml(r.title) + ' <span class="field-hint">(' + r.type.replace('_', ' ') + (r.auto ? ', auto' : '') + ')</span></span>' +
        '<span>' + formatDateShort(r.dueDate) + (r.auto ? '' : ' <button class="btn small" data-dismiss="' + r.id + '">Dismiss</button>') + '</span></div>'
      )).join(''));
    qs('#add-reminder-btn', container).addEventListener('click', () => openAddReminderModal());
    qsa('[data-dismiss]', container).forEach((btn) => wireAction(btn, async () => {
      await Api.post('/api/reminders/' + btn.dataset.dismiss + '/dismiss');
      renderTab(propertyCache);
    }, { busyLabel: 'Dismissing…' }));
  }
  function openAddReminderModal() {
    const modal = Modal.open(
      '<h2>Add reminder</h2>' +
      '<div class="field"><label>Title</label><input id="rm-title"></div>' +
      '<div class="field-row">' +
        '<div class="field"><label>Type</label><select id="rm-type">' + ['rent', 'lease_expiration', 'inspection', 'insurance_renewal', 'tax', 'maintenance', 'other'].map((t) => '<option value="' + t + '">' + t.replace('_', ' ') + '</option>').join('') + '</select></div>' +
        '<div class="field"><label>Due date</label><input type="date" id="rm-date" value="' + todayStr() + '"></div>' +
      '</div>' +
      '<div class="modal-actions"><button class="btn" data-act="cancel">Cancel</button><button class="btn primary" data-act="save">Add</button></div>'
    );
    modal.querySelector('[data-act="cancel"]').addEventListener('click', Modal.close);
    wireSave(modal.querySelector('[data-act="save"]'), async () => {
      await Api.post('/api/properties/' + propertyId + '/reminders', { title: qs('#rm-title', modal).value, type: qs('#rm-type', modal).value, dueDate: qs('#rm-date', modal).value });
      renderTab(propertyCache);
    }, { savedMessage: 'Reminder added.' });
  }

  return { render };
})();

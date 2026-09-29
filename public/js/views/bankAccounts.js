// Portfolio-wide bank accounts page, plus the shared modal logic (add
// manual / link existing / connect a real bank / edit / reconnect) that
// views/property.js's own "Link Bank Account" action reuses — kept in one
// place so there is exactly one implementation of the Plaid Link flow and
// the account form, not two copies that can drift apart.

const BankAccountsView = (function () {
  let accounts = [];
  let plaidScriptPromise = null;

  async function render() {
    qs('#view-root').innerHTML = '<div class="loading-block"><span class="spinner-inline"></span> Loading bank accounts…</div>';
    try {
      accounts = await Api.get('/api/bank-accounts');
    } catch (err) {
      qs('#view-root').innerHTML = '<div class="banner error">' + escapeHtml(err.message) + '</div>';
      return;
    }
    paint();
  }

  function paint() {
    const linkedCount = accounts.filter((a) => a.linkedProperties.length > 0).length;
    qs('#view-root').innerHTML =
      '<div class="page-title">Bank Accounts</div>' +
      '<div class="page-subtitle">' + accounts.length + ' account' + (accounts.length === 1 ? '' : 's') + ' · ' + linkedCount + ' linked to a rental</div>' +
      '<div class="btn-row" style="margin-bottom:22px;"><button class="btn primary" id="add-account-btn">Add Bank Account</button></div>' +
      (accounts.length === 0
        ? '<div class="empty-state card panel"><h3>No bank accounts yet</h3><p>Add a manual account to track a balance yourself, or connect a real bank to keep it current automatically.</p></div>'
        : '<div class="card panel"><div class="bank-account-list" id="bank-account-list">' + accounts.map((a) => bankAccountRowHtml(a, { context: 'home' })).join('') + '</div></div>');

    qs('#add-account-btn').addEventListener('click', () => openLinkChoiceModal({ onDone: render }));
    const list = qs('#bank-account-list');
    if (list) wireBankAccountRowActions(list, accounts, { onChange: render });
  }

  // ---- Shared row rendering + wiring (also used by views/property.js) ----

  function bankAccountRowHtml(b, opts) {
    opts = opts || {};
    const balanceTypeLabel = { manual: 'Manual balance', available: 'Available balance', current: 'Current balance' }[b.balanceType] || 'Balance';
    const otherProperties = opts.propertyId ? b.linkedProperties.filter((p) => Number(p.id) !== Number(opts.propertyId)) : b.linkedProperties;
    let linkNote = '';
    if (otherProperties.length > 0) linkNote = ' · also on ' + otherProperties.map((p) => escapeHtml(p.name)).join(', ');
    else if (opts.context === 'home' && b.linkedProperties.length === 0) linkNote = ' · not linked to any rental yet';
    return (
      '<div class="list-row" data-account-id="' + b.id + '">' +
        '<div>' +
          '<div>' +
            '<strong>' + escapeHtml(b.nickname) + '</strong>' +
            (b.institutionName ? ' <span class="field-hint">' + escapeHtml(b.institutionName) + '</span>' : '') +
            (b.mask ? ' <span class="field-hint">••' + escapeHtml(b.mask) + '</span>' : '') +
            ' <span class="badge">' + (b.mode === 'connected' ? 'Connected' : 'Manual') + '</span>' +
            (b.isShared ? ' <span class="badge shared">shared</span>' : '') +
            (b.needsReconnect ? ' <span class="badge warn">Reconnect needed</span>' : '') +
          '</div>' +
          '<div class="field-hint">' + balanceTypeLabel + ' · updated ' + (b.asOf ? formatDateShort(b.asOf) : 'never') + escapeHtml(linkNote) + '</div>' +
          (b.needsReconnect && b.connectionError ? '<div class="field-hint" style="color:var(--late);">' + escapeHtml(b.connectionError) + '</div>' : '') +
        '</div>' +
        '<div style="text-align:right;">' +
          '<div class="money">' + centsToDisplay(b.balanceCents) + '</div>' +
          '<div class="btn-row" style="margin-top:6px;justify-content:flex-end;">' +
            (b.mode === 'connected' && !b.needsReconnect ? '<button class="btn small" data-row-act="sync">Refresh</button>' : '') +
            (b.needsReconnect ? '<button class="btn small accent" data-row-act="reconnect">Reconnect</button>' : '') +
            '<button class="btn small" data-row-act="edit">Edit</button>' +
            (opts.context === 'property' ? '<button class="btn small" data-row-act="unlink">Unlink</button>' : '<button class="btn small danger" data-row-act="delete">Remove</button>') +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }

  function wireBankAccountRowActions(root, accountList, opts) {
    qsa('.list-row[data-account-id]', root).forEach((row) => {
      const id = Number(row.dataset.accountId);
      const account = accountList.find((a) => a.id === id);
      if (!account) return;
      const syncBtn = row.querySelector('[data-row-act="sync"]');
      if (syncBtn) syncBtn.addEventListener('click', () => { setButtonBusy(syncBtn, true, 'Refreshing…'); triggerSync(account.id, { onSynced: opts.onChange }); });
      const reconnectBtn = row.querySelector('[data-row-act="reconnect"]');
      if (reconnectBtn) reconnectBtn.addEventListener('click', () => openReconnectFlow(account.bankConnectionId, { onReconnected: opts.onChange }));
      const editBtn = row.querySelector('[data-row-act="edit"]');
      if (editBtn) editBtn.addEventListener('click', () => openAddOrEditManualModal(account, { onSaved: opts.onChange }));
      const unlinkBtn = row.querySelector('[data-row-act="unlink"]');
      if (unlinkBtn) unlinkBtn.addEventListener('click', () => unlinkFromProperty(opts.propertyId, account, { onUnlinked: opts.onChange }));
      const deleteBtn = row.querySelector('[data-row-act="delete"]');
      if (deleteBtn) deleteBtn.addEventListener('click', () => deleteAccount(account, { onDeleted: opts.onChange }));
    });
  }

  // ---- Choice modal: link existing (property context only) / add manual / connect real ----

  function openLinkChoiceModal({ propertyId, propertyName, onDone }) {
    const modal = Modal.open(
      '<h2>' + (propertyName ? 'Link Bank Account — ' + escapeHtml(propertyName) : 'Add Bank Account') + '</h2>' +
      '<div class="btn-row" style="flex-direction:column;align-items:stretch;gap:8px;">' +
        (propertyId ? '<button class="btn" data-act="existing" style="justify-content:flex-start;">Link an existing account</button>' : '') +
        '<button class="btn" data-act="manual" style="justify-content:flex-start;">Add a manual account</button>' +
        '<button class="btn" data-act="connect" style="justify-content:flex-start;">Connect a real bank</button>' +
      '</div>' +
      '<div class="modal-actions"><button class="btn" data-act="cancel">Cancel</button></div>'
    );
    modal.querySelector('[data-act="cancel"]').addEventListener('click', Modal.close);
    const existingBtn = modal.querySelector('[data-act="existing"]');
    if (existingBtn) existingBtn.addEventListener('click', () => { Modal.close(); openLinkExistingModal(propertyId, { onLinked: onDone }); });
    modal.querySelector('[data-act="manual"]').addEventListener('click', () => { Modal.close(); openAddOrEditManualModal(null, { presetPropertyIds: propertyId ? [Number(propertyId)] : [], onSaved: onDone }); });
    modal.querySelector('[data-act="connect"]').addEventListener('click', () => { Modal.close(); openConnectRealBankModal(propertyId ? [Number(propertyId)] : [], { onImported: onDone }); });
  }

  // ---- Link an existing account to a specific property ----

  async function openLinkExistingModal(propertyId, { onLinked }) {
    const modal = Modal.open('<h2>Link an existing account</h2><div class="loading-block"><span class="spinner-inline"></span></div>');
    let all;
    try {
      all = await Api.get('/api/bank-accounts');
    } catch (err) {
      if (!document.body.contains(modal)) return;
      modal.innerHTML = '<h2>Link an existing account</h2><div class="banner error">' + escapeHtml(err.message) + '</div><div class="modal-actions"><button class="btn" data-act="close">Close</button></div>';
      modal.querySelector('[data-act="close"]').addEventListener('click', Modal.close);
      return;
    }
    if (!document.body.contains(modal)) return;

    const eligible = all.filter((a) => !a.linkedProperties.some((lp) => Number(lp.id) === Number(propertyId)));
    if (eligible.length === 0) {
      modal.innerHTML =
        '<h2>Link an existing account</h2>' +
        '<p class="field-hint">Every account you have is already linked to this rental. Add a new manual account or connect a real bank instead.</p>' +
        '<div class="modal-actions"><button class="btn" data-act="close">Close</button></div>';
      modal.querySelector('[data-act="close"]').addEventListener('click', Modal.close);
      return;
    }

    modal.innerHTML =
      '<h2>Link an existing account</h2>' +
      '<div class="bank-account-list">' + eligible.map((a) =>
        '<div class="list-row"><span>' + escapeHtml(a.nickname) + (a.isShared ? ' <span class="badge shared">shared</span>' : '') + ' <span class="field-hint">' + centsToDisplay(a.balanceCents) + '</span></span>' +
        '<button class="btn small" data-act="pick" data-id="' + a.id + '">Link</button></div>'
      ).join('') + '</div>' +
      '<div class="modal-actions"><button class="btn" data-act="close">Close</button></div>';
    modal.querySelector('[data-act="close"]').addEventListener('click', Modal.close);
    qsa('[data-act="pick"]', modal).forEach((btn) => wireSave(btn, async () => {
      await Api.post('/api/properties/' + propertyId + '/bank-accounts/link', { bankAccountId: Number(btn.dataset.id) });
      if (onLinked) onLinked();
    }, { savingLabel: 'Linking…', savedMessage: 'Account linked.' }));
  }

  // ---- Add / edit a manual account (also used to rename or reassign a connected one) ----

  async function openAddOrEditManualModal(existing, { presetPropertyIds, onSaved }) {
    const modal = Modal.open('<h2>' + (existing ? 'Edit account' : 'Add manual account') + '</h2><div class="loading-block"><span class="spinner-inline"></span></div>');
    let properties;
    try {
      properties = await Api.get('/api/properties');
    } catch (err) {
      properties = [];
    }
    if (!document.body.contains(modal)) return;

    const linkedIds = existing ? existing.linkedProperties.map((p) => Number(p.id)) : (presetPropertyIds || []);
    const showBalanceFields = !existing || existing.mode === 'manual';
    modal.innerHTML =
      '<h2>' + (existing ? 'Edit account' : 'Add manual account') + '</h2>' +
      '<form id="account-form">' +
        '<div class="field"><label>Nickname</label><input name="nickname" required value="' + (existing ? escapeHtml(existing.nickname) : '') + '"></div>' +
        (showBalanceFields
          ? '<div class="field-row">' +
              '<div class="field"><label>Balance</label><input name="balance" placeholder="0.00" value="' + (existing ? (existing.balanceCents / 100).toFixed(2) : '') + '"></div>' +
              '<div class="field"><label>As of</label><input type="date" name="asOf" value="' + (existing && existing.asOf ? existing.asOf.slice(0, 10) : todayStr()) + '"></div>' +
            '</div>'
          : '<p class="field-hint">This is a connected account — its balance updates from your bank, not by hand. Use "Refresh" to pull the latest balance.</p>') +
        (properties.length > 0
          ? '<div class="field-hint" style="margin-bottom:6px;">Assign to rentals</div><div style="margin-bottom:14px;">' +
            properties.map((p) => '<label style="display:flex;gap:8px;align-items:center;padding:6px 0;"><input type="checkbox" name="propertyIds" value="' + p.id + '"' + (linkedIds.includes(Number(p.id)) ? ' checked' : '') + '> ' + escapeHtml(p.name) + '</label>').join('') +
            '</div>'
          : '<p class="field-hint">You don’t have any rentals yet to assign this to.</p>') +
        '<div class="modal-actions"><button type="button" class="btn" data-act="cancel">Cancel</button><button type="submit" class="btn primary">' + (existing ? 'Save changes' : 'Add account') + '</button></div>' +
      '</form>';
    modal.querySelector('[data-act="cancel"]').addEventListener('click', Modal.close);
    const form = modal.querySelector('#account-form');
    wireSave(form, async () => {
      const fd = formData(form);
      const propertyIds = qsa('input[name="propertyIds"]:checked', modal).map((el) => Number(el.value));
      const payload = { nickname: fd.nickname, propertyIds };
      if (showBalanceFields) { payload.balance = fd.balance; payload.asOf = fd.asOf; }
      if (existing) await Api.put('/api/bank-accounts/' + existing.id, payload);
      else await Api.post('/api/bank-accounts', payload);
      if (onSaved) onSaved();
    }, { savingLabel: existing ? 'Saving…' : 'Adding…', savedMessage: existing ? 'Account updated.' : 'Account added.' });
  }

  // ---- Connect a real bank (Plaid) ----

  function ensurePlaidScript() {
    if (window.Plaid) return Promise.resolve();
    if (plaidScriptPromise) return plaidScriptPromise;
    plaidScriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      // Plaid requires this to be loaded directly from their CDN, never
      // bundled or self-hosted — see their Link docs.
      script.src = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Could not load Plaid. Check your internet connection and try again.'));
      document.head.appendChild(script);
    });
    return plaidScriptPromise;
  }

  async function openConnectRealBankModal(presetPropertyIds, { onImported }) {
    const modal = Modal.open('<h2>Connect a real bank</h2><div class="loading-block"><span class="spinner-inline"></span></div>');
    let status;
    try {
      status = await Api.get('/api/bank-connections/provider-status');
    } catch (err) {
      if (!document.body.contains(modal)) return;
      renderSimpleModalError(modal, 'Connect a real bank', err.message);
      return;
    }
    if (!document.body.contains(modal)) return;

    if (status.mode !== 'live') {
      modal.innerHTML =
        '<h2>Connect a real bank</h2>' +
        '<div class="banner warn">' + escapeHtml(status.notice) + '</div>' +
        '<p class="field-hint">Manual accounts work normally in the meantime — use "Add a manual account" instead.</p>' +
        '<div class="modal-actions"><button class="btn" data-act="close">Close</button></div>';
      modal.querySelector('[data-act="close"]').addEventListener('click', Modal.close);
      return;
    }

    try {
      await ensurePlaidScript();
      const { linkToken } = await Api.post('/api/bank-connections/link-token', {}, { timeoutMs: 30000 });
      if (!document.body.contains(modal)) return;
      Modal.close(); // Plaid's own Link UI is a full-screen takeover — clear ours first so they never stack

      const handler = window.Plaid.create({
        token: linkToken,
        onSuccess: (publicToken, metadata) => {
          const institutionName = (metadata && metadata.institution && metadata.institution.name) || null;
          finishConnectExchange(publicToken, institutionName, presetPropertyIds, onImported);
        },
        onExit: (err) => {
          if (err) Toast.show('Bank connection was not completed: ' + (err.display_message || err.error_message || 'cancelled'), 'info');
        },
      });
      handler.open();
    } catch (err) {
      if (!document.body.contains(modal)) return;
      renderSimpleModalError(modal, 'Connect a real bank', err.message);
    }
  }

  async function finishConnectExchange(publicToken, institutionName, presetPropertyIds, onImported) {
    const modal = Modal.open('<h2>Connecting…</h2><div class="loading-block"><span class="spinner-inline"></span> Finishing up with your bank…</div>');
    let result;
    try {
      result = await Api.post('/api/bank-connections/exchange', { publicToken, institutionName }, { timeoutMs: 30000 });
    } catch (err) {
      if (!document.body.contains(modal)) return;
      renderSimpleModalError(modal, 'Connecting', err.message);
      return;
    }
    if (!document.body.contains(modal)) return;
    await renderAccountPicker(modal, result, presetPropertyIds, onImported);
  }

  async function renderAccountPicker(modal, exchangeResult, presetPropertyIds, onImported) {
    const properties = await Api.get('/api/properties').catch(() => []);
    if (!document.body.contains(modal)) return;
    const rows = exchangeResult.accounts.map((a, i) => accountPickerRowHtml(a, i, properties, presetPropertyIds)).join('');
    modal.innerHTML =
      '<h2>Choose accounts to add</h2>' +
      '<p class="field-hint">' + (exchangeResult.institutionName ? escapeHtml(exchangeResult.institutionName) + ' returned these accounts. ' : '') + 'Pick which ones to track and which rentals to assign them to.</p>' +
      '<form id="picker-form">' + rows +
      '<div class="modal-actions"><button type="button" class="btn" data-act="cancel">Cancel</button><button type="submit" class="btn primary">Add selected accounts</button></div></form>';
    modal.querySelector('[data-act="cancel"]').addEventListener('click', Modal.close);
    const form = modal.querySelector('#picker-form');
    wireSave(form, async () => {
      const selections = [];
      exchangeResult.accounts.forEach((a, i) => {
        const checkbox = qs('#pick-' + i, modal);
        if (!checkbox.checked) return;
        const nickname = qs('#nick-' + i, modal).value || a.name;
        const propertyIds = qsa('.prop-check-' + i + ':checked', modal).map((el) => Number(el.value));
        selections.push({ externalAccountId: a.externalAccountId, name: a.name, mask: a.mask, balanceType: a.balanceType, balanceCents: a.balanceCents, nickname, propertyIds });
      });
      if (selections.length === 0) throw new Error('Choose at least one account.');
      await Api.post('/api/bank-connections/' + exchangeResult.connectionId + '/import', { selections });
      if (onImported) onImported();
      return 'Bank account' + (selections.length === 1 ? '' : 's') + ' added.';
    }, { savingLabel: 'Adding…' });
  }

  function accountPickerRowHtml(a, i, properties, presetPropertyIds) {
    presetPropertyIds = presetPropertyIds || [];
    return (
      '<div class="card panel" style="margin-bottom:12px;">' +
        '<label style="display:flex;gap:10px;align-items:flex-start;">' +
          '<input type="checkbox" id="pick-' + i + '" checked style="margin-top:4px;">' +
          '<div style="flex:1;">' +
            '<div><strong>' + escapeHtml(a.name) + '</strong>' + (a.mask ? ' <span class="field-hint">••' + escapeHtml(a.mask) + '</span>' : '') + '</div>' +
            '<div class="field-hint">' + centsToDisplay(a.balanceCents) + ' · ' + (a.balanceType === 'available' ? 'Available balance' : 'Current balance') + '</div>' +
            '<div class="field" style="margin-top:8px;"><label>Nickname</label><input id="nick-' + i + '" value="' + escapeHtml(a.name) + '"></div>' +
            (properties.length > 0
              ? '<div class="field-hint" style="margin-bottom:4px;">Assign to:</div>' +
                properties.map((p) => '<label style="display:inline-flex;gap:5px;align-items:center;margin-right:14px;font-size:13px;"><input type="checkbox" class="prop-check-' + i + '" value="' + p.id + '"' + (presetPropertyIds.includes(Number(p.id)) ? ' checked' : '') + '> ' + escapeHtml(p.name) + '</label>').join('')
              : '<p class="field-hint">You don’t have any rentals yet to assign this to.</p>') +
          '</div>' +
        '</label>' +
      '</div>'
    );
  }

  // ---- Reconnect an existing (broken) connection ----

  async function openReconnectFlow(connectionId, { onReconnected }) {
    if (!connectionId) { Toast.show('Nothing to reconnect.', 'error'); return; }
    let status;
    try {
      status = await Api.get('/api/bank-connections/provider-status');
    } catch (err) { Toast.show(err.message, 'error'); return; }
    if (status.mode !== 'live') { Toast.show('Real bank connections are not configured on this server. See the README.', 'error'); return; }

    try {
      await ensurePlaidScript();
      const { linkToken } = await Api.post('/api/bank-connections/' + connectionId + '/reconnect-token', {}, { timeoutMs: 30000 });
      const handler = window.Plaid.create({
        token: linkToken,
        onSuccess: async (publicToken) => {
          try {
            await Api.post('/api/bank-connections/' + connectionId + '/reconnect-exchange', { publicToken }, { timeoutMs: 30000 });
            Toast.show('Bank reconnected.', 'success');
            if (onReconnected) onReconnected();
          } catch (err) {
            Toast.show(err.message, 'error');
          }
        },
        onExit: (err) => { if (err) Toast.show('Reconnect was not completed.', 'info'); },
      });
      handler.open();
    } catch (err) {
      Toast.show(err.message, 'error');
    }
  }

  // ---- Sync / delete / unlink ----

  async function triggerSync(accountId, { onSynced }) {
    try {
      await Api.post('/api/bank-accounts/' + accountId + '/sync', {}, { timeoutMs: 20000 });
      Toast.show('Balance refreshed.', 'success');
    } catch (err) {
      Toast.show(err.message, 'error');
    } finally {
      if (onSynced) onSynced(); // refresh either way — a newly-broken connection's "Reconnect" badge only shows up after a re-render
    }
  }

  async function deleteAccount(account, { onDeleted }) {
    const ok = await confirmDialog('Remove "' + account.nickname + '" entirely? This removes it from every rental it’s linked to. This cannot be undone.', 'Remove account');
    if (!ok) return;
    try {
      await Api.del('/api/bank-accounts/' + account.id);
      Toast.show('Account removed.', 'success');
      if (onDeleted) onDeleted();
    } catch (err) {
      Toast.show(err.message, 'error');
    }
  }

  async function unlinkFromProperty(propertyId, account, { onUnlinked }) {
    const ok = await confirmDialog('Unlink "' + account.nickname + '" from this rental? The account itself, and its other links, will be kept.', 'Unlink');
    if (!ok) return;
    try {
      await Api.del('/api/properties/' + propertyId + '/bank-accounts/' + account.id);
      Toast.show('Account unlinked from this rental.', 'success');
      if (onUnlinked) onUnlinked();
    } catch (err) {
      Toast.show(err.message, 'error');
    }
  }

  function renderSimpleModalError(modal, title, message) {
    modal.innerHTML = '<h2>' + escapeHtml(title) + '</h2><div class="banner error">' + escapeHtml(message) + '</div><div class="modal-actions"><button class="btn" data-act="close">Close</button></div>';
    modal.querySelector('[data-act="close"]').addEventListener('click', Modal.close);
  }

  return {
    render,
    bankAccountRowHtml, wireBankAccountRowActions,
    openLinkChoiceModal, openAddOrEditManualModal,
  };
})();

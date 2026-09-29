// Portfolio dashboard: KPI ledger, search/filter/sort toolbar, property grid.

const DashboardView = (function () {
  let state = { q: '', occupancy: '', rentStatus: '', sort: 'name', dir: 'asc', range: 'month', archived: false };

  function rangeToDates(range) {
    const today = new Date();
    const y = today.getFullYear(), m = today.getMonth();
    function iso(d) { return d.toISOString().slice(0, 10); }
    if (range === 'month') return { start: iso(new Date(Date.UTC(y, m, 1))), end: todayStr() };
    if (range === 'last_month') return { start: iso(new Date(Date.UTC(y, m - 1, 1))), end: iso(new Date(Date.UTC(y, m, 0))) };
    if (range === 'quarter') return { start: iso(new Date(Date.UTC(y, m - 2, 1))), end: todayStr() };
    if (range === 'ytd') return { start: y + '-01-01', end: todayStr() };
    return { start: null, end: null };
  }

  async function render() {
    qs('#view-root').innerHTML = '<div class="loading-block"><span class="spinner-inline"></span> Loading your portfolio…</div>';
    const { start, end } = rangeToDates(state.range);
    const portfolioQuery = start ? ('?start=' + start + '&end=' + end) : '';
    const [portfolio, reminders, sampleStatus] = await Promise.all([
      Api.get('/api/portfolio' + portfolioQuery),
      Api.get('/api/portfolio/reminders'),
      Api.get('/api/sample-data/status'),
    ]);
    await renderWithData(portfolio, reminders, sampleStatus);
  }

  async function renderWithData(portfolio, reminders, sampleStatus) {
    const params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.occupancy) params.set('occupancy', state.occupancy);
    if (state.rentStatus) params.set('rentStatus', state.rentStatus);
    params.set('sort', state.sort); params.set('dir', state.dir);
    if (state.archived) params.set('status', 'archived');
    const properties = await Api.get('/api/properties?' + params.toString());

    qs('#view-root').innerHTML =
      '<div class="page-title">Portfolio</div>' +
      '<div class="page-subtitle">' + portfolio.propertyCount + ' active ' + (portfolio.propertyCount === 1 ? 'property' : 'properties') + ' · ' + Math.round(portfolio.occupancyRate * 100) + '% occupied</div>' +
      renderSampleBanner(sampleStatus) +
      renderLedger(portfolio) +
      renderReminders(reminders) +
      renderToolbar() +
      (properties.length === 0 ? renderEmpty() : '<div class="property-grid" id="property-grid"></div>');

    if (properties.length > 0) {
      const grid = qs('#property-grid');
      grid.innerHTML = properties.map(propertyCardHtml).join('') + (state.archived ? '' : addTileHtml());
      qsa('.property-card', grid).forEach((el) => {
        el.addEventListener('click', () => { location.hash = '#/property/' + el.dataset.id; });
      });
      const addTile = qs('.add-tile', grid);
      if (addTile) addTile.addEventListener('click', openAddPropertyModal);
    }

    wireToolbar(portfolio);
    const removeSampleBtn = qs('#remove-sample-btn');
    if (removeSampleBtn) removeSampleBtn.addEventListener('click', removeSampleData);
  }

  function renderSampleBanner(sampleStatus) {
    if (!sampleStatus || !sampleStatus.hasSampleData) return '';
    const n = sampleStatus.count;
    return (
      '<div class="banner info" style="display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;">' +
        '<span>' + n + ' sample propert' + (n === 1 ? 'y' : 'ies') + ' ' + (n === 1 ? 'is' : 'are') + ' included so you can explore the app — look for the “sample” badge. Remove them any time once you’re adding your own.</span>' +
        '<button class="btn small" id="remove-sample-btn">Remove sample data</button>' +
      '</div>'
    );
  }

  async function removeSampleData() {
    const ok = await confirmDialog(
      'This permanently deletes every sample property along with its photos, documents, leases, and transactions. This cannot be undone.',
      'Remove sample data'
    );
    if (!ok) return;
    try {
      const result = await Api.post('/api/sample-data/remove');
      Toast.show('Removed ' + result.removedProperties + ' sample propert' + (result.removedProperties === 1 ? 'y' : 'ies') + '.', 'success');
      render();
    } catch (err) {
      Toast.show(err.message || 'Could not remove sample data', 'error');
    }
  }

  function renderEmpty() {
    if (state.archived) {
      return '<div class="empty-state"><h3>No archived properties</h3><p>Properties you archive will show up here, fully intact.</p></div>';
    }
    return (
      '<div class="empty-state card panel">' +
        '<h3>No rentals yet</h3>' +
        '<p>Add your first property to start tracking rent, tenants, and cash flow.</p>' +
        '<button class="btn primary" id="empty-add-btn">Add Rental</button>' +
      '</div>'
    );
  }

  // Tone rules (per spec): some metrics are unconditionally colored because
  // of what they ARE (a debt is always red, scheduled/collected rent is
  // always green), independent of their sign. Others (equity, NOI, cash
  // flow) can genuinely go either way, so their tone follows the actual
  // number — and a zero lands neutral either way, per "Neutral: ... zero
  // balances." Never invert the number itself (no minus sign on a positive
  // debt balance just because it's shown in red) — centsToDisplay() already
  // only prints "-" when the underlying cents value is actually negative.
  function signTone(cents) { return cents > 0 ? 'positive' : (cents < 0 ? 'negative' : ''); }
  // For "amount owed/spent" metrics that are never negative themselves
  // (principal, mortgage total, expenses) — red while there's actually
  // something owed/spent, neutral at exactly zero (same "zero balances are
  // neutral" rule signTone applies above, just without a positive/green side,
  // since owing nothing is not a "gain" worth celebrating in green).
  function negativeIfNonzero(cents) { return cents > 0 ? 'negative' : ''; }
  // Mirror image for "money coming in" metrics that are never negative by
  // construction (scheduled rent is a sum of active leases' rent amounts) —
  // green while there's actually something scheduled, neutral at zero (e.g.
  // no active lease yet) rather than a cheerful green $0.00.
  function positiveIfNonzero(cents) { return cents > 0 ? 'positive' : ''; }

  function renderLedger(p) {
    const rangeLabel = { month: 'this month', last_month: 'last month', quarter: 'last 3 months', ytd: 'year to date' }[state.range] || '';
    const mortgageTotalNote = p.monthlyMortgageTotalIsComplete
      ? 'Current obligation, incl. escrow where a loan has it'
      : 'Incomplete — ' + p.mortgagesMissingPaymentCount + ' loan' + (p.mortgagesMissingPaymentCount === 1 ? '' : 's') + ' missing a payment amount';
    return (
      '<div class="ledger">' +
        // Row 1 — property & debt snapshot
        ledgerItem('Estimated value', centsToDisplay(p.estimatedValueCents), 'Latest manual valuations') +
        ledgerItem('Outstanding principal', centsToDisplay(p.outstandingPrincipalCents), 'Across all mortgages', negativeIfNonzero(p.outstandingPrincipalCents)) +
        ledgerItem('Estimated equity', centsToDisplay(p.estimatedEquityCents), 'Value minus principal', signTone(p.estimatedEquityCents)) +
        ledgerItem('Monthly mortgage total', centsToDisplay(p.monthlyMortgageTotalCents), mortgageTotalNote, negativeIfNonzero(p.monthlyMortgageTotalCents)) +
        // Row 2 — rent & tenant money
        ledgerItem('Monthly rental income', centsToDisplay(p.scheduledRentCents), 'Scheduled to bill — not yet collected', positiveIfNonzero(p.scheduledRentCents)) +
        // Net of refunds/reversals within the period (see portfolio.js), so
        // this can legitimately go negative (more refunded than collected) —
        // signTone (not positiveIfNonzero) so that case reads red, not green.
        ledgerItem('Rent collected', centsToDisplay(p.rentCollectedCents), 'Collected, ' + rangeLabel, signTone(p.rentCollectedCents)) +
        ledgerItem('Overdue rent', centsToDisplay(p.overdueRentCents), 'Outstanding on late charges', p.overdueRentCents > 0 ? 'negative' : '') +
        ledgerItem('Security deposits held', centsToDisplay(p.securityDepositsHeldCents), 'Separate from rental income') +
        // Row 3 — expenses, profitability & cash
        ledgerItem('Operating expenses', centsToDisplay(p.operatingExpensesCents), rangeLabel, negativeIfNonzero(p.operatingExpensesCents)) +
        ledgerItem('Net operating income', centsToDisplay(p.netOperatingIncomeCents), 'Excl. debt service & capex', signTone(p.netOperatingIncomeCents)) +
        ledgerItem('Cash flow', centsToDisplay(p.cashFlowCents), 'Incl. mortgage payments', signTone(p.cashFlowCents)) +
        ledgerItem('Cash held', centsToDisplay(p.cashHeldCents), p.linkedAccountCount + ' linked account' + (p.linkedAccountCount === 1 ? '' : 's')) +
      '</div>'
    );
  }
  function ledgerItem(label, value, note, tone) {
    return '<div class="ledger-item"><div class="ledger-label">' + label + '</div><div class="ledger-value' + (tone ? ' ' + tone : '') + ' money">' + value + '</div>' + (note ? '<div class="ledger-note">' + note + '</div>' : '') + '</div>';
  }

  function renderReminders(reminders) {
    if (!reminders || reminders.length === 0) return '';
    const items = reminders.slice(0, 6).map((r) =>
      '<div class="list-row" style="padding:9px 0;"><span>' + escapeHtml(r.title) + (r.propertyName ? ' <span class="field-hint">— ' + escapeHtml(r.propertyName) + '</span>' : '') + '</span><span class="field-hint">' + formatDateShort(r.dueDate) + '</span></div>'
    ).join('');
    return '<div class="card panel" style="margin-bottom:22px;"><div class="section-heading"><h2>Upcoming deadlines</h2></div>' + items + '</div>';
  }

  function renderToolbar() {
    return (
      '<div class="toolbar">' +
        '<input type="search" id="search-input" placeholder="Search by name or address" value="' + escapeHtml(state.q) + '">' +
        '<select id="occupancy-filter">' +
          '<option value="">All occupancy</option>' +
          '<option value="occupied"' + (state.occupancy === 'occupied' ? ' selected' : '') + '>Occupied</option>' +
          '<option value="vacant"' + (state.occupancy === 'vacant' ? ' selected' : '') + '>Vacant</option>' +
        '</select>' +
        '<select id="status-filter">' +
          '<option value="">All rent status</option>' +
          ['upcoming', 'due', 'partial', 'paid', 'late'].map((s) => '<option value="' + s + '"' + (state.rentStatus === s ? ' selected' : '') + '>' + STATUS_LABEL[s] + '</option>').join('') +
        '</select>' +
        '<select id="sort-select">' +
          '<option value="name"' + (state.sort === 'name' ? ' selected' : '') + '>Sort: Name</option>' +
          '<option value="rent"' + (state.sort === 'rent' ? ' selected' : '') + '>Sort: Rent</option>' +
          '<option value="status"' + (state.sort === 'status' ? ' selected' : '') + '>Sort: Status</option>' +
        '</select>' +
        '<select id="range-select">' +
          '<option value="month"' + (state.range === 'month' ? ' selected' : '') + '>This month</option>' +
          '<option value="last_month"' + (state.range === 'last_month' ? ' selected' : '') + '>Last month</option>' +
          '<option value="quarter"' + (state.range === 'quarter' ? ' selected' : '') + '>Last 3 months</option>' +
          '<option value="ytd"' + (state.range === 'ytd' ? ' selected' : '') + '>Year to date</option>' +
        '</select>' +
        '<div class="spacer"></div>' +
        '<button class="btn" id="archived-toggle">' + (state.archived ? 'Back to active' : 'Archived') + '</button>' +
        (state.archived ? '' : '<button class="btn primary" id="add-rental-btn">+ Add Rental</button>') +
      '</div>'
    );
  }

  function wireToolbar() {
    qs('#search-input').addEventListener('input', debounce((e) => { state.q = e.target.value; render(); }, 300));
    qs('#occupancy-filter').addEventListener('change', (e) => { state.occupancy = e.target.value; render(); });
    qs('#status-filter').addEventListener('change', (e) => { state.rentStatus = e.target.value; render(); });
    qs('#sort-select').addEventListener('change', (e) => { state.sort = e.target.value; render(); });
    qs('#range-select').addEventListener('change', (e) => { state.range = e.target.value; render(); });
    qs('#archived-toggle').addEventListener('click', () => { state.archived = !state.archived; render(); });
    const addBtn = qs('#add-rental-btn'); if (addBtn) addBtn.addEventListener('click', openAddPropertyModal);
    const emptyAddBtn = qs('#empty-add-btn'); if (emptyAddBtn) emptyAddBtn.addEventListener('click', openAddPropertyModal);
  }

  function addTileHtml() {
    return '<button class="add-tile card"><span class="plus">+</span><span>Add Rental</span></button>';
  }

  function propertyCardHtml(p) {
    // One row per account (not one shared row for all of them) — a property
    // can have several linked accounts, and cramming every nickname/badge/
    // balance into a single space-between row (as this used to) forces
    // overflow the moment a property has more than one. Each account gets
    // its own label-left/amount-right line instead, wrapping independently.
    const bankLine = p.bankAccounts.length > 0
      ? p.bankAccounts.map((b) =>
          '<div class="bank-line-row"><span class="bank-line-label">' + escapeHtml(b.nickname) +
          (b.isShared ? ' <span class="badge shared">shared</span>' : '') +
          (b.needsReconnect ? ' <span class="badge warn">reconnect</span>' : '') +
          '</span><span class="money">' + centsToDisplay(b.balanceCents) + '</span></div>'
        ).join('')
      : '<div class="bank-line-row"><span>No bank account linked</span><span></span></div>';
    return (
      '<div class="property-card card" data-id="' + p.id + '">' +
        '<div class="photo-wrap">' +
          (p.coverPhotoUrl
            ? '<img src="' + p.coverPhotoUrl + '" style="object-position:' + p.coverFocal.x + '% ' + p.coverFocal.y + '%;" alt="">'
            : '<div class="photo-placeholder">' + escapeHtml(initials(p.name)) + '</div>') +
        '</div>' +
        '<div class="body">' +
          '<div><div class="name">' + escapeHtml(p.name) + (p.isSample ? ' <span class="badge sample">sample</span>' : '') + '</div>' +
          '<div class="addr">' + escapeHtml([p.address.line1, p.address.city, p.address.state].filter(Boolean).join(', ') || 'No address yet') + '</div></div>' +
          '<div class="tenant-line">' + (p.currentTenant ? escapeHtml(p.currentTenant.name) : (p.status === 'archived' ? 'Archived' : 'Vacant')) + '</div>' +
          '<div class="row"><span class="rent money">' + centsToDisplay(p.monthlyRentCents) + '<span style="font-size:11px;font-family:var(--sans);color:var(--ink-soft)"> /mo</span></span>' +
            (p.hasNoLeaseYet ? '<span class="field-hint">No lease</span>' : statusPill(p.rentStatus)) +
          '</div>' +
          (p.currentCharge && p.currentCharge.status !== 'paid' ? '<div class="field-hint">' + centsToDisplay(p.currentCharge.outstandingCents) + ' outstanding</div>' : '') +
          (p.olderOutstandingCents > 0 ? '<div class="field-hint" style="color:var(--late)">+' + centsToDisplay(p.olderOutstandingCents) + ' from earlier periods</div>' : '') +
          '<div class="bank-line">' + bankLine + '</div>' +
        '</div>' +
      '</div>'
    );
  }

  function initials(name) {
    return (name || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  }

  function openAddPropertyModal() {
    const modal = Modal.open(
      '<h2>Add a rental</h2>' +
      '<form id="add-property-form">' +
        '<div class="field"><label>Property name</label><input name="name" required placeholder="e.g. 412 Birchwood Ave"></div>' +
        '<div class="field"><label>Address line 1</label><input name="addressLine1"></div>' +
        '<div class="field-row">' +
          '<div class="field"><label>City</label><input name="city"></div>' +
          '<div class="field"><label>State</label><input name="state" maxlength="2" style="text-transform:uppercase"></div>' +
          '<div class="field"><label>ZIP</label><input name="zip"></div>' +
        '</div>' +
        '<div class="field"><label>Timezone</label>' +
          '<select name="timezone">' +
            ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu'].map((tz) =>
              '<option value="' + tz + '"' + (tz === 'America/Denver' ? ' selected' : '') + '>' + tz.replace('_', ' ') + '</option>').join('') +
          '</select>' +
          '<span class="field-hint">Used to compute due/late dates and "today" correctly for this property.</span>' +
        '</div>' +
        '<div id="add-property-error"></div>' +
        '<div class="modal-actions"><button type="button" class="btn" data-act="cancel">Cancel</button><button type="submit" class="btn primary">Add rental</button></div>' +
      '</form>'
    );
    modal.querySelector('[data-act="cancel"]').addEventListener('click', Modal.close);
    modal.querySelector('#add-property-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = qs('button[type=submit]', e.target);
      setButtonBusy(btn, true, 'Adding…');
      try {
        const created = await Api.post('/api/properties', formData(e.target));
        Modal.close();
        Toast.show('Rental added.', 'success');
        location.hash = '#/property/' + created.id;
      } catch (err) {
        qs('#add-property-error').innerHTML = '<div class="banner error">' + escapeHtml(err.message) + '</div>';
        setButtonBusy(btn, false);
      }
    });
  }

  return { render };
})();

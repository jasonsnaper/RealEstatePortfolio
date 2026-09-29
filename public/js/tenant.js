// Tenant portal — the page a renter lands on from a copied payment link
// (/pay/link/:token). No owner session exists here at all: every fact on
// this page comes from the token-scoped /api/portal/:token/* endpoints,
// which are already built server-side to return an explicit allowlist of
// fields (see server/routes/tenantPortal.js). This file just renders what
// those endpoints return — it never has access to bank accounts, mortgage
// details, valuations, or owner notes, so there's nothing here that could
// leak them even by mistake.
//
// The payment flow follows the same rule as the rest of the app: the
// browser never marks anything paid. Clicking through the simulated
// checkout only opens a session; the UI then polls the server, and only a
// verified webhook write (checked via that poll) ever flips a charge to
// "paid". See openPaymentCard()/startPolling() below.

let PORTAL_TOKEN = null;
let PORTAL_DATA = null;

function getTokenFromUrl() {
  const m = location.pathname.match(/\/pay\/link\/([^/?#]+)/);
  return m ? m[1] : null;
}

async function boot() {
  PORTAL_TOKEN = getTokenFromUrl();
  if (!PORTAL_TOKEN) {
    renderProblem('This payment link is missing or malformed. Please use the exact link your landlord sent you.');
    return;
  }
  await loadAndRender();
}

async function loadAndRender() {
  try {
    PORTAL_DATA = await Api.get('/api/portal/' + PORTAL_TOKEN);
  } catch (err) {
    renderProblem(err.message || 'This payment link could not be loaded.');
    return;
  }
  document.title = PORTAL_DATA.property.name + ' — Tenant Portal';
  renderTopbar();
  render();
}

function renderTopbar() {
  qs('#topbar-root').innerHTML =
    '<div class="topbar">' +
      '<span class="brand"><span class="mark"></span>Rental Portfolio</span>' +
      '<nav><span>' + escapeHtml(PORTAL_DATA.property.name) + '</span></nav>' +
    '</div>';
}

function renderProblem(message) {
  qs('#topbar-root').innerHTML = '';
  qs('#view-root').innerHTML =
    '<div style="max-width:420px;margin:70px auto 0;">' +
      '<div style="text-align:center;margin-bottom:24px;">' +
        '<div style="width:40px;height:40px;background:var(--ink);border-radius:6px;margin:0 auto 14px;"></div>' +
        '<h1 style="font-size:22px;">Rental Portfolio</h1>' +
      '</div>' +
      '<div class="card panel" style="text-align:center;">' +
        '<p style="margin:0;color:var(--ink-soft);">' + escapeHtml(message) + '</p>' +
      '</div>' +
    '</div>';
}

function addressLine(addr) {
  return [addr.line1, addr.line2, [addr.city, addr.state].filter(Boolean).join(', '), addr.zip].filter(Boolean).join(' · ');
}

function render() {
  const p = PORTAL_DATA;
  const charges = p.charges; // newest period first, per the API
  const target = charges.find((c) => c.status !== 'paid') || null;
  const otherUnpaid = charges.filter((c) => c.status !== 'paid' && c !== target);

  qs('#view-root').innerHTML =
    '<h1 class="page-title">' + escapeHtml(p.property.name) + '</h1>' +
    '<p class="page-subtitle">' + escapeHtml(addressLine(p.property.address)) + '</p>' +
    '<div id="payment-card"></div>' +
    (otherUnpaid.length
      ? '<div class="banner warn">You also have ' + otherUnpaid.length + ' earlier unpaid period' + (otherUnpaid.length > 1 ? 's' : '') +
        ' totaling ' + centsToDisplay(sumCentsLocal(otherUnpaid.map((c) => c.outstandingCents))) + '. ' +
        'This link collects payment for the ' + escapeHtml(periodLabel(target)) + ' charge only — contact your landlord about the rest.</div>'
      : '') +
    '<div class="section-heading"><h2>Charges &amp; payment history</h2></div>' +
    renderChargesTable(charges) +
    '<div class="section-heading" style="margin-top:30px;"><h2>Your lease</h2></div>' +
    renderLeaseFacts(p.lease) +
    '<div class="section-heading" style="margin-top:30px;"><h2>Shared documents</h2></div>' +
    '<div id="documents-section" class="card panel"><div class="loading-block"><span class="spinner-inline"></span> Loading…</div></div>' +
    '<div class="section-heading" style="margin-top:30px;">' +
      '<h2>Maintenance</h2>' +
      '<button class="btn primary small" id="new-maintenance-btn">Submit a request</button>' +
    '</div>' +
    '<div id="maintenance-section"><div class="loading-block"><span class="spinner-inline"></span> Loading…</div></div>';

  renderPaymentCard(target);
  qsa('[data-charge-history]').forEach((btn) => btn.addEventListener('click', () => openHistoryModal(charges.find((c) => String(c.id) === btn.dataset.chargeHistory))));
  qs('#new-maintenance-btn').addEventListener('click', openMaintenanceModal);
  loadDocuments();
  loadMaintenance();
}

function sumCentsLocal(values) { return values.reduce((t, v) => t + (Number(v) || 0), 0); }

function periodLabel(charge) {
  if (!charge) return '';
  return formatDateShort(charge.periodStart) + ' – ' + formatDateShort(charge.periodEnd);
}

// ---------------------------------------------------------------------------
// Charges table + per-charge payment history modal
// ---------------------------------------------------------------------------

function renderChargesTable(charges) {
  if (charges.length === 0) {
    return '<div class="card panel empty-state"><h3>No charges yet</h3><p>Nothing has been billed on this lease yet.</p></div>';
  }
  const rows = charges.map((c) => (
    '<tr>' +
      '<td>' + escapeHtml(periodLabel(c)) + '</td>' +
      '<td>' + formatDateShort(c.dueDate) + '</td>' +
      '<td class="money">' + centsToDisplay(c.amountCents) + '</td>' +
      '<td class="money">' + centsToDisplay(c.paidCents) + '</td>' +
      '<td class="money">' + centsToDisplay(c.outstandingCents) + '</td>' +
      '<td>' + statusPill(c.status) + '</td>' +
      '<td><button class="btn small" data-charge-history="' + c.id + '">History</button></td>' +
    '</tr>'
  )).join('');
  return (
    '<div class="card table-wrap">' +
      '<table>' +
        '<thead><tr><th>Period</th><th>Due</th><th>Amount</th><th>Paid</th><th>Outstanding</th><th>Status</th><th></th></tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
      '</table>' +
    '</div>'
  );
}

function openHistoryModal(charge) {
  if (!charge) return;
  const rows = charge.payments.length
    ? charge.payments.map((p) => (
        '<div class="list-row">' +
          '<span>' + formatDate(p.paidAt) + ' · ' + escapeHtml(p.method || p.type) + '</span>' +
          '<span class="money">' + centsToDisplay(p.amountCents) + '</span>' +
          '<span>' + escapeHtml(p.status) + '</span>' +
        '</div>'
      )).join('')
    : '<p style="color:var(--ink-soft);">No payments recorded for this period yet.</p>';
  Modal.open(
    '<h2>' + escapeHtml(periodLabel(charge)) + '</h2>' +
    '<div class="facts-grid" style="margin-bottom:18px;">' +
      '<div class="fact"><div class="fact-label">Amount</div><div class="fact-value">' + centsToDisplay(charge.amountCents) + '</div></div>' +
      '<div class="fact"><div class="fact-label">Paid</div><div class="fact-value">' + centsToDisplay(charge.paidCents) + '</div></div>' +
      '<div class="fact"><div class="fact-label">Outstanding</div><div class="fact-value">' + centsToDisplay(charge.outstandingCents) + '</div></div>' +
    '</div>' +
    rows +
    '<div class="modal-actions"><button class="btn" id="close-history">Close</button></div>'
  );
  qs('#close-history').addEventListener('click', Modal.close);
}

// ---------------------------------------------------------------------------
// Payment card — a small self-contained state machine: idle -> reviewed ->
// waiting -> succeeded/failed. Re-renders only its own container so the rest
// of the page (charges table, documents, etc.) isn't disturbed while a
// payment is in flight.
// ---------------------------------------------------------------------------

let activePoller = null;

function renderPaymentCard(target) {
  const container = qs('#payment-card');
  if (!target) {
    container.innerHTML =
      '<div class="card panel" style="margin-bottom:24px;">' +
        '<div class="banner success" style="margin:0;">You’re all paid up — nothing is due right now.</div>' +
      '</div>';
    return;
  }
  paintPaymentCard(container, { phase: 'idle', target });
}

function paintPaymentCard(container, s) {
  const target = s.target;
  const provider = PORTAL_DATA.provider;
  let inner = '<div class="section-heading"><h2>Make a payment</h2><span class="badge">' + escapeHtml(periodLabel(target)) + '</span></div>';

  if (provider.mode === 'test') {
    inner += '<div class="banner info">' + escapeHtml(provider.notice) + '</div>';
  }

  if (s.phase === 'idle') {
    const defaultDollars = (target.outstandingCents / 100).toFixed(2);
    inner +=
      '<div class="field-row" style="align-items:flex-end;">' +
        '<div class="field"><label>Amount due</label><div class="fact-value">' + centsToDisplay(target.outstandingCents) + '</div></div>' +
        '<div class="field"><label>Amount to pay</label><input id="pay-amount" type="number" step="0.01" min="0.01" max="' + (target.outstandingCents / 100).toFixed(2) + '" value="' + defaultDollars + '"></div>' +
        '<div class="field"><button class="btn primary" id="review-btn" type="button">Review payment</button></div>' +
      '</div>' +
      '<p class="field-hint">You can pay less than the full amount if you need to make a partial payment.</p>';
    container.innerHTML = '<div class="card panel" style="margin-bottom:24px;">' + inner + '</div>';
    qs('#review-btn').addEventListener('click', async () => {
      const btn = qs('#review-btn');
      const amountStr = qs('#pay-amount').value;
      if (!amountStr || Number(amountStr) <= 0) { Toast.show('Enter an amount greater than $0', 'error'); return; }
      setButtonBusy(btn, true, 'Preparing…');
      try {
        const session = await Api.post('/api/portal/' + PORTAL_TOKEN + '/checkout', { amount: amountStr });
        paintPaymentCard(container, { phase: 'reviewed', target, session });
      } catch (err) {
        Toast.show(err.message || 'Could not start checkout', 'error');
        setButtonBusy(btn, false);
      }
    });
    return;
  }

  if (s.phase === 'reviewed') {
    const session = s.session;
    inner +=
      '<div class="facts-grid" style="margin-bottom:16px;">' +
        '<div class="fact"><div class="fact-label">Rent payment</div><div class="fact-value">' + centsToDisplay(session.amountCents) + '</div></div>' +
        '<div class="fact"><div class="fact-label">Processing fee</div><div class="fact-value">' + centsToDisplay(session.feeCents) + '</div></div>' +
        '<div class="fact"><div class="fact-label">Total charge</div><div class="fact-value">' + centsToDisplay(session.totalCents) + '</div></div>' +
      '</div>' +
      '<p class="field-hint">The processing fee is charged by the payment provider, not your landlord. Reviewing this does not charge you anything yet.</p>' +
      '<div class="btn-row">' +
        '<button class="btn" id="cancel-review-btn" type="button">Change amount</button>' +
        '<button class="btn primary" id="confirm-pay-btn" type="button">Continue to secure payment →</button>' +
      '</div>';
    container.innerHTML = '<div class="card panel" style="margin-bottom:24px;">' + inner + '</div>';
    qs('#cancel-review-btn').addEventListener('click', () => paintPaymentCard(container, { phase: 'idle', target }));
    qs('#confirm-pay-btn').addEventListener('click', () => {
      window.open(session.checkoutUrl, 'checkout_' + session.sessionId, 'width=460,height=720');
      paintPaymentCard(container, { phase: 'waiting', target, session });
    });
    return;
  }

  if (s.phase === 'waiting') {
    const session = s.session;
    inner +=
      '<div class="banner info"><span class="spinner-inline" style="margin-right:8px;"></span>Waiting for payment confirmation… this page will update on its own once the payment provider confirms it.</div>' +
      '<div class="btn-row">' +
        '<button class="btn" id="reopen-btn" type="button">Reopen payment window</button>' +
        '<button class="btn" id="check-now-btn" type="button">Check status now</button>' +
      '</div>';
    container.innerHTML = '<div class="card panel" style="margin-bottom:24px;">' + inner + '</div>';
    qs('#reopen-btn').addEventListener('click', () => window.open(session.checkoutUrl, 'checkout_' + session.sessionId, 'width=460,height=720'));
    qs('#check-now-btn').addEventListener('click', () => { if (activePoller) activePoller.checkNow(); });

    activePoller = startPolling(session.sessionId, (update) => {
      if (update.error) { Toast.show(update.error, 'error'); return; }
      if (update.timedOut) {
        paintPaymentCard(container, { phase: 'waiting', target, session });
        Toast.show('Still waiting on confirmation — you can keep this page open or check back later.', 'info');
        return;
      }
      const sess = update.session;
      if (sess.status === 'succeeded') {
        paintPaymentCard(container, { phase: 'succeeded', target, session: sess });
        loadAndRender(); // refresh charges/history now that the balance has changed
      } else if (sess.status === 'failed') {
        paintPaymentCard(container, { phase: 'failed', target, session: sess });
      }
    });
    return;
  }

  if (s.phase === 'succeeded') {
    inner += '<div class="banner success" style="margin:0;">Payment of ' + centsToDisplay(s.session.totalCents) + ' confirmed. Your balance has been updated below.</div>';
    container.innerHTML = '<div class="card panel" style="margin-bottom:24px;">' + inner + '</div>';
    return;
  }

  if (s.phase === 'failed') {
    inner +=
      '<div class="banner error" style="margin-bottom:16px;">Payment declined. No charge was made.</div>' +
      '<button class="btn primary" id="retry-btn" type="button">Try again</button>';
    container.innerHTML = '<div class="card panel" style="margin-bottom:24px;">' + inner + '</div>';
    qs('#retry-btn').addEventListener('click', () => paintPaymentCard(container, { phase: 'idle', target }));
  }
}

function startPolling(sessionId, onUpdate) {
  let timer = null;
  let cancelled = false;
  const startedAt = Date.now();
  async function checkOnce() {
    if (cancelled) return;
    clearTimeout(timer);
    let session;
    try {
      session = await Api.get('/api/portal/' + PORTAL_TOKEN + '/sessions/' + sessionId);
    } catch (err) {
      onUpdate({ error: err.message });
      return;
    }
    if (cancelled) return;
    onUpdate({ session });
    if (session.status === 'succeeded' || session.status === 'failed') return;
    if (Date.now() - startedAt > 5 * 60 * 1000) { onUpdate({ timedOut: true }); return; }
    timer = setTimeout(checkOnce, 2000);
  }
  checkOnce();
  return {
    checkNow: () => { clearTimeout(timer); checkOnce(); },
    stop: () => { cancelled = true; clearTimeout(timer); },
  };
}

// The simulated checkout page posts a message to window.opener the moment
// it reaches a terminal status. We treat that only as a hint to poll
// immediately — the actual status still comes from our own verified poll of
// the server, never from the message payload itself.
window.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'mock-payment-complete' && activePoller) activePoller.checkNow();
});

// ---------------------------------------------------------------------------
// Lease facts
// ---------------------------------------------------------------------------

function renderLeaseFacts(lease) {
  const fact = (label, value) => '<div class="fact"><div class="fact-label">' + label + '</div><div class="fact-value small">' + value + '</div></div>';
  const lateFee = lease.lateFeeEnabled
    ? (lease.lateFeeType === 'flat' ? centsToDisplay(lease.lateFeeAmountCents) + ' flat' : (lease.lateFeeAmountCents / 100) + '% of rent')
    : 'Disabled';
  return (
    '<div class="facts-grid">' +
      fact('Tenant', escapeHtml(lease.tenantName) + (lease.coTenantName ? '<br>' + escapeHtml(lease.coTenantName) : '')) +
      fact('Lease term', formatDateShort(lease.startDate) + ' – ' + (lease.endDate ? formatDateShort(lease.endDate) : 'ongoing')) +
      fact('Monthly rent', centsToDisplay(lease.currentRentCents)) +
      fact('Deposit required', centsToDisplay(lease.depositRequiredCents)) +
      fact('Deposit held', centsToDisplay(lease.depositHeldCents)) +
      fact('Rent due', 'Day ' + lease.dueDay + ' of each month') +
      fact('Late after', lease.lateAfterDays + ' days past due') +
      fact('Late fee', lateFee) +
    '</div>'
  );
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

async function loadDocuments() {
  const el = qs('#documents-section');
  if (!el) return;
  let docs;
  try {
    docs = await Api.get('/api/portal/' + PORTAL_TOKEN + '/documents');
  } catch (err) {
    el.innerHTML = '<div class="banner error" style="margin:0;">Could not load documents: ' + escapeHtml(err.message) + '</div>';
    return;
  }
  if (docs.length === 0) {
    el.innerHTML = '<div class="empty-state"><h3>No shared documents yet</h3><p>Your landlord hasn’t shared any documents with you yet.</p></div>';
    return;
  }
  el.className = 'card table-wrap';
  el.innerHTML =
    '<table><thead><tr><th>Document</th><th>Category</th><th></th></tr></thead><tbody>' +
    docs.map((d) => (
      '<tr><td>' + escapeHtml(d.filename) + '</td><td>' + escapeHtml(d.category || '—') + '</td>' +
      '<td><a class="btn small" href="' + d.url + '" target="_blank" rel="noopener">Download</a></td></tr>'
    )).join('') +
    '</tbody></table>';
}

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

const PRIORITY_LABEL = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' };

async function loadMaintenance() {
  const el = qs('#maintenance-section');
  if (!el) return;
  let rows;
  try {
    rows = await Api.get('/api/portal/' + PORTAL_TOKEN + '/maintenance');
  } catch (err) {
    el.innerHTML = '<div class="banner error">Could not load maintenance requests: ' + escapeHtml(err.message) + '</div>';
    return;
  }
  if (rows.length === 0) {
    el.innerHTML = '<div class="card panel empty-state"><h3>No maintenance requests</h3><p>Submit one if something needs attention.</p></div>';
    return;
  }
  el.innerHTML = rows.map((r) => (
    '<div class="card panel" style="margin-bottom:14px;">' +
      '<div class="section-heading" style="margin-bottom:8px;">' +
        '<h3 style="font-size:16px;font-family:var(--sans);font-weight:600;">' + escapeHtml(r.title) + '</h3>' +
        '<span class="badge">' + (PRIORITY_LABEL[r.priority] || r.priority) + '</span>' +
      '</div>' +
      (r.description ? '<p style="color:var(--ink-soft);">' + escapeHtml(r.description) + '</p>' : '') +
      '<p style="font-size:13px;color:var(--ink-faint);">Status: ' + escapeHtml(r.status) + ' · Submitted ' + formatDateTime(r.createdAt) +
        (r.scheduledDate ? ' · Scheduled ' + formatDateShort(r.scheduledDate) : '') +
        (r.completedDate ? ' · Completed ' + formatDateShort(r.completedDate) : '') + '</p>' +
      (r.photos.length ? '<div class="photo-grid">' + r.photos.map((p) => '<div class="photo-tile"><img src="' + p.url + '" loading="lazy"></div>').join('') + '</div>' : '') +
    '</div>'
  )).join('');
}

function openMaintenanceModal() {
  const modal = Modal.open(
    '<h2>Submit a maintenance request</h2>' +
    '<form id="maint-form">' +
      '<div class="field"><label>What needs attention?</label><input name="title" required></div>' +
      '<div class="field"><label>Details (optional)</label><textarea name="description" placeholder="Where is it, when did you notice it, anything the landlord should know"></textarea></div>' +
      '<div class="field"><label>Photos (optional)</label><input type="file" id="maint-photos" accept="image/*" multiple></div>' +
      '<div id="maint-error"></div>' +
      '<div class="modal-actions">' +
        '<button class="btn" type="button" id="maint-cancel">Cancel</button>' +
        '<button class="btn primary" type="submit">Submit request</button>' +
      '</div>' +
    '</form>'
  );
  qs('#maint-cancel', modal).addEventListener('click', Modal.close);
  qs('#maint-form', modal).addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = qs('button[type=submit]', e.target);
    setButtonBusy(btn, true, 'Submitting…');
    try {
      const fields = formData(e.target);
      const files = Array.from(qs('#maint-photos', modal).files || []);
      const images = [];
      for (const file of files) images.push(await compressImage(file));
      await Api.post('/api/portal/' + PORTAL_TOKEN + '/maintenance', { title: fields.title, description: fields.description, images });
      Modal.close();
      Toast.show('Request submitted', 'success');
      loadMaintenance();
    } catch (err) {
      qs('#maint-error').innerHTML = '<div class="banner error">' + escapeHtml(err.message) + '</div>';
      setButtonBusy(btn, false);
    }
  });
}

boot();

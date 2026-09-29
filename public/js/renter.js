// Renter portal — the authenticated app a renter signs into directly (as
// opposed to public/js/tenant.js, the unauthenticated single-link page a
// renter reaches from a copied payment link). Every fact here comes from the
// /api/renter/* endpoints, which are already scoped server-side to exactly
// the leases this renter is linked to (see server/lib/renterAccess.js) — this
// file just renders what those return.
//
// Route map (hash-based, like public/js/app.js):
//   '#/login', '#/forgot-password', '#/reset-password/:token',
//   '#/accept-invite/:token'  -- public, rendered before any auth check
//   '#/' or '#/leases'        -- the lease list/switcher
//   '#/lease/:id[/:tab]'      -- one lease's dashboard; tab is one of
//                                overview|documents|maintenance|statements

let ME = null;
let LEASES = null;
let routerAttached = false;

const PUBLIC_VIEWS = ['login', 'forgot-password', 'reset-password', 'accept-invite'];

function parseHash() {
  const path = location.hash.replace(/^#\/?/, '');
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === 'accept-invite' && parts[1]) return { view: 'accept-invite', token: parts[1] };
  if (parts[0] === 'forgot-password') return { view: 'forgot-password' };
  if (parts[0] === 'reset-password' && parts[1]) return { view: 'reset-password', token: parts[1] };
  if (parts[0] === 'login') return { view: 'login' };
  if (parts[0] === 'lease' && parts[1]) return { view: 'lease', id: parts[1], tab: parts[2] || 'overview' };
  return { view: 'leases' };
}

async function boot() {
  // Attached unconditionally, from the very first load — not just after
  // signing in — because a hash-only change (login -> #/accept-invite/:token,
  // or #/login -> #/forgot-password) never triggers a full page navigation,
  // so nothing else would notice the URL changed while still signed out.
  attachRouter();

  const parsed = parseHash();
  if (parsed.view === 'accept-invite') return renderAcceptInvite(parsed.token);
  if (parsed.view === 'forgot-password') return renderForgotPassword();
  if (parsed.view === 'reset-password') return renderResetPassword(parsed.token);

  try {
    ME = await Api.get('/api/renter/me');
  } catch (err) {
    if (err instanceof Api.ApiError && err.status === 401) { ME = null; renderLogin(); return; }
    renderFatalError(err);
    return;
  }
  try {
    LEASES = await Api.get('/api/renter/leases');
  } catch (err) {
    renderFatalError(err);
    return;
  }
  route();
}

function attachRouter() {
  if (routerAttached) return;
  routerAttached = true;
  // A public-view hash (or no confirmed session yet) needs the full boot()
  // sequence re-run — it decides afresh whether that hash is even reachable
  // right now. Only once signed in, with lease data already cached, is a
  // plain route() (no re-fetch) enough for moving between lease/tab hashes.
  window.addEventListener('hashchange', () => {
    const parsed = parseHash();
    if (!ME || PUBLIC_VIEWS.includes(parsed.view)) { boot(); return; }
    route();
  });
}

function route() {
  const parsed = parseHash();
  if (PUBLIC_VIEWS.includes(parsed.view)) { location.hash = '#/'; return; } // already signed in — hashchange re-fires route()
  if (parsed.view === 'leases' && LEASES.length === 1) { location.hash = '#/lease/' + LEASES[0].id; return; }

  if (parsed.view === 'lease') {
    const lease = LEASES.find((l) => String(l.id) === String(parsed.id));
    if (!lease) { renderTopbar(); renderNotFound(); return; }
    renderTopbar(lease);
    renderLeaseDashboard(lease, parsed.tab);
    return;
  }
  renderTopbar();
  renderLeaseList();
}

async function refreshLeasesAndRoute() {
  try {
    LEASES = await Api.get('/api/renter/leases');
  } catch (err) {
    renderFatalError(err);
    return;
  }
  route();
}

function renderFatalError(err) {
  qs('#topbar-root').innerHTML = '';
  qs('#view-root').innerHTML =
    '<div class="banner error" style="max-width:520px;margin:60px auto;">' +
      'Could not reach the server: ' + escapeHtml(err && err.message ? err.message : 'unknown error') + '. ' +
      'Check your connection and reload the page.' +
    '</div>';
}

function renderNotFound() {
  qs('#view-root').innerHTML =
    '<div class="empty-state"><h3>Lease not found</h3><p>That lease isn’t linked to your account. ' +
    '<a href="#/">Back to your leases</a></p></div>';
}

// ---------------------------------------------------------------------------
// Topbar + sign out
// ---------------------------------------------------------------------------

function renderTopbar(currentLease) {
  const switcher = (LEASES && LEASES.length > 1)
    ? '<select id="lease-switcher">' +
        LEASES.map((l) => (
          '<option value="' + l.id + '"' + (currentLease && String(currentLease.id) === String(l.id) ? ' selected' : '') + '>' +
            escapeHtml(l.property.name) + (l.status === 'ended' ? ' (ended)' : '') +
          '</option>'
        )).join('') +
      '</select>'
    : (currentLease ? '<span>' + escapeHtml(currentLease.property.name) + '</span>' : '');

  qs('#topbar-root').innerHTML =
    '<div class="topbar">' +
      '<a href="#/" class="brand"><span class="mark"></span>Renter Portal</a>' +
      '<nav>' +
        switcher +
        '<span class="topbar-owner-name">' + escapeHtml((ME && (ME.name || ME.email)) || '') + '</span>' +
        '<button class="link" id="sign-out-btn" type="button">Sign out</button>' +
      '</nav>' +
    '</div>';
  const sw = qs('#lease-switcher');
  if (sw) sw.addEventListener('change', () => { location.hash = '#/lease/' + sw.value; });
  qs('#sign-out-btn').addEventListener('click', signOut);
}

async function signOut() {
  try { await Api.post('/api/renter/logout'); } catch (e) { /* sign out locally regardless */ }
  ME = null; LEASES = null;
  location.hash = '';
  boot(); // setting the hash to '' when it's already '' fires no hashchange event, so boot() is called directly
}

// ---------------------------------------------------------------------------
// Public screens: login, forgot/reset password, accept invite
// ---------------------------------------------------------------------------

function authShell(innerHtml) {
  qs('#topbar-root').innerHTML = '';
  qs('#view-root').innerHTML =
    '<div style="max-width:420px;margin:60px auto 0;">' +
      '<div style="text-align:center;margin-bottom:28px;">' +
        '<div style="width:40px;height:40px;background:var(--ink);border-radius:6px;margin:0 auto 14px;"></div>' +
        '<h1 style="font-size:24px;">Renter Portal</h1>' +
      '</div>' +
      '<div class="card panel">' + innerHtml + '</div>' +
    '</div>';
}

function renderLogin() {
  authShell(
    '<h2 style="margin-bottom:18px;">Sign in</h2>' +
    '<form id="login-form">' +
      '<div class="field"><label>Email</label><input name="email" type="email" required autocomplete="email"></div>' +
      '<div class="field"><label>Password</label><input name="password" type="password" required autocomplete="current-password"></div>' +
      '<div id="login-error"></div>' +
      '<button class="btn primary" style="width:100%;justify-content:center;" type="submit">Sign in</button>' +
    '</form>' +
    '<div style="text-align:center;margin-top:14px;">' +
      '<a href="#/forgot-password" style="font-size:13px;color:var(--ink-soft);">Forgot password?</a>' +
    '</div>' +
    '<p class="field-hint" style="text-align:center;margin-top:18px;">Your landlord invites you to this portal — there’s no self-service sign-up here.</p>'
  );
  qs('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = qs('button[type=submit]', e.target);
    if (btn.disabled) return;
    setButtonBusy(btn, true, 'Signing in…');
    try {
      await Api.post('/api/renter/login', formData(e.target));
      location.hash = '';
      boot();
    } catch (err) {
      qs('#login-error').innerHTML = '<div class="banner error">' + escapeHtml(describeApiError(err)) + '</div>';
      setButtonBusy(btn, false);
    }
  });
}

function renderForgotPassword() {
  authShell(
    '<h2 style="margin-bottom:6px;">Reset password</h2>' +
    '<p class="field-hint" style="margin-bottom:18px;">No email sending is configured for this install, so ask your landlord for the reset link they see in the server console/logs — or paste a code below if you already have one.</p>' +
    '<form id="forgot-form">' +
      '<div class="field"><label>Email</label><input name="email" type="email" required></div>' +
      '<div id="forgot-msg"></div>' +
      '<button class="btn primary" style="width:100%;justify-content:center;" type="submit">Request reset link</button>' +
    '</form>' +
    '<div style="text-align:center;margin-top:14px;">' +
      '<a href="#" id="have-code" style="font-size:13px;color:var(--ink-soft);">I have a reset code</a> · ' +
      '<a href="#/login" style="font-size:13px;color:var(--ink-soft);">Back to sign in</a>' +
    '</div>'
  );
  qs('#forgot-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = qs('button[type=submit]', e.target);
    if (btn.disabled) return;
    const { email } = formData(e.target);
    setButtonBusy(btn, true, 'Sending…');
    try {
      const res = await Api.post('/api/renter/forgot-password', { email });
      qs('#forgot-msg').innerHTML = '<div class="banner info">' + escapeHtml(res.message) + '</div>';
    } catch (err) {
      qs('#forgot-msg').innerHTML = '<div class="banner error">' + escapeHtml(describeApiError(err)) + '</div>';
    } finally {
      setButtonBusy(btn, false);
    }
  });
  qs('#have-code').addEventListener('click', (e) => { e.preventDefault(); renderResetPassword(); });
}

// token is optional here — the manual "I have a reset code" path lets someone
// paste either the bare token or a full .../renter#/reset-password/<token>
// link their landlord relayed to them.
function renderResetPassword(token) {
  authShell(
    '<h2 style="margin-bottom:18px;">Enter reset code</h2>' +
    '<form id="reset-form">' +
      (token ? '' : '<div class="field"><label>Reset code or link</label><input name="code" required placeholder="Paste the code or full link"></div>') +
      '<div class="field"><label>New password</label><input name="newPassword" type="password" required minlength="8"></div>' +
      '<div id="reset-msg"></div>' +
      '<button class="btn primary" style="width:100%;justify-content:center;" type="submit">Update password</button>' +
    '</form>'
  );
  qs('#reset-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = qs('button[type=submit]', e.target);
    if (btn.disabled) return;
    const fields = formData(e.target);
    const raw = token || fields.code || '';
    const resolvedToken = raw.includes('/') ? raw.split('/').filter(Boolean).pop() : raw.trim();
    setButtonBusy(btn, true, 'Updating…');
    try {
      const res = await Api.post('/api/renter/reset-password', { token: resolvedToken, newPassword: fields.newPassword });
      qs('#reset-msg').innerHTML = '<div class="banner success">' + escapeHtml(res.message) + '</div>';
      setTimeout(() => { location.hash = '#/login'; renderLogin(); }, 1200);
    } catch (err) {
      qs('#reset-msg').innerHTML = '<div class="banner error">' + escapeHtml(describeApiError(err)) + '</div>';
      setButtonBusy(btn, false);
    }
  });
}

async function renderAcceptInvite(token) {
  authShell('<div class="loading-block"><span class="spinner-inline"></span> Loading invitation…</div>');
  let preview;
  try {
    preview = await Api.get('/api/renter/invite/' + encodeURIComponent(token));
  } catch (err) {
    authShell(
      '<div class="banner error">' + escapeHtml(describeApiError(err)) + '</div>' +
      '<div style="text-align:center;margin-top:10px;"><a href="#/login">Back to sign in</a></div>'
    );
    return;
  }
  authShell(
    '<h2 style="margin-bottom:4px;">You’re invited</h2>' +
    '<p class="field-hint" style="margin-bottom:18px;">' +
      escapeHtml(preview.renterName) + ', you’ve been invited to ' +
      (preview.propertyName ? 'the renter portal for <strong>' + escapeHtml(preview.propertyName) + '</strong>' : 'the renter portal') +
      '. Set a password to finish setting up your account.' +
    '</p>' +
    (preview.alreadyHasAccount ? '<div class="banner warn">You already have a portal account — setting a password here will replace it.</div>' : '') +
    '<form id="accept-form">' +
      '<div class="field"><label>Password</label><input name="password" type="password" required minlength="8" autocomplete="new-password">' +
        '<span class="field-hint">At least 8 characters.</span></div>' +
      '<div id="accept-error"></div>' +
      '<button class="btn primary" style="width:100%;justify-content:center;" type="submit">Set password & sign in</button>' +
    '</form>'
  );
  qs('#accept-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = qs('button[type=submit]', e.target);
    if (btn.disabled) return;
    const { password } = formData(e.target);
    setButtonBusy(btn, true, 'Setting up…');
    try {
      await Api.post('/api/renter/accept-invite', { token, password });
      location.hash = '';
      boot();
    } catch (err) {
      qs('#accept-error').innerHTML = '<div class="banner error">' + escapeHtml(describeApiError(err)) + '</div>';
      setButtonBusy(btn, false);
    }
  });
}

// ---------------------------------------------------------------------------
// Lease list (the "pick a lease" screen — skipped automatically when there's
// only one, see route() above, so this only ever renders for a renter on
// more than one lease at once, e.g. two units from the same landlord).
// ---------------------------------------------------------------------------

function renderLeaseList() {
  qs('#view-root').innerHTML =
    '<h1 class="page-title">Your leases</h1>' +
    '<p class="page-subtitle">Pick a property to see its balance, documents, and maintenance.</p>' +
    '<div class="card table-wrap">' +
      '<table><thead><tr><th>Property</th><th>Role</th><th>Status</th><th>Balance</th><th></th></tr></thead><tbody>' +
      LEASES.map((l) => (
        '<tr>' +
          '<td>' + escapeHtml(l.property.name) + '<div class="field-hint">' + escapeHtml(addressLine(l.property.address)) + '</div></td>' +
          '<td>' + (l.role === 'primary' ? 'Primary' : 'Co-renter') + '</td>' +
          '<td>' + (l.status === 'ended' ? '<span class="badge warn">Ended</span>' : statusPill(l.rentStatus)) + '</td>' +
          '<td class="money">' + centsToDisplay(l.outstandingCents) + '</td>' +
          '<td><a class="btn small" href="#/lease/' + l.id + '">Open</a></td>' +
        '</tr>'
      )).join('') +
      '</tbody></table>' +
    '</div>';
}

function addressLine(addr) {
  return [addr.line1, addr.line2, [addr.city, addr.state].filter(Boolean).join(', '), addr.zip].filter(Boolean).join(' · ');
}

// ---------------------------------------------------------------------------
// Lease dashboard shell + tabs
// ---------------------------------------------------------------------------

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'documents', label: 'Documents' },
  { id: 'maintenance', label: 'Maintenance' },
  { id: 'statements', label: 'Statements' },
];

async function renderLeaseDashboard(leaseSummary, tab) {
  qs('#view-root').innerHTML =
    (LEASES.length > 1 ? '<a href="#/" class="back-link">&larr; All leases</a>' : '') +
    '<h1 class="page-title">' + escapeHtml(leaseSummary.property.name) + '</h1>' +
    '<p class="page-subtitle">' + escapeHtml(addressLine(leaseSummary.property.address)) + '</p>' +
    (leaseSummary.status === 'ended'
      ? '<div class="banner warn">This tenancy has ended. You can still view your documents and statements here, but new maintenance requests and payments aren’t available.</div>'
      : '') +
    '<div class="tabbar">' +
      TABS.map((t) => '<button data-tab="' + t.id + '" class="' + (t.id === tab ? 'active' : '') + '">' + t.label + '</button>').join('') +
    '</div>' +
    '<div id="tab-root"><div class="loading-block"><span class="spinner-inline"></span> Loading…</div></div>';

  qsa('[data-tab]').forEach((btn) => btn.addEventListener('click', () => { location.hash = '#/lease/' + leaseSummary.id + '/' + btn.dataset.tab; }));

  let lease;
  try {
    lease = await Api.get('/api/renter/leases/' + leaseSummary.id);
  } catch (err) {
    qs('#tab-root').innerHTML = '<div class="banner error">' + escapeHtml(describeApiError(err)) + '</div>';
    return;
  }

  if (tab === 'documents') renderDocumentsTab(lease);
  else if (tab === 'maintenance') renderMaintenanceTab(lease);
  else if (tab === 'statements') renderStatementsTab(lease);
  else renderOverviewTab(lease);
}

function periodLabel(charge) {
  if (!charge) return '';
  return formatDateShort(charge.periodStart) + ' – ' + formatDateShort(charge.periodEnd);
}

// ---------------------------------------------------------------------------
// Overview tab: balance summary, charges table (each payable row opens the
// payment modal), "pay next period early", and lease facts.
// ---------------------------------------------------------------------------

function renderOverviewTab(lease) {
  const charges = lease.charges; // newest period first, per the API
  const unpaid = charges.filter((c) => c.status !== 'paid');
  const totalOutstanding = unpaid.reduce((sum, c) => sum + c.outstandingCents, 0);
  const canPay = lease.status === 'active';

  qs('#tab-root').innerHTML =
    (unpaid.length === 0
      ? '<div class="banner success">You’re all paid up — nothing is due right now.</div>'
      : '<div class="banner ' + (unpaid.some((c) => c.status === 'late') ? 'error' : 'warn') + '">' +
          'You owe ' + centsToDisplay(totalOutstanding) + ' across ' + unpaid.length + ' period' + (unpaid.length > 1 ? 's' : '') + '. Pay any period from the table below.' +
        '</div>') +
    '<div class="section-heading">' +
      '<h2>Charges &amp; payment history</h2>' +
      (canPay ? '<button class="btn small" id="pay-early-btn" type="button">Pay next month early</button>' : '') +
    '</div>' +
    renderChargesTable(charges, canPay) +
    '<div class="section-heading" style="margin-top:30px;"><h2>Your lease</h2></div>' +
    renderLeaseFacts(lease);

  qsa('[data-pay]').forEach((btn) => btn.addEventListener('click', () => openPaymentModal(lease, charges.find((c) => String(c.id) === btn.dataset.pay))));
  qsa('[data-charge-history]').forEach((btn) => btn.addEventListener('click', () => openHistoryModal(charges.find((c) => String(c.id) === btn.dataset.chargeHistory))));
  const payEarlyBtn = qs('#pay-early-btn');
  if (payEarlyBtn) {
    wireAction(payEarlyBtn, async () => {
      const charge = await Api.post('/api/renter/leases/' + lease.id + '/advance-charge');
      // Refresh the table underneath before opening the modal, so the new
      // charge is already visible (with its own Pay/History row) if the
      // renter cancels out of the modal instead of paying right away.
      await refreshLeasesAndRoute();
      openPaymentModal(lease, charge);
    }, { busyLabel: 'Preparing…' });
  }
}

function renderChargesTable(charges, canPay) {
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
      '<td class="btn-row">' +
        (canPay && c.status !== 'paid' ? '<button class="btn small primary" data-pay="' + c.id + '">Pay</button>' : '') +
        '<button class="btn small" data-charge-history="' + c.id + '">History</button>' +
      '</td>' +
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
  const modal = Modal.open(
    '<h2>' + escapeHtml(periodLabel(charge)) + '</h2>' +
    '<div class="facts-grid" style="margin-bottom:18px;">' +
      '<div class="fact"><div class="fact-label">Amount</div><div class="fact-value">' + centsToDisplay(charge.amountCents) + '</div></div>' +
      '<div class="fact"><div class="fact-label">Paid</div><div class="fact-value">' + centsToDisplay(charge.paidCents) + '</div></div>' +
      '<div class="fact"><div class="fact-label">Outstanding</div><div class="fact-value">' + centsToDisplay(charge.outstandingCents) + '</div></div>' +
    '</div>' +
    rows +
    '<div class="modal-actions"><button class="btn" id="close-history">Close</button></div>'
  );
  qs('#close-history', modal).addEventListener('click', () => Modal.close(true));
}

// ---- Payment modal: idle -> reviewed -> waiting -> succeeded/failed --------
// Same state machine and the same "the browser never marks anything paid"
// rule as public/js/tenant.js's payment card (see its header comment) — kept
// as its own copy rather than shared, since this one lives in a modal scoped
// to an authenticated lease/charge instead of a page scoped to a link token.

let activePaymentPoller = null;

function openPaymentModal(lease, charge) {
  if (!charge) return;
  const modal = Modal.open('');
  paintPaymentModal(modal, { phase: 'idle', lease, charge });
}

function paintPaymentModal(modal, s) {
  const { lease, charge } = s;
  const provider = lease.provider;
  let inner = '<h2>Pay ' + escapeHtml(periodLabel(charge)) + '</h2>';
  if (provider && provider.mode === 'test') inner += '<div class="banner info">' + escapeHtml(provider.notice) + '</div>';

  if (s.phase === 'idle') {
    const defaultDollars = (charge.outstandingCents / 100).toFixed(2);
    inner +=
      '<div class="field"><label>Amount due</label><div class="fact-value">' + centsToDisplay(charge.outstandingCents) + '</div></div>' +
      '<div class="field"><label>Amount to pay</label><input id="pay-amount" type="number" step="0.01" min="0.01" max="' + (charge.outstandingCents / 100).toFixed(2) + '" value="' + defaultDollars + '"></div>' +
      '<p class="field-hint">You can pay less than the full amount if you need to make a partial payment.</p>' +
      '<div class="modal-actions">' +
        '<button class="btn" type="button" id="pay-cancel">Cancel</button>' +
        '<button class="btn primary" type="button" id="pay-review">Review payment</button>' +
      '</div>';
    modal.innerHTML = inner;
    qs('#pay-cancel', modal).addEventListener('click', () => Modal.close());
    qs('#pay-review', modal).addEventListener('click', async () => {
      const btn = qs('#pay-review', modal);
      const amountStr = qs('#pay-amount', modal).value;
      if (!amountStr || Number(amountStr) <= 0) { Toast.show('Enter an amount greater than $0', 'error'); return; }
      setButtonBusy(btn, true, 'Preparing…');
      try {
        const session = await Api.post('/api/renter/leases/' + lease.id + '/checkout', { chargeId: charge.id, amount: amountStr });
        paintPaymentModal(modal, { phase: 'reviewed', lease, charge, session });
      } catch (err) {
        Toast.show(describeApiError(err), 'error');
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
      '<div class="modal-actions">' +
        '<button class="btn" type="button" id="pay-back">Change amount</button>' +
        '<button class="btn primary" type="button" id="pay-confirm">Continue to secure payment &rarr;</button>' +
      '</div>';
    modal.innerHTML = inner;
    qs('#pay-back', modal).addEventListener('click', () => paintPaymentModal(modal, { phase: 'idle', lease, charge }));
    qs('#pay-confirm', modal).addEventListener('click', () => {
      window.open(session.checkoutUrl, 'checkout_' + session.sessionId, 'width=460,height=720');
      paintPaymentModal(modal, { phase: 'waiting', lease, charge, session });
    });
    return;
  }

  if (s.phase === 'waiting') {
    const session = s.session;
    inner +=
      '<div class="banner info"><span class="spinner-inline" style="margin-right:8px;"></span>Waiting for payment confirmation… this will update on its own once the payment provider confirms it.</div>' +
      '<div class="modal-actions">' +
        '<button class="btn" type="button" id="pay-reopen">Reopen payment window</button>' +
        '<button class="btn" type="button" id="pay-check-now">Check status now</button>' +
      '</div>';
    modal.innerHTML = inner;
    qs('#pay-reopen', modal).addEventListener('click', () => window.open(session.checkoutUrl, 'checkout_' + session.sessionId, 'width=460,height=720'));
    qs('#pay-check-now', modal).addEventListener('click', () => { if (activePaymentPoller) activePaymentPoller.checkNow(); });

    activePaymentPoller = startPaymentPolling(lease.id, session.sessionId, (update) => {
      if (update.error) { Toast.show(update.error, 'error'); return; }
      if (update.timedOut) {
        paintPaymentModal(modal, { phase: 'waiting', lease, charge, session });
        Toast.show('Still waiting on confirmation — you can keep this open or check back later.', 'info');
        return;
      }
      const sess = update.session;
      if (sess.status === 'succeeded') {
        paintPaymentModal(modal, { phase: 'succeeded', lease, charge, session: sess });
        refreshLeasesAndRoute();
      } else if (sess.status === 'failed') {
        paintPaymentModal(modal, { phase: 'failed', lease, charge, session: sess });
      }
    });
    return;
  }

  if (s.phase === 'succeeded') {
    inner += '<div class="banner success" style="margin-bottom:0;">Payment of ' + centsToDisplay(s.session.totalCents) + ' confirmed. Your balance has been updated.</div>' +
      '<div class="modal-actions"><button class="btn primary" type="button" id="pay-done">Done</button></div>';
    modal.innerHTML = inner;
    qs('#pay-done', modal).addEventListener('click', () => Modal.close(true));
    return;
  }

  if (s.phase === 'failed') {
    inner +=
      '<div class="banner error" style="margin-bottom:16px;">Payment declined. No charge was made.</div>' +
      '<div class="modal-actions">' +
        '<button class="btn" type="button" id="pay-close">Close</button>' +
        '<button class="btn primary" type="button" id="pay-retry">Try again</button>' +
      '</div>';
    modal.innerHTML = inner;
    qs('#pay-close', modal).addEventListener('click', () => Modal.close(true));
    qs('#pay-retry', modal).addEventListener('click', () => paintPaymentModal(modal, { phase: 'idle', lease, charge }));
  }
}

function startPaymentPolling(leaseId, sessionId, onUpdate) {
  let timer = null;
  let cancelled = false;
  const startedAt = Date.now();
  async function checkOnce() {
    if (cancelled) return;
    clearTimeout(timer);
    let session;
    try {
      session = await Api.get('/api/renter/leases/' + leaseId + '/sessions/' + sessionId);
    } catch (err) {
      onUpdate({ error: describeApiError(err) });
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

window.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'mock-payment-complete' && activePaymentPoller) activePaymentPoller.checkNow();
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
      (lease.status === 'ended' ? fact('Deposit disposition', escapeHtml(lease.depositDisposition || '—')) : '') +
      fact('Rent due', 'Day ' + lease.dueDay + ' of each month') +
      fact('Late after', lease.lateAfterDays + ' days past due') +
      fact('Late fee', lateFee) +
    '</div>'
  );
}

// ---------------------------------------------------------------------------
// Documents tab
// ---------------------------------------------------------------------------

async function renderDocumentsTab(lease) {
  const el = qs('#tab-root');
  let docs;
  try {
    docs = await Api.get('/api/renter/leases/' + lease.id + '/documents');
  } catch (err) {
    el.innerHTML = '<div class="banner error">' + escapeHtml(describeApiError(err)) + '</div>';
    return;
  }
  if (docs.length === 0) {
    el.innerHTML = '<div class="card panel empty-state"><h3>No shared documents yet</h3><p>Your landlord hasn’t shared any documents with you yet.</p></div>';
    return;
  }
  el.innerHTML =
    '<div class="card table-wrap">' +
      '<table><thead><tr><th>Document</th><th>Category</th><th></th></tr></thead><tbody>' +
      docs.map((d) => (
        '<tr><td>' + escapeHtml(d.filename) + '</td><td>' + escapeHtml(d.category || '—') + '</td>' +
        '<td><a class="btn small" href="' + d.url + '" target="_blank" rel="noopener">Download</a></td></tr>'
      )).join('') +
      '</tbody></table>' +
    '</div>';
}

// ---------------------------------------------------------------------------
// Maintenance tab
// ---------------------------------------------------------------------------

const PRIORITY_LABEL = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' };

async function renderMaintenanceTab(lease) {
  const el = qs('#tab-root');
  const canFile = lease.status === 'active';
  el.innerHTML =
    '<div class="section-heading">' +
      '<h2>Maintenance requests</h2>' +
      (canFile ? '<button class="btn primary small" id="new-maintenance-btn">Submit a request</button>' : '') +
    '</div>' +
    '<div id="maintenance-list"><div class="loading-block"><span class="spinner-inline"></span> Loading…</div></div>';
  if (canFile) qs('#new-maintenance-btn').addEventListener('click', () => openMaintenanceModal(lease));
  await loadMaintenance(lease.id);
}

async function loadMaintenance(leaseId) {
  const el = qs('#maintenance-list');
  if (!el) return;
  let rows;
  try {
    rows = await Api.get('/api/renter/leases/' + leaseId + '/maintenance');
  } catch (err) {
    el.innerHTML = '<div class="banner error">' + escapeHtml(describeApiError(err)) + '</div>';
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

function openMaintenanceModal(lease) {
  const picker = PhotoPicker({ multiple: true });
  const modal = Modal.open(
    '<h2>Submit a maintenance request</h2>' +
    '<form id="maint-form">' +
      '<div class="field"><label>What needs attention?</label><input name="title" required></div>' +
      '<div class="field"><label>Details (optional)</label><textarea name="description" placeholder="Where is it, when did you notice it, anything your landlord should know"></textarea></div>' +
      '<div class="field"><label>Photos (optional)</label>' + picker.html() + '</div>' +
      '<div id="maint-error"></div>' +
      '<div class="modal-actions">' +
        '<button class="btn" type="button" id="maint-cancel">Cancel</button>' +
        '<button class="btn primary" type="submit">Submit request</button>' +
      '</div>' +
    '</form>'
  );
  picker.wire(modal);
  qs('#maint-cancel', modal).addEventListener('click', () => { picker.destroy(); Modal.close(); });
  qs('#maint-form', modal).addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = qs('button[type=submit]', e.target);
    if (picker.hasPendingConversions()) { showFormError(modal, 'Still converting a photo — try again in a moment.'); return; }
    setButtonBusy(btn, true, 'Submitting…');
    try {
      const fields = formData(e.target);
      const files = picker.getFiles();
      const images = [];
      for (const file of files) images.push(await compressImage(file));
      await Api.post('/api/renter/leases/' + lease.id + '/maintenance', { title: fields.title, description: fields.description, images });
      picker.destroy();
      await Modal.close(true);
      Toast.show('Request submitted', 'success');
      loadMaintenance(lease.id);
    } catch (err) {
      showFormError(modal, describeApiError(err));
      setButtonBusy(btn, false);
    }
  });
}

// ---------------------------------------------------------------------------
// Statements tab — only ever shows statements the owner explicitly shared
// (see server/routes/renterPortal.js's statements route).
// ---------------------------------------------------------------------------

async function renderStatementsTab(lease) {
  const el = qs('#tab-root');
  let statements;
  try {
    statements = await Api.get('/api/renter/leases/' + lease.id + '/statements');
  } catch (err) {
    el.innerHTML = '<div class="banner error">' + escapeHtml(describeApiError(err)) + '</div>';
    return;
  }
  if (statements.length === 0) {
    el.innerHTML = '<div class="card panel empty-state"><h3>No statements yet</h3><p>Your landlord hasn’t shared any payment statements with you yet.</p></div>';
    return;
  }
  el.innerHTML =
    '<div class="card table-wrap">' +
      '<table><thead><tr><th>Period</th><th>Billed</th><th>Paid</th><th>Balance</th><th>Generated</th><th></th></tr></thead><tbody>' +
      statements.map((s) => (
        '<tr>' +
          '<td>' + formatDateShort(s.rangeStart) + ' – ' + formatDateShort(s.rangeEnd) + (s.isSample ? ' <span class="badge sample">Sample</span>' : '') + '</td>' +
          '<td class="money">' + centsToDisplay(s.totals ? s.totals.billedCents : null) + '</td>' +
          '<td class="money">' + centsToDisplay(s.totals ? s.totals.paidCents : null) + '</td>' +
          '<td class="money">' + centsToDisplay(s.totals ? s.totals.outstandingCents : null) + '</td>' +
          '<td>' + formatDateTime(s.createdAt) + '</td>' +
          '<td><a class="btn small" href="' + s.url + '" target="_blank" rel="noopener">Download</a></td>' +
        '</tr>'
      )).join('') +
      '</tbody></table>' +
    '</div>';
}

boot();

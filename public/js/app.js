// App bootstrap. This is the last script index.html loads, and it's the one
// piece that ties the others together: it decides which screen to show
// (first-run setup / sign-in / the authenticated app), renders the
// persistent topbar once signed in, and drives a small hash-based router
// between the dashboard and the property-detail view.
//
// Contract with the other view modules (do not change without updating
// them too):
//   - views/auth.js calls `App.boot()` after a successful /api/setup or
//     /api/login call.
//   - views/dashboard.js and views/property.js navigate by setting
//     `location.hash` to '#/property/:id' or '#/property/:id/:tab'.

const App = (function () {
  let routerAttached = false;
  let ownerName = '';

  async function boot() {
    let status;
    try {
      status = await Api.get('/api/setup/status');
    } catch (err) {
      renderFatalError(err);
      return;
    }

    if (status.needsSetup) {
      AuthView.renderSetup();
      return;
    }

    try {
      const owner = await Api.get('/api/me');
      ownerName = owner.name || owner.email || '';
    } catch (err) {
      if (err instanceof Api.ApiError && err.status === 401) {
        AuthView.renderLogin();
        return;
      }
      renderFatalError(err);
      return;
    }

    attachRouter();
    route();
  }

  function attachRouter() {
    if (routerAttached) return;
    routerAttached = true;
    window.addEventListener('hashchange', route);
  }

  function detachRouter() {
    routerAttached = false;
    window.removeEventListener('hashchange', route);
  }

  // '#/' or '' -> dashboard. '#/property/12' or '#/property/12/photos' ->
  // property view. '#/bank-accounts' -> the portfolio-wide bank accounts page.
  function parseHash() {
    const path = location.hash.replace(/^#\/?/, '');
    const parts = path.split('/').filter(Boolean);
    if (parts[0] === 'property' && parts[1]) {
      return { view: 'property', id: parts[1], tab: parts[2] || null };
    }
    if (parts[0] === 'bank-accounts') {
      return { view: 'bank-accounts' };
    }
    return { view: 'dashboard' };
  }

  function route() {
    const parsed = parseHash();
    renderTopbar(parsed.view);
    if (parsed.view === 'property') {
      PropertyView.render(parsed.id, parsed.tab);
    } else if (parsed.view === 'bank-accounts') {
      BankAccountsView.render();
    } else {
      DashboardView.render();
    }
  }

  function renderTopbar(activeView) {
    qs('#topbar-root').innerHTML =
      '<div class="topbar">' +
        '<a href="#/" class="brand"><span class="mark"></span>Rental Portfolio</a>' +
        '<nav>' +
          '<a href="#/" class="' + (activeView === 'dashboard' ? 'current' : '') + '">Dashboard</a>' +
          '<a href="#/bank-accounts" class="' + (activeView === 'bank-accounts' ? 'current' : '') + '">Bank Accounts</a>' +
          '<span class="topbar-owner-name">' + escapeHtml(ownerName) + '</span>' +
          '<button class="link" id="sign-out-btn" type="button">Sign out</button>' +
        '</nav>' +
      '</div>';
    qs('#sign-out-btn').addEventListener('click', signOut);
  }

  async function signOut() {
    try {
      await Api.post('/api/logout');
    } catch (err) {
      // Sign out locally regardless of whether the server call succeeded —
      // there's nothing useful to do with a failed logout except clear the
      // session client-side and let the next request re-establish reality.
    }
    detachRouter();
    ownerName = '';
    location.hash = '';
    App.boot();
  }

  function renderFatalError(err) {
    qs('#topbar-root').innerHTML = '';
    qs('#view-root').innerHTML =
      '<div class="banner error" style="max-width:520px;margin:60px auto;">' +
        'Could not reach the server: ' + escapeHtml(err && err.message ? err.message : 'unknown error') + '. ' +
        'Check your connection and reload the page.' +
      '</div>';
  }

  return { boot };
})();

App.boot();

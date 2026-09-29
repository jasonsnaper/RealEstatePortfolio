// Sign-in / first-run setup / forgot-password screens. These render straight
// into #view-root with no topbar (nothing to navigate to before signing in).

const AuthView = (function () {
  function shell(innerHtml) {
    qs('#topbar-root').innerHTML = '';
    qs('#view-root').innerHTML =
      '<div style="max-width:400px;margin:60px auto 0;">' +
        '<div style="text-align:center;margin-bottom:28px;">' +
          '<div style="width:40px;height:40px;background:var(--ink);border-radius:6px;margin:0 auto 14px;"></div>' +
          '<h1 style="font-size:24px;">Rental Portfolio</h1>' +
        '</div>' +
        '<div class="card panel">' + innerHtml + '</div>' +
      '</div>';
  }

  function renderSetup() {
    shell(
      '<h2 style="margin-bottom:4px;">Set up your account</h2>' +
      '<p class="field-hint" style="margin-bottom:18px;">This creates the one owner account for this install.</p>' +
      '<form id="setup-form">' +
        '<div class="field"><label>Your name</label><input name="name" required autocomplete="name"></div>' +
        '<div class="field"><label>Email</label><input name="email" type="email" required autocomplete="email"></div>' +
        '<div class="field"><label>Password</label><input name="password" type="password" required minlength="8" autocomplete="new-password">' +
          '<span class="field-hint">At least 8 characters.</span></div>' +
        '<div id="setup-error"></div>' +
        '<button class="btn primary" style="width:100%;justify-content:center;" type="submit">Create account</button>' +
      '</form>'
    );
    qs('#setup-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = qs('button', e.target);
      setButtonBusy(btn, true, 'Creating…');
      try {
        await Api.post('/api/setup', formData(e.target));
        App.boot();
      } catch (err) {
        qs('#setup-error').innerHTML = '<div class="banner error">' + escapeHtml(err.message) + '</div>';
        setButtonBusy(btn, false);
      }
    });
  }

  function renderLogin() {
    shell(
      '<h2 style="margin-bottom:18px;">Sign in</h2>' +
      '<form id="login-form">' +
        '<div class="field"><label>Email</label><input name="email" type="email" required autocomplete="email"></div>' +
        '<div class="field"><label>Password</label><input name="password" type="password" required autocomplete="current-password"></div>' +
        '<div id="login-error"></div>' +
        '<button class="btn primary" style="width:100%;justify-content:center;" type="submit">Sign in</button>' +
      '</form>' +
      '<div style="text-align:center;margin-top:14px;">' +
        '<button class="btn" style="border:none;background:none;color:var(--ink-soft);font-size:13px;" id="forgot-link">Forgot password?</button>' +
      '</div>'
    );
    qs('#login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = qs('button[type=submit]', e.target);
      setButtonBusy(btn, true, 'Signing in…');
      try {
        await Api.post('/api/login', formData(e.target));
        App.boot();
      } catch (err) {
        qs('#login-error').innerHTML = '<div class="banner error">' + escapeHtml(err.message) + '</div>';
        setButtonBusy(btn, false);
      }
    });
    qs('#forgot-link').addEventListener('click', renderForgotPassword);
  }

  function renderForgotPassword() {
    shell(
      '<h2 style="margin-bottom:6px;">Reset password</h2>' +
      '<p class="field-hint" style="margin-bottom:18px;">No email sending is configured yet, so the reset code is printed to the server console/logs instead of emailed. See the README to connect a real email provider.</p>' +
      '<form id="forgot-form">' +
        '<div class="field"><label>Email</label><input name="email" type="email" required></div>' +
        '<div id="forgot-msg"></div>' +
        '<button class="btn primary" style="width:100%;justify-content:center;" type="submit">Request reset code</button>' +
      '</form>' +
      '<div style="text-align:center;margin-top:14px;">' +
        '<button class="btn" style="border:none;background:none;color:var(--ink-soft);font-size:13px;" id="have-code">I have a reset code</button> · ' +
        '<button class="btn" style="border:none;background:none;color:var(--ink-soft);font-size:13px;" id="back-login">Back to sign in</button>' +
      '</div>'
    );
    qs('#forgot-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const { email } = formData(e.target);
      const res = await Api.post('/api/forgot-password', { email });
      qs('#forgot-msg').innerHTML = '<div class="banner info">' + escapeHtml(res.message) + '</div>';
    });
    qs('#have-code').addEventListener('click', () => renderResetPassword());
    qs('#back-login').addEventListener('click', renderLogin);
  }

  function renderResetPassword() {
    shell(
      '<h2 style="margin-bottom:18px;">Enter reset code</h2>' +
      '<form id="reset-form">' +
        '<div class="field"><label>Email</label><input name="email" type="email" required></div>' +
        '<div class="field"><label>Reset code</label><input name="code" required></div>' +
        '<div class="field"><label>New password</label><input name="newPassword" type="password" required minlength="8"></div>' +
        '<div id="reset-msg"></div>' +
        '<button class="btn primary" style="width:100%;justify-content:center;" type="submit">Update password</button>' +
      '</form>'
    );
    qs('#reset-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const res = await Api.post('/api/reset-password', formData(e.target));
        qs('#reset-msg').innerHTML = '<div class="banner success">' + escapeHtml(res.message) + '</div>';
        setTimeout(renderLogin, 1200);
      } catch (err) {
        qs('#reset-msg').innerHTML = '<div class="banner error">' + escapeHtml(err.message) + '</div>';
      }
    });
  }

  return { renderSetup, renderLogin };
})();

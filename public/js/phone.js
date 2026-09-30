// A small, dependency-free "phone number with country code" field, shared by
// the renter Make-a-New-Account screen (public/js/renter.js) and the owner's
// SMS-invite modal (public/js/leaseAgreementUI.js). This app has zero npm
// dependencies by design, so there is no libphonenumber and no exhaustive
// country list here — just a short, honestly-curated set of common country
// calling codes plus a free-text "Other" fallback, joined into E.164
// (+<country><national digits>) the same way server/lib/phone.js validates
// it. This is real, working validation (a wrong/incomplete number is caught
// before submit), just not authoritative proof a number is live — only an
// actual SMS attempt can tell you that.

const Phone = (function () {
  const COUNTRIES = [
    { cc: '1', label: 'US/Canada (+1)' },
    { cc: '44', label: 'UK (+44)' },
    { cc: '52', label: 'Mexico (+52)' },
    { cc: '91', label: 'India (+91)' },
    { cc: '61', label: 'Australia (+61)' },
    { cc: '49', label: 'Germany (+49)' },
    { cc: '', label: 'Other…' },
  ];
  const E164_RE = /^\+[1-9]\d{7,14}$/;

  function isValid(value) {
    return typeof value === 'string' && E164_RE.test(value.trim());
  }

  function compose(cc, national) {
    const digits = String(national || '').replace(/[^\d]/g, '');
    const code = String(cc || '').replace(/[^\d]/g, '');
    if (!code || !digits) return '';
    const candidate = '+' + code + digits;
    return isValid(candidate) ? candidate : '';
  }

  /** Renders the visible country-select + national-number inputs, plus a
   * hidden `name`-carrying input that Phone.wire keeps in sync with the
   * composed E.164 value — so a plain formData(form) read at submit time
   * already returns the finished phone number under `name`, no extra
   * composition step needed at the call site. `initial` (an E.164 string)
   * pre-fills both visible parts when editing an existing number. */
  function fieldHtml(name, initial) {
    const initialCc = initial ? (COUNTRIES.find((c) => c.cc && initial.startsWith('+' + c.cc)) || {}).cc : '1';
    const initialNational = initial && initialCc ? initial.slice(1 + initialCc.length) : '';
    return (
      '<div class="phone-field" data-phone-root="' + escapeHtml(name) + '" style="display:flex;gap:8px;">' +
        '<select class="phone-cc" style="flex:0 0 auto;max-width:150px;">' +
          COUNTRIES.map((c) => '<option value="' + c.cc + '"' + (c.cc === (initialCc || '1') ? ' selected' : '') + '>' + escapeHtml(c.label) + '</option>').join('') +
        '</select>' +
        '<input class="phone-other-cc" type="text" placeholder="Country code" style="flex:0 0 90px;display:none;" inputmode="numeric">' +
        '<input class="phone-national" type="tel" placeholder="Phone number" style="flex:1;" value="' + escapeHtml(initialNational) + '" autocomplete="tel-national">' +
      '</div>' +
      '<input type="hidden" name="' + escapeHtml(name) + '">'
    );
  }

  /** Wires the live composition. Call once, right after inserting fieldHtml's markup into the DOM. `root` is the form (or any ancestor) containing it. */
  function wire(root, name) {
    const wrap = (root.querySelector ? root : document).querySelector('[data-phone-root="' + name + '"]');
    if (!wrap) return;
    const ccSelect = wrap.querySelector('.phone-cc');
    const otherCc = wrap.querySelector('.phone-other-cc');
    const national = wrap.querySelector('.phone-national');
    const hidden = wrap.parentNode.querySelector('input[type="hidden"][name="' + name + '"]') || wrap.nextElementSibling;

    function recompute() {
      const isOther = ccSelect.value === '';
      otherCc.style.display = isOther ? '' : 'none';
      const cc = isOther ? otherCc.value : ccSelect.value;
      hidden.value = compose(cc, national.value);
    }
    ccSelect.addEventListener('change', recompute);
    otherCc.addEventListener('input', recompute);
    national.addEventListener('input', recompute);
    recompute();
  }

  return { fieldHtml, wire, isValid, compose };
})();

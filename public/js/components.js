// Small reusable UI primitives shared by every view: modal dialogs, toasts,
// and a confirm() replacement (native confirm() is jarring and untestable;
// this one matches the app's own visual language).

// Tracks whether the open modal has any edit worth warning about before it's
// lost, and makes close() itself the one place that decides whether closing
// is safe — so every existing "Cancel" button and backdrop-click, all wired
// as plain `addEventListener('click', Modal.close)` across every view, gets
// an "unsaved changes" guard for free, with no changes needed at those call
// sites. A close that happens because a save/action already succeeded (see
// wireSave below) passes close(true) to skip the check — there's nothing
// left to lose at that point, it's already on the server.
const Modal = (function () {
  let backdrop = null;
  let dirty = false;
  let confirmPending = false;

  function open(innerHtml, opts) {
    opts = opts || {};
    removeBackdrop(); // opening a new modal always replaces whatever was there — this is the app moving between its own steps, not the user abandoning an edit
    backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = '<div class="modal">' + innerHtml + '</div>';
    if (!opts.persistent) {
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    }
    document.body.appendChild(backdrop);
    const modalEl = backdrop.querySelector('.modal');
    // Any edit anywhere in this modal counts as an unsaved change — every
    // field in every modal in this app is a real, saveable field (never a
    // throwaway search/filter box), so this blanket rule needs no per-field
    // opt-in. Range sliders and checkboxes fire 'input'/'change' too, so
    // dragging the cover-photo reposition sliders or picking a file counts
    // the same as typing in a text field.
    modalEl.addEventListener('input', () => { dirty = true; });
    modalEl.addEventListener('change', () => { dirty = true; });
    const focusable = backdrop.querySelector('input, select, textarea, button');
    if (focusable) focusable.focus();
    return modalEl;
  }

  function removeBackdrop() {
    if (backdrop) { backdrop.remove(); backdrop = null; }
    dirty = false;
    confirmPending = false;
  }

  /** Closes the current modal. Pass true only right after an awaited save or
   * action has actually succeeded — anything else (a Cancel button, clicking
   * the backdrop, a bare "Close" button) should call this with no arguments,
   * which is exactly what all of those already do today: `force` receiving a
   * click Event object in that case is harmless, since it's never === true.
   * Returns whether the modal actually closed (false if the owner chose
   * "keep editing" at the confirmation prompt) — callers that need to clean
   * up something (like PhotoPicker's object URLs) only when the modal is
   * really gone should check this before doing so. */
  async function close(force) {
    if (!backdrop) return true;
    if (dirty && force !== true) {
      if (confirmPending) return false; // a prompt is already up for this modal
      confirmPending = true;
      const discard = await confirmDialog('Discard unsaved changes?', 'Discard');
      confirmPending = false;
      if (!backdrop) return true; // closed another way while the prompt was up
      if (!discard) return false; // stays open, exactly as asked
    }
    removeBackdrop();
    return true;
  }

  return { open, close, isDirty: () => dirty };
})();

// Warn before an actual tab close/reload throws away an open, edited modal —
// the in-app Cancel/backdrop path above already covers navigating within the
// app. Scoped to modal forms specifically (not e.g. the sign-in screen):
// that's where this app holds property/tenant/financial edits worth losing.
// Guarded for Node (no `window` there) so this file can still be `require()`d
// for the pure-logic unit tests below.
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', (e) => {
    if (Modal.isDirty()) { e.preventDefault(); e.returnValue = ''; }
  });
}

const Toast = (function () {
  let container = null;
  function ensure() {
    if (!container) {
      container = document.createElement('div');
      container.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:200;display:flex;flex-direction:column;gap:8px;max-width:320px;';
      document.body.appendChild(container);
    }
    return container;
  }
  function show(message, type) {
    type = type || 'info';
    const el = document.createElement('div');
    el.className = 'banner ' + type;
    el.style.cssText = 'margin:0;box-shadow:0 2px 10px rgba(0,0,0,.12);';
    el.textContent = message;
    ensure().appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 300); }, 3600);
  }
  return { show };
})();

// A confirm()-style prompt matching the app's visuals — deliberately its OWN
// independent overlay rather than going through Modal.open/close, so it can
// stack on top of an already-open modal (e.g. "Discard unsaved changes?"
// over a form, or "Delete this photo?" from inside the photo lightbox)
// without tearing down whatever's open behind it. Before this was
// independent, opening a confirm dialog from inside another modal silently
// destroyed that modal (Modal.open() always clears the current backdrop
// first) — canceling the confirmation then lost the lightbox/form instead of
// just dismissing the prompt.
function confirmDialog(message, confirmLabel) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-backdrop confirm-overlay';
    overlay.innerHTML =
      '<div class="modal">' +
        '<p style="margin-top:0">' + escapeHtml(message) + '</p>' +
        '<div class="modal-actions">' +
          '<button class="btn" data-act="cancel">Cancel</button>' +
          '<button class="btn primary" data-act="ok">' + escapeHtml(confirmLabel || 'Confirm') + '</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    const finish = (result) => { overlay.remove(); resolve(result); };
    overlay.querySelector('[data-act="cancel"]').addEventListener('click', () => finish(false));
    overlay.querySelector('[data-act="ok"]').addEventListener('click', () => finish(true));
    overlay.querySelector('[data-act="cancel"]').focus();
  });
}

// Turn whatever an Api.* call rejected with into one plain-language sentence
// — shared by every form/action in the app so a network hiccup, an expired
// session, or a server error all read the same way everywhere instead of
// each view inventing its own phrasing. Duck-types the error shape (status/
// code) instead of checking `instanceof Api.ApiError`, so this has no
// dependency on api.js and can run under Node with no DOM/globals at all
// (see test/formSave.test.js).
function describeApiError(err) {
  if (err && typeof err === 'object' && 'status' in err) {
    if (err.status === 401) return 'Your session has expired. Please sign in again.';
    if (err.code === 'timeout' || err.code === 'network') return err.message;
    if (err.status >= 500 || err.code === 'server') return 'The server hit a problem handling this. Please try again in a moment.';
    return err.message; // 400/404/409 etc. from the server are already plain sentences
  }
  return (err && err.message) || 'Something went wrong. Please try again.';
}

/** Inline error banner inside a modal, placed just above its action buttons
 * (right where the owner's eye already is when they click Save) — reused by
 * every modal instead of each one hand-rolling its own `#whatever-error` div.
 * `scope` is the modal element (or anything containing a `.modal-actions`). */
function showFormError(scope, message) {
  clearFormError(scope);
  const el = document.createElement('div');
  el.className = 'banner error modal-form-error';
  el.textContent = message;
  const actions = scope.querySelector('.modal-actions');
  if (actions) actions.parentNode.insertBefore(el, actions);
  else scope.appendChild(el);
}
function clearFormError(scope) {
  const el = scope.querySelector('.modal-form-error');
  if (el) el.remove();
}

/**
 * Standardizes the save lifecycle for every modal form/action in the app:
 * prevents the browser's own form submit, shows "Saving…" on the submit
 * control and disables it for the whole request — which is what actually
 * stops a duplicate submission, since neither a second click nor pressing
 * Enter again can reach a disabled control — shows a "Saved" toast only once
 * the server has actually confirmed success, and on failure shows a clear
 * inline error and leaves every entered value exactly as the user left it:
 * nothing here ever clears a field, and the modal stays open so retrying is
 * just fixing the problem and clicking Save again.
 *
 * `trigger` is either a <form> (wired to 'submit', so pressing Enter in a
 * field also goes through this) or a plain <button> (wired to 'click') —
 * this app's modals use both patterns. `onSave` does the actual Api.* call
 * and any follow-up that should only happen once it's confirmed saved (a
 * re-render, a navigation) — it should NOT close the modal itself; wireSave
 * does that automatically on success, which is also what correctly clears
 * the "unsaved changes" flag (a close right after a real success is always
 * safe, so it's forced rather than re-confirmed). To validate before ever
 * reaching the server (e.g. "choose a photo first"), throw a plain Error
 * from onSave — it's shown exactly like a server error, inline, with the
 * form left untouched. `onSave` can return a string to use as the specific
 * "Saved" toast message (e.g. "3 photos uploaded.") in place of
 * opts.savedMessage, for the cases where that isn't known until it runs.
 */
function wireSave(trigger, onSave, opts) {
  opts = opts || {};
  const modal = trigger.closest('.modal') || trigger;
  const isForm = trigger.tagName === 'FORM';
  const btn = isForm ? trigger.querySelector('button[type="submit"]') : trigger;
  trigger.addEventListener(isForm ? 'submit' : 'click', async (e) => {
    if (e && e.preventDefault) e.preventDefault();
    if (modal.dataset.saving === '1') return;
    modal.dataset.saving = '1';
    clearFormError(modal);
    if (btn) setButtonBusy(btn, true, opts.savingLabel || 'Saving…');
    try {
      const result = await onSave();
      modal.dataset.saving = '0';
      await Modal.close(true);
      Toast.show((typeof result === 'string' && result) || opts.savedMessage || 'Saved.', 'success');
    } catch (err) {
      modal.dataset.saving = '0';
      if (btn) setButtonBusy(btn, false);
      showFormError(modal, describeApiError(err));
    }
  });
}

/** Lighter sibling of wireSave for one-off actions that aren't a form save —
 * archive, dismiss, share/unshare, delete-after-confirm. Same busy-state and
 * duplicate-click guard, but no modal to close and no form to preserve, so
 * failures go to a toast rather than an inline banner. */
function wireAction(btn, onAction, opts) {
  opts = opts || {};
  btn.addEventListener('click', async () => {
    if (btn.dataset.busy === '1') return;
    btn.dataset.busy = '1';
    setButtonBusy(btn, true, opts.busyLabel || 'Working…');
    try {
      await onAction();
    } catch (err) {
      Toast.show(describeApiError(err), 'error');
    } finally {
      btn.dataset.busy = '0';
      // The button often no longer exists by now (its container re-rendered
      // on success) — setButtonBusy on a detached node is harmless.
      setButtonBusy(btn, false);
    }
  });
}

/** A password <input> plus a "Show"/"Hide" toggle button, for any form that
 * asks someone to choose or re-type their own password (renter sign-up,
 * accept-invite, reset-password). `name` becomes the input's name attribute;
 * `autocomplete` should be "new-password" for a password being SET and
 * "current-password" for one being entered to sign in. Call wirePasswordToggles
 * once after inserting the markup to make the button actually work. */
function passwordToggleHtml(name, autocomplete) {
  return (
    '<div class="password-field" style="position:relative;">' +
      '<input name="' + escapeHtml(name) + '" type="password" required minlength="8" maxlength="200" autocomplete="' + escapeHtml(autocomplete || 'new-password') + '" style="padding-right:60px;width:100%;">' +
      '<button type="button" class="link password-toggle-btn" data-toggle-for="' + escapeHtml(name) + '" style="position:absolute;right:10px;top:50%;transform:translateY(-50%);font-size:12px;">Show</button>' +
    '</div>'
  );
}
function wirePasswordToggles(root) {
  qsa('[data-toggle-for]', root).forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = qs('[name="' + btn.dataset.toggleFor + '"]', root);
      if (!input) return;
      const showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      btn.textContent = showing ? 'Show' : 'Hide';
    });
  });
}

/** Serialize a <form>'s named fields into a plain object. Checkboxes become booleans. */
function formData(form) {
  const out = {};
  qsa('[name]', form).forEach((el) => {
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else if (el.type === 'radio') { if (el.checked) out[el.name] = el.value; }
    else out[el.name] = el.value;
  });
  return out;
}

function setButtonBusy(btn, busy, busyLabel) {
  if (busy) {
    btn.dataset.originalLabel = btn.innerHTML;
    btn.innerHTML = '<span class="spinner-inline"></span> ' + (busyLabel || 'Working…');
    btn.disabled = true;
  } else {
    btn.innerHTML = btn.dataset.originalLabel || btn.innerHTML;
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Photo picker: shared by cover photos, property photos, and maintenance
// photos so all three offer the same explicit, non-camera-forcing choices
// (see public/js/views/property.js for where each is used). Pure detection
// logic (isHeicFile) is exported for Node so it has a real unit test —
// everything else here needs a DOM/File API and is only exercised by hand
// and via Playwright (see README's "Verified by hand" section).
// ---------------------------------------------------------------------------

/** True if a File looks like HEIC/HEIF (iPhone's default camera format).
 * Safari sometimes reports an empty `type` for these, so the extension is
 * checked too — relying on MIME type alone misses that case entirely. */
function isHeicFile(file) {
  if (!file) return false;
  const type = String(file.type || '').toLowerCase();
  const name = String(file.name || '').toLowerCase();
  return type === 'image/heic' || type === 'image/heif' ||
    name.endsWith('.heic') || name.endsWith('.heif');
}

/** True if a File is some kind of image we might be able to use — either a
 * type the browser can already decode, or HEIC (handled separately). Used to
 * politely reject e.g. a stray PDF picked via "Choose Files", which has no
 * `accept` restriction. */
function isUsableImageFile(file) {
  if (!file) return false;
  if (isHeicFile(file)) return true;
  return String(file.type || '').toLowerCase().startsWith('image/');
}

// Lazy-loaded once per page, only if a HEIC file is actually encountered —
// most uploads never need it. A CDN script (not an npm dependency: this runs
// in the VISITOR's browser, not on the server, so it doesn't touch this
// app's zero-server-dependency architecture). If it fails to load or the
// conversion throws for any reason, callers fall back to a clear message
// rather than a broken upload — this was not tested against a real HEIC
// file from an iPhone in this environment (no iPhone/Safari available to
// test with here); see README.
let heic2anyLoadPromise = null;
function loadHeic2Any() {
  if (window.heic2any) return Promise.resolve(window.heic2any);
  if (heic2anyLoadPromise) return heic2anyLoadPromise;
  heic2anyLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js';
    script.onload = () => (window.heic2any ? resolve(window.heic2any) : reject(new Error('heic2any did not load correctly')));
    script.onerror = () => reject(new Error('Could not load the HEIC conversion library (no network access to the CDN?)'));
    document.head.appendChild(script);
  });
  return heic2anyLoadPromise;
}

/** Attempt to convert a HEIC/HEIF Blob to a JPEG Blob in the browser. Returns
 * null (never throws) if conversion isn't possible right now, so callers can
 * fall back to a clear message instead of crashing the upload flow. */
async function tryConvertHeic(file) {
  try {
    const heic2any = await loadHeic2Any();
    const result = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.85 });
    return Array.isArray(result) ? result[0] : result; // some multi-image HEIC containers convert to an array
  } catch (err) {
    return null;
  }
}

/**
 * A reusable "add photos" widget: three explicit actions (Choose Photos /
 * Take Photo / Choose Files) instead of one input that may silently jump
 * straight to the camera, plus previews with per-image removal. The exact
 * system picker each button opens varies by device/browser — this widget
 * only promises what button does what, not what UI it triggers.
 *
 * Usage: const picker = PhotoPicker({ multiple: true });
 *        Modal.open('...' + picker.html() + '...');
 *        picker.wire(modal);
 *        // later, on submit: const files = picker.getFiles();
 *        // on cancel/close: picker.destroy();
 */
function PhotoPicker(opts) {
  opts = opts || {};
  const multiple = opts.multiple !== false;
  const uid = 'pp' + Math.random().toString(36).slice(2, 9);
  let entries = []; // { key, file, previewUrl, state: 'ready'|'converting'|'unsupported' }
  let root = null;

  function html() {
    return (
      '<div class="photo-picker" id="' + uid + '">' +
        '<div class="btn-row photo-picker-actions">' +
          '<button type="button" class="btn small" data-pp="choose">Choose Photos</button>' +
          '<button type="button" class="btn small" data-pp="camera">Take Photo</button>' +
          '<button type="button" class="btn small" data-pp="files">Choose Files</button>' +
        '</div>' +
        '<input type="file" accept="image/*,.heic,.heif"' + (multiple ? ' multiple' : '') + ' data-pp-input="choose" style="display:none">' +
        '<input type="file" accept="image/*,.heic,.heif" capture="environment" data-pp-input="camera" style="display:none">' +
        '<input type="file"' + (multiple ? ' multiple' : '') + ' data-pp-input="files" style="display:none">' +
        '<div class="photo-picker-previews" data-pp-previews></div>' +
        '<div class="field-hint" data-pp-hint style="margin-top:6px;"></div>' +
      '</div>'
    );
  }

  function wire(scopeEl) {
    root = qs('#' + uid, scopeEl);
    qs('[data-pp="choose"]', root).addEventListener('click', () => qs('[data-pp-input="choose"]', root).click());
    qs('[data-pp="camera"]', root).addEventListener('click', () => qs('[data-pp-input="camera"]', root).click());
    qs('[data-pp="files"]', root).addEventListener('click', () => qs('[data-pp-input="files"]', root).click());
    ['choose', 'camera', 'files'].forEach((kind) => {
      const input = qs('[data-pp-input="' + kind + '"]', root);
      input.addEventListener('change', () => {
        handleNewFiles(Array.from(input.files || []), kind === 'camera');
        input.value = ''; // so picking the exact same file twice still fires 'change'
      });
    });
    renderPreviews();
  }

  function handleNewFiles(files, isCameraCapture) {
    if (files.length === 0) return;
    const hint = qs('[data-pp-hint]', root);
    if (hint) hint.textContent = '';
    if (!multiple || isCameraCapture) {
      // A fresh single-shot selection replaces whatever was there before,
      // rather than silently piling up — cover photo and "take one photo"
      // are both inherently single-image actions.
      revokeAll();
      entries = [];
    }
    const skipped = [];
    for (const file of files) {
      if (!isUsableImageFile(file)) { skipped.push(file.name || 'file'); continue; }
      const entry = { key: 'f' + Math.random().toString(36).slice(2, 9), file, previewUrl: null, state: 'ready' };
      if (isHeicFile(file)) {
        entry.state = 'converting';
        entry.previewUrl = null;
        convertEntry(entry);
      } else {
        entry.previewUrl = URL.createObjectURL(file);
      }
      entries.push(entry);
    }
    if (skipped.length && hint) {
      hint.textContent = 'Skipped (not an image): ' + skipped.join(', ');
    }
    renderPreviews();
  }

  async function convertEntry(entry) {
    const converted = await tryConvertHeic(entry.file);
    // The entry may have been removed by the user while conversion was in
    // flight — only apply the result if it's still in the working list.
    if (!entries.includes(entry)) return;
    if (converted) {
      entry.file = converted;
      entry.previewUrl = URL.createObjectURL(converted);
      entry.state = 'ready';
    } else {
      entry.state = 'unsupported';
    }
    renderPreviews();
  }

  function renderPreviews() {
    if (!root) return;
    const wrap = qs('[data-pp-previews]', root);
    const hasUnsupported = entries.some((e) => e.state === 'unsupported');
    wrap.innerHTML = entries.map((e) => {
      if (e.state === 'converting') {
        return '<div class="photo-picker-tile pending" data-key="' + e.key + '"><span class="spinner-inline"></span><button type="button" class="pp-remove" data-remove="' + e.key + '" aria-label="Remove">&times;</button></div>';
      }
      if (e.state === 'unsupported') {
        return '<div class="photo-picker-tile unsupported" data-key="' + e.key + '"><span>HEIC<br>not converted</span><button type="button" class="pp-remove" data-remove="' + e.key + '" aria-label="Remove">&times;</button></div>';
      }
      return '<div class="photo-picker-tile" data-key="' + e.key + '"><img src="' + e.previewUrl + '"><button type="button" class="pp-remove" data-remove="' + e.key + '" aria-label="Remove">&times;</button></div>';
    }).join('');
    qsa('[data-remove]', wrap).forEach((btn) => btn.addEventListener('click', () => removeEntry(btn.dataset.remove)));
    const hint = qs('[data-pp-hint]', root);
    if (hasUnsupported && hint) {
      hint.innerHTML = 'One or more HEIC photos couldn’t be converted automatically and won’t be uploaded. On an iPhone: Settings &rarr; Camera &rarr; Formats &rarr; choose "Most Compatible" so new photos save as JPEG, or share the photo to yourself via Messages/Mail first (this usually converts it) and choose it again from Files.';
    }
  }

  function removeEntry(key) {
    const entry = entries.find((e) => e.key === key);
    if (entry && entry.previewUrl) URL.revokeObjectURL(entry.previewUrl);
    entries = entries.filter((e) => e.key !== key);
    renderPreviews();
  }

  function revokeAll() {
    entries.forEach((e) => { if (e.previewUrl) URL.revokeObjectURL(e.previewUrl); });
  }

  /** Files ready to upload — excludes any HEIC image that failed to convert. */
  function getFiles() {
    return entries.filter((e) => e.state === 'ready').map((e) => e.file);
  }

  function hasPendingConversions() {
    return entries.some((e) => e.state === 'converting');
  }

  function destroy() {
    revokeAll();
    entries = [];
  }

  return { html, wire, getFiles, hasPendingConversions, destroy };
}

// isHeicFile/isUsableImageFile/describeApiError have no DOM dependency, so
// they get real unit tests under Node (see test/photoPicker.test.js and
// test/formSave.test.js) — a no-op in the browser, where `module` doesn't
// exist.
if (typeof module !== 'undefined') module.exports = { isHeicFile, isUsableImageFile, describeApiError };

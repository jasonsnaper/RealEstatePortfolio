// Small reusable UI primitives shared by every view: modal dialogs, toasts,
// and a confirm() replacement (native confirm() is jarring and untestable;
// this one matches the app's own visual language).

const Modal = (function () {
  let backdrop = null;
  function open(innerHtml, opts) {
    opts = opts || {};
    close();
    backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = '<div class="modal">' + innerHtml + '</div>';
    if (!opts.persistent) {
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    }
    document.body.appendChild(backdrop);
    const focusable = backdrop.querySelector('input, select, textarea, button');
    if (focusable) focusable.focus();
    return backdrop.querySelector('.modal');
  }
  function close() {
    if (backdrop) { backdrop.remove(); backdrop = null; }
  }
  return { open, close };
})();

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

function confirmDialog(message, confirmLabel) {
  return new Promise((resolve) => {
    const modal = Modal.open(
      '<p style="margin-top:0">' + escapeHtml(message) + '</p>' +
      '<div class="modal-actions">' +
        '<button class="btn" data-act="cancel">Cancel</button>' +
        '<button class="btn primary" data-act="ok">' + escapeHtml(confirmLabel || 'Confirm') + '</button>' +
      '</div>'
    );
    modal.querySelector('[data-act="cancel"]').onclick = () => { Modal.close(); resolve(false); };
    modal.querySelector('[data-act="ok"]').onclick = () => { Modal.close(); resolve(true); };
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

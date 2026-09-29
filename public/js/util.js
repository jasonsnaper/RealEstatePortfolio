// Shared formatting helpers for the owner-facing app and the tenant portal.
// Mirrors server/lib/money.js and dates.js semantics for DISPLAY purposes
// only — the server remains the source of truth for every calculation;
// nothing here recomputes a balance or a status, only formats numbers/dates
// the server already returned.

function centsToDisplay(cents, opts) {
  opts = opts || {};
  if (cents === null || cents === undefined) return '—';
  const n = Number(cents);
  const negative = n < 0;
  const abs = Math.abs(n);
  const whole = Math.floor(abs / 100).toLocaleString('en-US');
  const frac = String(Math.round(abs % 100)).padStart(2, '0');
  const sign = negative ? '-' : (opts.showSign ? '+' : '');
  return sign + '$' + whole + '.' + frac;
}

function dollarsInputToCentsPreview(value) {
  const n = parseFloat(String(value).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

// Compact by default ("Sep 24"), but this app keeps records — leases,
// valuations, mortgages — that span years, so a bare "Jul 1" is genuinely
// ambiguous once history goes back that far. Include the year whenever the
// date isn't in the current year, so older/future entries stay unambiguous
// while everyday recent dates (transactions, this month's due date, upcoming
// deadlines) stay short.
function formatDateShort(dateStr) {
  if (!dateStr) return '—';
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  const opts = { month: 'short', day: 'numeric', timeZone: 'UTC' };
  if (y !== new Date().getFullYear()) opts.year = 'numeric';
  return dt.toLocaleDateString('en-US', opts);
}

// A "start – end" range where only one side needs the year (say a lease
// that runs into next year) reads oddly with the year on just one side —
// show it on both once either end needs it, so the pair stays symmetric.
function formatDateRange(startStr, endStr) {
  if (!startStr) return '—';
  const startYear = Number(String(startStr).split('-')[0]);
  const endYear = endStr ? Number(String(endStr).split('-')[0]) : startYear;
  const currentYear = new Date().getFullYear();
  const forceYear = startYear !== currentYear || endYear !== currentYear;
  const fmt = (s) => {
    if (!s) return '—';
    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d, 12));
    const opts = { month: 'short', day: 'numeric', timeZone: 'UTC' };
    if (forceYear || y !== currentYear) opts.year = 'numeric';
    return dt.toLocaleDateString('en-US', opts);
  };
  return fmt(startStr) + ' – ' + fmt(endStr);
}

function formatDateTime(isoLike) {
  if (!isoLike) return '—';
  const d = new Date(isoLike.includes('Z') || isoLike.includes('+') ? isoLike : isoLike + 'Z');
  if (isNaN(d.getTime())) return isoLike;
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

const STATUS_LABEL = { upcoming: 'Upcoming', due: 'Due', partial: 'Partially paid', paid: 'Paid', late: 'Late' };

function statusPill(status) {
  const label = STATUS_LABEL[status] || status;
  return '<span class="status ' + status + '"><span class="dot"></span>' + label + '</span>';
}

function qs(sel, root) { return (root || document).querySelector(sel); }
function qsa(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/** Resize/compress an image client-side before upload, so a 12MB phone photo
 * doesn't need to cross the wire at full resolution. Keeps the app usable on
 * mobile data. Falls back to the original file if canvas processing fails. */
function compressImage(file, maxDim, quality) {
  maxDim = maxDim || 1600; quality = quality || 0.82;
  return new Promise((resolve) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = (e) => {
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          if (width > height) { height = Math.round(height * (maxDim / width)); width = maxDim; }
          else { width = Math.round(width * (maxDim / height)); height = maxDim; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        try {
          resolve(canvas.toDataURL('image/jpeg', quality));
        } catch (err) {
          resolve(e.target.result);
        }
      };
      img.onerror = () => resolve(e.target.result);
      img.src = e.target.result;
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

function debounce(fn, ms) {
  let t;
  return function (...args) { clearTimeout(t); t = setTimeout(() => fn.apply(this, args), ms); };
}

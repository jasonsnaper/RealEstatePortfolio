/** Minimal HTML-escaping for the few places we interpolate DB text into a
 * server-rendered page (the mock checkout page shows property/tenant names). */
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

module.exports = { escapeHtml };

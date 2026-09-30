// Word-wrapping for paragraph text in generated PDFs. server/lib/pdf.js's
// text() draws one line at a fixed position — it has no idea how wide a
// string is, so anything longer than the page's content width would either
// run off the page or have to be wrapped by hand at the call site.
// server/lib/statements.js never needed this (its content is short, fixed
// table cells), but a lease agreement's clause text is real paragraphs, so
// this module measures and wraps text using the standard Helvetica /
// Helvetica-Bold metrics — the same two base-14 fonts server/lib/pdf.js
// embeds by reference (no font file, no npm dependency; every PDF viewer
// carries these metrics built in, which is exactly why the base-14 fonts
// don't need to be embedded).
//
// Widths below are the standard Adobe AFM character widths (1/1000 em) for
// Helvetica and Helvetica-Bold, covering the printable ASCII range (32-126)
// that this app's lease templates and form fields actually use. A
// character outside that range (an accented letter, a curly quote that
// pdf.js's WinAnsi table can still draw) falls back to a reasonable average
// width rather than failing — wrapping is a layout aid, not exact
// typesetting, so an approximate width for a rare character just means a
// line break lands a few points earlier or later than ideal.

const HELVETICA_WIDTHS = {
  32: 278, 33: 278, 34: 355, 35: 556, 36: 556, 37: 889, 38: 667, 39: 191,
  40: 333, 41: 333, 42: 389, 43: 584, 44: 278, 45: 333, 46: 278, 47: 278,
  48: 556, 49: 556, 50: 556, 51: 556, 52: 556, 53: 556, 54: 556, 55: 556, 56: 556, 57: 556,
  58: 278, 59: 278, 60: 584, 61: 584, 62: 584, 63: 556, 64: 1015,
  65: 667, 66: 667, 67: 722, 68: 722, 69: 667, 70: 611, 71: 778, 72: 722, 73: 278, 74: 500,
  75: 667, 76: 556, 77: 833, 78: 722, 79: 778, 80: 667, 81: 778, 82: 722, 83: 667, 84: 611,
  85: 722, 86: 667, 87: 944, 88: 667, 89: 667, 90: 611,
  91: 278, 92: 278, 93: 278, 94: 469, 95: 556, 96: 333,
  97: 556, 98: 556, 99: 500, 100: 556, 101: 556, 102: 278, 103: 556, 104: 556, 105: 222, 106: 222,
  107: 500, 108: 222, 109: 833, 110: 556, 111: 556, 112: 556, 113: 556, 114: 333, 115: 500, 116: 278,
  117: 556, 118: 500, 119: 722, 120: 500, 121: 500, 122: 500,
  123: 334, 124: 260, 125: 334, 126: 584,
};
const HELVETICA_BOLD_WIDTHS = {
  32: 278, 33: 333, 34: 474, 35: 556, 36: 556, 37: 889, 38: 722, 39: 238,
  40: 333, 41: 333, 42: 389, 43: 584, 44: 278, 45: 333, 46: 278, 47: 278,
  48: 556, 49: 556, 50: 556, 51: 556, 52: 556, 53: 556, 54: 556, 55: 556, 56: 556, 57: 556,
  58: 333, 59: 333, 60: 584, 61: 584, 62: 584, 63: 611, 64: 975,
  65: 722, 66: 722, 67: 722, 68: 722, 69: 667, 70: 611, 71: 778, 72: 722, 73: 278, 74: 556,
  75: 722, 76: 611, 77: 833, 78: 722, 79: 778, 80: 667, 81: 778, 82: 722, 83: 667, 84: 611,
  85: 722, 86: 667, 87: 944, 88: 667, 89: 667, 90: 611,
  91: 333, 92: 278, 93: 333, 94: 584, 95: 556, 96: 333,
  97: 556, 98: 611, 99: 556, 100: 611, 101: 556, 102: 333, 103: 611, 104: 611, 105: 278, 106: 278,
  107: 556, 108: 278, 109: 889, 110: 611, 111: 611, 112: 611, 113: 611, 114: 389, 115: 556, 116: 333,
  117: 611, 118: 556, 119: 778, 120: 556, 121: 556, 122: 500,
  123: 394, 124: 220, 125: 394, 126: 520,
};
const FALLBACK_WIDTH = 556; // roughly the average glyph width in both faces — used for anything outside 32-126

function widthTableFor(font) {
  return font === 'F2' ? HELVETICA_BOLD_WIDTHS : HELVETICA_WIDTHS;
}

/** Width, in PDF points, that `str` would render at with the given font/size. */
function measureText(str, { size = 10, font = 'F1' } = {}) {
  const table = widthTableFor(font);
  let units = 0;
  for (const ch of String(str == null ? '' : str)) {
    const code = ch.codePointAt(0);
    units += table[code] !== undefined ? table[code] : FALLBACK_WIDTH;
  }
  return (units / 1000) * size;
}

/**
 * Wrap `text` into an array of lines that each fit within maxWidthPts.
 * Existing newlines are treated as hard paragraph breaks (including a blank
 * line for two consecutive newlines, so callers don't lose paragraph
 * spacing); within a paragraph, lines break on whitespace. A single word
 * wider than maxWidthPts on its own (a long URL, say) is hard-split by
 * character rather than overflowing the page.
 */
function wrapText(text, maxWidthPts, { size = 10, font = 'F1' } = {}) {
  const lines = [];
  const paragraphs = String(text == null ? '' : text).split('\n');
  for (const paragraph of paragraphs) {
    if (paragraph.trim() === '') { lines.push(''); continue; }
    const words = paragraph.split(/\s+/).filter(Boolean);
    let current = '';
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (measureText(candidate, { size, font }) <= maxWidthPts) {
        current = candidate;
        continue;
      }
      if (current) lines.push(current);
      if (measureText(word, { size, font }) <= maxWidthPts) {
        current = word;
      } else {
        // Single word too wide on its own — hard-split by character.
        let piece = '';
        for (const ch of word) {
          const candidatePiece = piece + ch;
          if (measureText(candidatePiece, { size, font }) > maxWidthPts && piece) {
            lines.push(piece);
            piece = ch;
          } else {
            piece = candidatePiece;
          }
        }
        current = piece;
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}

module.exports = { measureText, wrapText };

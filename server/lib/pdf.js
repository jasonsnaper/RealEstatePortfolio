// A minimal, dependency-free PDF writer. This app has zero npm dependencies
// by design (see README) and this sandbox's npm registry access is blocked
// outright (403) at the time of writing, so pulling in a PDF library isn't
// just a style choice here — it isn't reachable. The PDF spec's text-drawing
// primitives are small enough to hand-write and, importantly, fully test:
// this module only ever emits the handful of operators used below (show
// text, move to a position, stroke a straight line), nothing fancier, and
// every byte of the output is produced by this file — nothing to trust
// blindly from a library whose exact behavior we can't verify in-sandbox.
//
// Coordinate system note (this trips people up): PDF's origin is the
// BOTTOM-LEFT of the page, y increasing upward — the opposite of a browser's
// top-left/y-down system. Every y coordinate passed into this module is a
// PDF y (distance from the bottom), not a "distance from the top".

const PAGE_WIDTH = 612; // US Letter, points (72pt = 1 inch)
const PAGE_HEIGHT = 792;

// The fonts below declare /Encoding /WinAnsiEncoding (~= Windows-1252), and
// the Tj operator takes exactly one BYTE per glyph in that encoding — it is
// NOT UTF-8. Naively UTF-8-encoding a JS string containing an en dash or a
// "·" separator therefore emits multi-byte sequences that a PDF viewer
// reads back as several wrong WinAnsi characters apiece (caught by actually
// running pdftotext on a generated statement during testing: "·" came back
// as "Â·", "–" as "â€""). WinAnsiEncoding matches Latin-1/Unicode byte-for-
// byte everywhere except the 0x80-0x9F block, which it spends on curly
// quotes, dashes, ellipsis, etc. — so those code points need an explicit
// table, and anything truly outside WinAnsi's repertoire (CJK, emoji) falls
// back to '?' rather than corrupting the bytes after it.
const WIN_ANSI_HIGH = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85,
  0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a,
  0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92,
  0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
  0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c,
  0x017e: 0x9e, 0x0178: 0x9f,
};
function toWinAnsiByte(codePoint) {
  if (codePoint >= 0x20 && codePoint <= 0x7e) return codePoint; // ASCII
  if (codePoint >= 0xa0 && codePoint <= 0xff) return codePoint; // Latin-1 supplement == WinAnsi here
  if (WIN_ANSI_HIGH[codePoint] !== undefined) return WIN_ANSI_HIGH[codePoint];
  return 0x3f; // '?' — no WinAnsi glyph for this code point
}
// Re-encodes a JS (Unicode) string into a JS string whose char codes are
// each a single WinAnsi BYTE value (0-255). PdfDocument#save() then writes
// the whole document with Buffer.from(str, 'latin1'), which maps each char
// code straight to one output byte — the pairing that makes this correct.
function toWinAnsiString(str) {
  let out = '';
  for (const ch of String(str == null ? '' : str)) out += String.fromCharCode(toWinAnsiByte(ch.codePointAt(0)));
  return out;
}

function escapePdfText(str) {
  return toWinAnsiString(str).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

class PdfPage {
  constructor() {
    this.ops = [];
  }
  /** Draw text with its baseline at (x, y) in PDF points, y from the bottom. */
  text(x, y, str, { size = 10, font = 'F1' } = {}) {
    this.ops.push(`BT /${font} ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td (${escapePdfText(str)}) Tj ET`);
    return this;
  }
  /** A straight line from (x1,y1) to (x2,y2), both in PDF points. */
  line(x1, y1, x2, y2, { width = 0.75 } = {}) {
    this.ops.push(`${width} w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S`);
    return this;
  }
  toStream() {
    return this.ops.join('\n');
  }
}

class PdfDocument {
  constructor() {
    this.pages = [];
  }
  addPage() {
    const page = new PdfPage();
    this.pages.push(page);
    return page;
  }
  /** Serializes the whole document to a Buffer — a valid, minimal PDF file. */
  save() {
    const objects = []; // 1-indexed; objects[i-1] is object number i's body string
    const fontRegularNum = objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const fontBoldNum = objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');

    const pagesObjNum = objects.length + 1 + this.pages.length * 2; // reserved below; computed after we know page object numbers
    const pageObjNums = [];
    const contentObjNums = [];
    for (const page of this.pages) {
      const stream = page.toStream();
      // 'latin1' here (not 'utf8') because toStream()'s text ops were already
      // reduced to one-char-code-per-byte WinAnsi strings by escapePdfText —
      // see the note atop this file. The /Length must match the byte count
      // save() actually writes below, which uses the same 'latin1' encoding.
      const contentNum = objects.push(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
      contentObjNums.push(contentNum);
      // Page object body is filled in below once we know the real Pages object number.
      pageObjNums.push(objects.push('PLACEHOLDER'));
    }
    const realPagesObjNum = objects.length + 1;
    for (let i = 0; i < this.pages.length; i++) {
      objects[pageObjNums[i] - 1] =
        `<< /Type /Page /Parent ${realPagesObjNum} 0 R /Resources << /Font << /F1 ${fontRegularNum} 0 R /F2 ${fontBoldNum} 0 R >> >> ` +
        `/MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Contents ${contentObjNums[i]} 0 R >>`;
    }
    const pagesNum = objects.push(`<< /Type /Pages /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${this.pages.length} >>`);
    const catalogNum = objects.push(`<< /Type /Catalog /Pages ${pagesNum} 0 R >>`);

    // --- Serialize: header, each numbered object, xref table, trailer ---
    const chunks = [];
    let offset = 0;
    function write(str) {
      // 'latin1': every object body here is pure ASCII PDF syntax EXCEPT the
      // page content streams, which are pre-encoded WinAnsi byte-strings (see
      // escapePdfText) — 'latin1' passes ASCII through unchanged and maps
      // those WinAnsi char codes straight to their intended single byte.
      // 'utf8' would re-encode any byte above 0x7F as multiple bytes,
      // corrupting text and desyncing it from the /Length already computed.
      const buf = Buffer.from(str, 'latin1');
      chunks.push(buf);
      offset += buf.length;
      return offset;
    }

    write('%PDF-1.4\n');
    const objOffsets = [0]; // index 0 unused (object 0 is the free-list head, per spec)
    for (let i = 0; i < objects.length; i++) {
      objOffsets.push(offset);
      write(`${i + 1} 0 obj\n${objects[i]}\nendobj\n`);
    }
    const xrefStart = offset;
    write(`xref\n0 ${objects.length + 1}\n`);
    write('0000000000 65535 f \n');
    for (let i = 1; i <= objects.length; i++) {
      write(`${String(objOffsets[i]).padStart(10, '0')} 00000 n \n`);
    }
    write(`trailer\n<< /Size ${objects.length + 1} /Root ${catalogNum} 0 R >>\nstartxref\n${xrefStart}\n%%EOF`);

    return Buffer.concat(chunks);
  }
}

module.exports = { PdfDocument, PAGE_WIDTH, PAGE_HEIGHT };

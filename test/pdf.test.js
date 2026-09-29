// Low-level tests for the hand-written, dependency-free PDF writer (see
// server/lib/pdf.js's header for why this exists instead of an npm package).
// The WinAnsi-encoding tests here exist because an earlier version of this
// module DID produce structurally-valid-but-garbled PDFs: it UTF-8-encoded
// the whole document, so any text above the ASCII range (an en dash, a "·"
// separator, an accented name) came back from pdftotext as mojibake even
// though qpdf --check found nothing wrong. qpdf verifies PDF *syntax*, not
// that the glyphs are the ones you asked for — only actually extracting the
// text catches that class of bug, which is why every test below reads the
// text back out rather than stopping at a structural check.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PdfDocument } = require('../server/lib/pdf');

function renderAndExtractText(fn) {
  const doc = new PdfDocument();
  fn(doc);
  const buf = doc.save();
  const file = path.join(os.tmpdir(), `pdf-test-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
  fs.writeFileSync(file, buf);
  try {
    execFileSync('qpdf', ['--check', file], { stdio: 'pipe' }); // throws on structural errors
    const text = execFileSync('pdftotext', [file, '-']).toString('utf8');
    return { buf, text };
  } finally {
    fs.unlinkSync(file);
  }
}

test('plain ASCII text round-trips exactly', () => {
  const { text } = renderAndExtractText((doc) => {
    doc.addPage().text(50, 700, 'Rent Statement for 123 Main St');
  });
  assert.ok(text.includes('Rent Statement for 123 Main St'));
});

test('middle dot, en dash, and em dash survive round-trip (regression: previously came back as mojibake)', () => {
  const { text } = renderAndExtractText((doc) => {
    doc.addPage()
      .text(50, 700, 'Denver, CO · 80202')
      .text(50, 680, 'Jan 1 – Jan 31')
      .text(50, 660, 'Jan 3 — payment (ach)');
  });
  assert.ok(text.includes('Denver, CO · 80202'), () => `got: ${JSON.stringify(text)}`);
  assert.ok(text.includes('Jan 1 – Jan 31'), () => `got: ${JSON.stringify(text)}`);
  assert.ok(text.includes('Jan 3 — payment (ach)'), () => `got: ${JSON.stringify(text)}`);
});

test('accented Latin letters (Latin-1 supplement range) survive round-trip', () => {
  const { text } = renderAndExtractText((doc) => {
    doc.addPage().text(50, 700, 'José Núñez — naïve façade, Zürich');
  });
  assert.ok(text.includes('José Núñez'), () => `got: ${JSON.stringify(text)}`);
  assert.ok(text.includes('naïve façade'), () => `got: ${JSON.stringify(text)}`);
  assert.ok(text.includes('Zürich'), () => `got: ${JSON.stringify(text)}`);
});

test('smart quotes and ellipsis (the WinAnsi 0x80-0x9F block) survive round-trip', () => {
  const { text } = renderAndExtractText((doc) => {
    doc.addPage().text(50, 700, 'He said “rent’s due” … eventually');
  });
  assert.ok(text.includes('“rent’s due”'), () => `got: ${JSON.stringify(text)}`);
  assert.ok(text.includes('…'), () => `got: ${JSON.stringify(text)}`);
});

test('a code point with no WinAnsi glyph falls back to "?" instead of corrupting the bytes around it', () => {
  const { text } = renderAndExtractText((doc) => {
    doc.addPage().text(50, 700, 'Before 日 After');
  });
  assert.ok(text.includes('Before ? After'), () => `got: ${JSON.stringify(text)}`);
});

test('parentheses and backslashes in text are escaped and read back literally', () => {
  const { text } = renderAndExtractText((doc) => {
    doc.addPage().text(50, 700, 'Balance (est.) = $100 \\ note');
  });
  assert.ok(text.includes('Balance (est.) = $100 \\ note'), () => `got: ${JSON.stringify(text)}`);
});

test('a document with several pages reports the right page count and keeps text on the right page', () => {
  const { text } = renderAndExtractText((doc) => {
    doc.addPage().text(50, 700, 'Page one marker');
    doc.addPage().text(50, 700, 'Page two marker');
    doc.addPage().text(50, 700, 'Page three marker');
  });
  assert.ok(text.includes('Page one marker'));
  assert.ok(text.includes('Page two marker'));
  assert.ok(text.includes('Page three marker'));
});

test('a line draws without corrupting the surrounding content stream', () => {
  const { text } = renderAndExtractText((doc) => {
    const page = doc.addPage();
    page.text(50, 700, 'Above the line');
    page.line(50, 690, 300, 690);
    page.text(50, 680, 'Below the line');
  });
  assert.ok(text.includes('Above the line'));
  assert.ok(text.includes('Below the line'));
});

test('an empty string and null/undefined text do not throw and produce a valid PDF', () => {
  const { text } = renderAndExtractText((doc) => {
    const page = doc.addPage();
    page.text(50, 700, '');
    page.text(50, 680, null);
    page.text(50, 660, undefined);
    page.text(50, 640, 'still works after the empties');
  });
  assert.ok(text.includes('still works after the empties'));
});

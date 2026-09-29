// Direct tests of the pure-logic half of public/js/components.js's photo
// picker (see views/property.js's three upload sites: cover photo, general
// photos, maintenance photos). The DOM/File-API half (previews, HEIC
// conversion, the three picker buttons) has no meaningful Node equivalent —
// it's verified by hand and via Playwright instead (see README's "Verified
// by hand" section for exactly what was and wasn't exercised on a real
// mobile browser).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { isHeicFile, isUsableImageFile } = require(path.join(__dirname, '..', 'public', 'js', 'components.js'));

test('isHeicFile recognizes HEIC/HEIF by MIME type', () => {
  assert.equal(isHeicFile({ type: 'image/heic', name: 'IMG_0001.HEIC' }), true);
  assert.equal(isHeicFile({ type: 'image/heif', name: 'photo' }), true);
});

test('isHeicFile falls back to file extension when type is blank (Safari often reports none)', () => {
  assert.equal(isHeicFile({ type: '', name: 'IMG_0002.heic' }), true);
  assert.equal(isHeicFile({ type: '', name: 'IMG_0003.HEIF' }), true);
  assert.equal(isHeicFile({ type: '', name: 'IMG_0004.jpg' }), false);
});

test('isHeicFile is false for ordinary images and missing files', () => {
  assert.equal(isHeicFile({ type: 'image/jpeg', name: 'a.jpg' }), false);
  assert.equal(isHeicFile({ type: 'image/png', name: 'a.png' }), false);
  assert.equal(isHeicFile(null), false);
  assert.equal(isHeicFile(undefined), false);
});

test('isUsableImageFile accepts any image/* type and HEIC, rejects everything else', () => {
  assert.equal(isUsableImageFile({ type: 'image/jpeg', name: 'a.jpg' }), true);
  assert.equal(isUsableImageFile({ type: 'image/webp', name: 'a.webp' }), true);
  assert.equal(isUsableImageFile({ type: '', name: 'a.heic' }), true); // HEIC with blank type
  assert.equal(isUsableImageFile({ type: 'application/pdf', name: 'lease.pdf' }), false);
  assert.equal(isUsableImageFile({ type: 'text/plain', name: 'notes.txt' }), false);
  assert.equal(isUsableImageFile(null), false);
});

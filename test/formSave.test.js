// Direct tests of the pure-logic half of public/js/components.js's shared
// save-lifecycle helpers (see wireSave/wireAction, used by every "Add/Edit
// X" modal in views/property.js, views/bankAccounts.js, and views/
// dashboard.js). describeApiError is the only piece with no DOM/Api.js
// dependency — it duck-types the error shape specifically so it can be
// tested here rather than only by hand. The rest (Modal's dirty-tracking and
// guarded close, wireSave/wireAction's busy-state and duplicate-submit
// guard, the "Discard unsaved changes?" prompt) needs a real DOM and is
// verified by hand/Playwright instead — see README's "Verified by hand"
// section for exactly what was exercised.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { describeApiError } = require(path.join(__dirname, '..', 'public', 'js', 'components.js'));

test('describeApiError gives a fixed message for an expired session', () => {
  assert.equal(describeApiError({ status: 401, message: 'raw server text' }), 'Your session has expired. Please sign in again.');
});

test('describeApiError passes through the server\'s own message for ordinary 4xx errors', () => {
  assert.equal(describeApiError({ status: 404, message: 'This lease no longer exists.' }), 'This lease no longer exists.');
  assert.equal(describeApiError({ status: 409, message: 'This charge is already fully paid.' }), 'This charge is already fully paid.');
  assert.equal(describeApiError({ status: 400, message: 'Amount must be greater than zero.' }), 'Amount must be greater than zero.');
});

test('describeApiError gives a generic retry message for 5xx/server errors', () => {
  assert.equal(describeApiError({ status: 500, message: 'stack trace nobody should see' }), 'The server hit a problem handling this. Please try again in a moment.');
  assert.equal(describeApiError({ status: 503, code: 'server', message: 'x' }), 'The server hit a problem handling this. Please try again in a moment.');
});

test('describeApiError passes through timeout/network messages as-is (Api.js already phrases these plainly)', () => {
  assert.equal(describeApiError({ status: 0, code: 'timeout', message: 'That took too long to respond. Check your connection and try again.' }), 'That took too long to respond. Check your connection and try again.');
  assert.equal(describeApiError({ status: 0, code: 'network', message: 'Couldn’t reach the server. Check your connection and try again.' }), 'Couldn’t reach the server. Check your connection and try again.');
});

test('describeApiError falls back to a generic message for a non-API-shaped error or nothing at all', () => {
  assert.equal(describeApiError(new Error('some other bug')), 'some other bug');
  assert.equal(describeApiError({}), 'Something went wrong. Please try again.');
  assert.equal(describeApiError(null), 'Something went wrong. Please try again.');
  assert.equal(describeApiError(undefined), 'Something went wrong. Please try again.');
});

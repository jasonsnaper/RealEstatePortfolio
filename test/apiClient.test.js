// Direct tests of public/js/api.js — the fetch wrapper at the center of the
// "Get payment link" bug (see views/property.js): the old version had no
// catch handler and no request timeout, so a stalled or failed request left
// the UI spinning forever. This file has no DOM dependency, so it can be
// loaded and exercised directly under Node against a real HTTP server,
// rather than only reasoned about — a slow/hanging endpoint really does
// produce a `code: 'timeout'` ApiError here, not a mocked one.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');

const Api = require(path.join(__dirname, '..', 'public', 'js', 'api.js'));

let server, baseUrl;

before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/ok') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ hello: 'world' }));
    } else if (req.url === '/not-found') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Lease not found' }));
    } else if (req.url === '/conflict') {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'This tenant has no outstanding balance to collect right now' }));
    } else if (req.url === '/boom') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    } else if (req.url === '/hang') {
      // Deliberately never respond, to exercise the client-side timeout —
      // this is the exact failure mode the original bug report described:
      // "a rejected or stalled request leaves the modal loading indefinitely."
    } else {
      res.writeHead(404); res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('a normal 200 JSON response resolves with the parsed body', async () => {
  const data = await Api.get(`${baseUrl}/ok`);
  assert.deepEqual(data, { hello: 'world' });
});

test('a 404 rejects with an ApiError carrying the status and the server’s own message', async () => {
  await assert.rejects(
    () => Api.get(`${baseUrl}/not-found`),
    (err) => {
      assert.ok(err instanceof Api.ApiError);
      assert.equal(err.status, 404);
      assert.equal(err.code, 'http');
      assert.equal(err.message, 'Lease not found');
      return true;
    }
  );
});

test('a 409 (e.g. "no outstanding balance") surfaces the server’s exact plain-language message', async () => {
  await assert.rejects(
    () => Api.post(`${baseUrl}/conflict`, {}),
    (err) => {
      assert.equal(err.status, 409);
      assert.equal(err.message, 'This tenant has no outstanding balance to collect right now');
      return true;
    }
  );
});

test('a 5xx is classified as a "server" error distinct from a plain 4xx', async () => {
  await assert.rejects(
    () => Api.get(`${baseUrl}/boom`),
    (err) => {
      assert.equal(err.status, 500);
      assert.equal(err.code, 'server');
      return true;
    }
  );
});

test('a request that never gets a response times out with code "timeout", bounded by timeoutMs (never hangs forever)', async () => {
  const start = Date.now();
  await assert.rejects(
    () => Api.get(`${baseUrl}/hang`, { timeoutMs: 300 }),
    (err) => {
      assert.ok(err instanceof Api.ApiError);
      assert.equal(err.code, 'timeout');
      assert.equal(err.status, 0);
      return true;
    }
  );
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 5000, `expected the request to time out quickly (bounded by timeoutMs), took ${elapsed}ms`);
});

test('a request to an address with nothing listening is classified as "network", not left unhandled', async () => {
  await assert.rejects(
    () => Api.get('http://127.0.0.1:1/nothing-here', { timeoutMs: 2000 }),
    (err) => {
      assert.ok(err instanceof Api.ApiError);
      assert.equal(err.code, 'network');
      assert.equal(err.status, 0);
      return true;
    }
  );
});

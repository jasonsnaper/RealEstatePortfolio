// A tiny router so we don't need Express (or any npm package) to get clean
// route definitions. Handles path params (:id), JSON bodies, and cookies.
// This is intentionally small and readable rather than feature-complete —
// it does exactly what this app's API needs.

const { URL } = require('url');

class Router {
  constructor() {
    this.routes = []; // { method, pattern: RegExp, keys: [...], handler }
  }

  _register(method, path, handler) {
    const keys = [];
    const pattern = new RegExp(
      '^' +
        path
          .split('/')
          .map((seg) => {
            if (seg.startsWith(':')) {
              keys.push(seg.slice(1));
              return '([^/]+)';
            }
            return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          })
          .join('/') +
        '$'
    );
    this.routes.push({ method, pattern, keys, handler });
  }

  get(path, handler) { this._register('GET', path, handler); }
  post(path, handler) { this._register('POST', path, handler); }
  put(path, handler) { this._register('PUT', path, handler); }
  patch(path, handler) { this._register('PATCH', path, handler); }
  delete(path, handler) { this._register('DELETE', path, handler); }

  match(method, pathname) {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const m = route.pattern.exec(pathname);
      if (m) {
        const params = {};
        route.keys.forEach((key, i) => { params[key] = decodeURIComponent(m[i + 1]); });
        return { handler: route.handler, params };
      }
    }
    return null;
  }
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  }
  return out;
}

/** Read and parse a JSON request body, with a size cap to avoid abuse. */
function readJsonBody(req, maxBytes = 15 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(Object.assign(new Error('Invalid JSON body'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function handleRequest(router, req, res) {
  const url = new URL(req.url, 'http://localhost');
  const match = router.match(req.method, url.pathname);
  if (!match) return sendJson(res, 404, { error: 'Not found' });

  req.params = match.params;
  req.query = Object.fromEntries(url.searchParams.entries());
  req.cookies = parseCookies(req.headers.cookie);

  if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
    try {
      req.body = await readJsonBody(req);
    } catch (e) {
      return sendJson(res, e.statusCode || 400, { error: e.message });
    }
  } else {
    req.body = {};
  }

  try {
    await match.handler(req, res);
  } catch (e) {
    if (e && e.statusCode) {
      sendJson(res, e.statusCode, { error: e.message });
    } else {
      console.error('Unhandled error:', e);
      sendJson(res, 500, { error: 'Internal server error' });
    }
  }
}

function apiError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

module.exports = { Router, handleRequest, sendJson, apiError, parseCookies };

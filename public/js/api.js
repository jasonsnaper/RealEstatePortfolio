// Thin fetch wrapper. Every call goes through here so auth failures (401)
// can be handled in exactly one place: bounce to the sign-in screen.

const Api = (function () {
  // 'timeout'/'network' (status 0) mean the request never got a response at
  // all — worth telling apart from 'http' (status came back, just an error
  // status) because "retry" makes sense for the first two but a 4xx usually
  // won't change on retry alone.
  class ApiError extends Error {
    // `data` is the full parsed JSON error body (when the server sent one),
    // for the rare caller that needs more than the message — e.g. a failed
    // SMS send still returns a real sms_messages row to display, not just an
    // error string. Most callers only ever need .message/.status/.code.
    constructor(status, message, code, data) { super(message); this.status = status; this.code = code || 'http'; this.data = data; }
  }

  const DEFAULT_TIMEOUT_MS = 20000;

  async function request(method, path, body, opts) {
    opts = opts || {};
    const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    const fetchOpts = { method, headers: {}, credentials: 'same-origin' };
    if (body !== undefined) {
      fetchOpts.headers['Content-Type'] = 'application/json';
      fetchOpts.body = JSON.stringify(body);
    }
    const controller = new AbortController();
    fetchOpts.signal = controller.signal;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res;
    try {
      res = await fetch(path, fetchOpts);
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new ApiError(0, 'That took too long to respond. Check your connection and try again.', 'timeout');
      }
      throw new ApiError(0, 'Couldn’t reach the server. Check your connection and try again.', 'network');
    } finally {
      clearTimeout(timer);
    }

    let data = null;
    const text = await res.text();
    if (text) { try { data = JSON.parse(text); } catch (e) { data = text; } }
    if (!res.ok) {
      const message = (data && data.error) || ('Request failed (' + res.status + ')');
      throw new ApiError(res.status, message, res.status >= 500 ? 'server' : 'http', data);
    }
    return data;
  }

  return {
    get: (path, opts) => request('GET', path, undefined, opts),
    post: (path, body, opts) => request('POST', path, body || {}, opts),
    put: (path, body, opts) => request('PUT', path, body || {}, opts),
    del: (path, opts) => request('DELETE', path, undefined, opts),
    ApiError,
  };
})();

// This file has no DOM dependency (unlike the view modules), so its
// timeout/error-classification logic can run and be tested directly under
// Node — see test/apiClient.test.js. A no-op in the browser, where `module`
// doesn't exist.
if (typeof module !== 'undefined') module.exports = Api;

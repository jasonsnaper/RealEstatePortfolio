const { sendJson } = require('../lib/router');
const { getStorageStatus } = require('../lib/storageStatus');

// Deliberately unauthenticated: this exposes only booleans about which env
// vars are set and whether the host looks like a real deployment — never a
// path, a value, or anything else sensitive. It has to be readable before
// sign-in (even before first-run setup) because that is exactly when an
// owner is about to start entering real data, and the frontend shows this
// as a persistent banner on every screen, signed in or not (see
// public/js/app.js's boot()).
function registerSystemStatusRoutes(router) {
  router.get('/api/system-status', async (req, res) => {
    sendJson(res, 200, getStorageStatus());
  });
}

module.exports = { registerSystemStatusRoutes };

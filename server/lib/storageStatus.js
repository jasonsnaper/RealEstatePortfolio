// Detects the single most damaging deployment mistake this app can make:
// running on a host that replaces its filesystem on every restart/redeploy
// (Render, Railway, Heroku, and most other PaaS platforms) WITHOUT DATA_DIR
// and UPLOADS_DIR pointed at that platform's separate persistent disk/volume
// (see server/db.js for what those two env vars do). Left undetected, this
// fails silently: the app works perfectly for as long as one process instance
// stays up, then quietly resets to empty on the next restart — which looks
// exactly like "my data disappeared" with no error anywhere to explain why.
//
// Detection deliberately does NOT depend on the owner having configured
// anything correctly yet (APP_BASE_URL, in particular, is easy to forget) —
// it keys off environment variables the platforms themselves set
// automatically on every deployment, so the warning fires from the very
// first deploy, before the owner has entered anything worth losing.

function isLikelyEphemeralHost() {
  return !!(
    process.env.RENDER || // Render sets this on every service, always 'true'
    process.env.RAILWAY_ENVIRONMENT || // Railway
    process.env.DYNO || // Heroku (dyno name, e.g. 'web.1')
    process.env.FLY_APP_NAME || // Fly.io
    process.env.NODE_ENV === 'production' ||
    String(process.env.APP_BASE_URL || '').startsWith('https://')
  );
}

function getStorageStatus() {
  const dataDirConfigured = !!process.env.DATA_DIR;
  const uploadsDirConfigured = !!process.env.UPLOADS_DIR;
  const likelyEphemeralHost = isLikelyEphemeralHost();
  const atRisk = likelyEphemeralHost && (!dataDirConfigured || !uploadsDirConfigured);
  return { dataDirConfigured, uploadsDirConfigured, likelyEphemeralHost, atRisk };
}

const WARNING_LINES = [
  '',
  '################################################################################',
  '#  WARNING: persistent storage does not look configured on what appears to    #',
  '#  be a real deployment. Your database and/or uploaded photos/documents will  #',
  '#  BE LOST the next time this service restarts or redeploys, unless you set  #',
  '#  DATA_DIR and UPLOADS_DIR to point at a persistent disk/volume.             #',
  '#  See README.md, "Before you deploy this beyond your own machine".          #',
  '################################################################################',
  '',
];

/** Logs a loud, impossible-to-miss console warning at startup if at risk. Returns the status either way, so callers (e.g. the /api/system-status route) can also use it. */
function warnIfStorageAtRisk(logger) {
  const status = getStorageStatus();
  if (status.atRisk) {
    (logger || console).error(WARNING_LINES.join('\n'));
  }
  return status;
}

module.exports = { getStorageStatus, warnIfStorageAtRisk, isLikelyEphemeralHost };

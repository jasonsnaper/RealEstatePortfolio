const crypto = require('crypto');

// Password hashing uses Node's built-in scrypt (no external dependency like
// bcrypt needed). Each password gets its own random salt; the salt and hash
// are stored together as "salt:hash" in hex.

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

function newSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

/** Load (or create-on-first-run) a persistent random secret used only for
 * signing purposes we may add later. Never hard-coded, never sent to the
 * browser, generated once per install and kept on disk outside version
 * control. */
function loadOrCreateServerSecret(path, fs) {
  if (fs.existsSync(path)) return fs.readFileSync(path, 'utf8').trim();
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(path, secret, { mode: 0o600 });
  return secret;
}

module.exports = { hashPassword, verifyPassword, newSessionToken, loadOrCreateServerSecret };

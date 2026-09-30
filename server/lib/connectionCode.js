// A short, human-shareable code an owner can hand a renter (verbally, on a
// flyer, in a text they type themselves) so the renter can create their own
// account through the generic /renter portal's "Make a New Account" screen
// and still land in the RIGHT owner's Unassigned Renters list — the
// alternative to sending a per-renter invitation link. See
// server/routes/renterAuth.js's POST /api/renter/signup for how it's
// consumed, and README's "Connection codes" section for the full picture.
//
// Deliberately NOT a JWT or anything self-verifying — it's just an opaque
// lookup key stored on owners.connection_code, checked with a single indexed
// query. That's the right amount of mechanism for "which of my (probably
// few) owners does this code belong to."

const crypto = require('crypto');

// Excludes visually-ambiguous characters (0/O, 1/I/L) since this is meant to
// be read aloud or copied from a printed page, not just pasted.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

function generateCode() {
  let code = '';
  const bytes = crypto.randomBytes(CODE_LENGTH);
  for (let i = 0; i < CODE_LENGTH; i++) code += ALPHABET[bytes[i] % ALPHABET.length];
  return code;
}

/** Returns this owner's existing connection code, minting one on first use. Retries on the astronomically unlikely chance of a collision (~1 in 32^8). */
function getOrCreateConnectionCode(db, ownerId) {
  const owner = db.prepare('SELECT connection_code FROM owners WHERE id = ?').get(ownerId);
  if (owner && owner.connection_code) return owner.connection_code;
  return regenerateConnectionCode(db, ownerId);
}

function regenerateConnectionCode(db, ownerId) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCode();
    const collision = db.prepare('SELECT id FROM owners WHERE connection_code = ?').get(code);
    if (collision) continue;
    db.prepare('UPDATE owners SET connection_code = ? WHERE id = ?').run(code, ownerId);
    return code;
  }
  throw Object.assign(new Error('Could not generate a unique connection code — try again.'), { statusCode: 500 });
}

function findOwnerByConnectionCode(db, code) {
  if (!code || !String(code).trim()) return null;
  const normalized = String(code).trim().toUpperCase();
  return db.prepare('SELECT * FROM owners WHERE connection_code = ?').get(normalized) || null;
}

module.exports = { getOrCreateConnectionCode, regenerateConnectionCode, findOwnerByConnectionCode };

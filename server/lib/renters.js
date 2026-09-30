// Shared "find or create a renter identity" logic, used by both the one-time
// backfill migration (server/db.js, populating renters from pre-existing
// lease tenant_name/email columns) and the owner-facing "add a renter to
// this lease" action (server/routes/renterManagement.js). Keeping this in
// one place means both call sites make the exact same de-duplication
// decision, rather than two copies quietly drifting apart over time.
//
// De-duplication is deliberately conservative: two renters are only ever
// treated as the same person when their email matches exactly
// (case-insensitively). Without an email, a fresh renter row is created
// every time — a name match alone is not good enough evidence that two
// different people are the same person, and wrongly merging strangers into
// one login would be far worse than the owner inviting the same person
// twice (which they can fix with mergeRenters below).

function findOrCreateRenter(db, ownerId, { name, email, phone }) {
  const cleanEmail = email ? String(email).trim().toLowerCase() : null;
  const cleanName = String(name || '').trim();
  if (!cleanName) throw Object.assign(new Error('Renter name is required'), { statusCode: 400 });

  if (cleanEmail) {
    const existing = db.prepare('SELECT * FROM renters WHERE owner_id = ? AND email IS NOT NULL AND lower(email) = lower(?)').get(ownerId, cleanEmail);
    if (existing) {
      // Fill in a phone number if we now have one and didn't before; never
      // overwrite the name silently, since the owner may be re-adding someone
      // under a different spelling and clobbering it here would be a surprise.
      if (phone && !existing.phone) {
        db.prepare("UPDATE renters SET phone = ?, updated_at = datetime('now') WHERE id = ?").run(phone, existing.id);
      }
      return db.prepare('SELECT * FROM renters WHERE id = ?').get(existing.id);
    }
  }
  const result = db.prepare('INSERT INTO renters (owner_id, name, email, phone) VALUES (?, ?, ?, ?)').run(ownerId, cleanName, cleanEmail, phone || null);
  return db.prepare('SELECT * FROM renters WHERE id = ?').get(result.lastInsertRowid);
}

/** The renter this row actually resolves to, following merged_into_renter_id (at most one hop deep — merges never chain). */
function resolveRenter(db, renter) {
  if (!renter || !renter.merged_into_renter_id) return renter;
  return db.prepare('SELECT * FROM renters WHERE id = ?').get(renter.merged_into_renter_id) || renter;
}

function serializeRenter(renter) {
  return {
    id: renter.id,
    name: renter.name,
    email: renter.email,
    phone: renter.phone,
    hasAccount: !!renter.password_hash,
    emailVerified: !!renter.email_verified_at,
    mergedIntoRenterId: renter.merged_into_renter_id || null,
    createdAt: renter.created_at,
  };
}

module.exports = { findOrCreateRenter, resolveRenter, serializeRenter };

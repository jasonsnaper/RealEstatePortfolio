const fs = require('fs');
const path = require('path');
const { sendJson } = require('../lib/router');
const { requireAuth, logAudit } = require('../lib/helpers');

const UPLOADS_DIR = path.join(__dirname, '..', '..', 'public', 'uploads');

// ---------------------------------------------------------------------------
// Sample/demo data lives in the same tables as real data, distinguished only
// by properties.is_sample (and bank_accounts.is_sample for an account the
// seed script created). "Removable" means genuinely gone, not just archived
// — a demo property isn't a real asset worth preserving forever the way an
// owner's actual rental history is, and it shouldn't sit in the Archived
// list cluttering things once the owner is ready to add their own
// properties. Every property-scoped table (leases, charges, payments,
// transactions, photos, documents, maintenance, reminders, valuations,
// mortgages, payment links/sessions, ...) cascades from properties via
// ON DELETE CASCADE in the schema, so deleting the property row is enough
// to remove the whole tree in the database; this route additionally cleans
// up the uploaded files on disk, which the database can't cascade for us.
// ---------------------------------------------------------------------------

function registerSampleDataRoutes(router, { db }) {
  router.get('/api/sample-data/status', async (req, res) => {
    const owner = requireAuth(db, req);
    const row = db.prepare("SELECT COUNT(*) AS n FROM properties WHERE owner_id = ? AND is_sample = 1").get(owner.id);
    sendJson(res, 200, { hasSampleData: row.n > 0, count: row.n });
  });

  router.post('/api/sample-data/remove', async (req, res) => {
    const owner = requireAuth(db, req);
    const properties = db.prepare('SELECT id FROM properties WHERE owner_id = ? AND is_sample = 1').all(owner.id);

    for (const p of properties) {
      db.prepare('DELETE FROM properties WHERE id = ?').run(p.id);
      try {
        fs.rmSync(path.join(UPLOADS_DIR, 'properties', String(p.id)), { recursive: true, force: true });
      } catch (e) {
        // Best-effort: the database rows (the source of truth) are already
        // gone either way, so a stray leftover file is not worth failing on.
      }
    }

    // A shared sample bank account only disappears once NOTHING references
    // it any more — if the owner had linked one of their own real properties
    // to a sample account before removing the sample ones, it stays, because
    // it's now genuinely in use.
    const orphanedSampleAccounts = db.prepare(`
      SELECT ba.id FROM bank_accounts ba
      WHERE ba.owner_id = ? AND ba.is_sample = 1
        AND NOT EXISTS (SELECT 1 FROM property_bank_accounts pba WHERE pba.bank_account_id = ba.id)
    `).all(owner.id);
    for (const a of orphanedSampleAccounts) {
      db.prepare('DELETE FROM bank_accounts WHERE id = ?').run(a.id);
    }

    logAudit(db, {
      actorType: 'owner', actorId: owner.id, action: 'remove_sample_data', entityType: 'owner', entityId: owner.id,
      after: { removedProperties: properties.length, removedBankAccounts: orphanedSampleAccounts.length },
    });
    sendJson(res, 200, { removedProperties: properties.length, removedBankAccounts: orphanedSampleAccounts.length });
  });
}

module.exports = { registerSampleDataRoutes };

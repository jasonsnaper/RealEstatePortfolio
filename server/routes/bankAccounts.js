const { apiError, sendJson } = require('../lib/router');
const { requireAuth, getOwnedPropertyOr404, logAudit, runInTransaction } = require('../lib/helpers');
const { dollarsToCents } = require('../lib/money');

// Every account this file returns — manual or connected — is built from this
// one explicit allowlist. A connected account's parent bank_connections row
// holds the access_token; that field is never read here, let alone
// serialized, so there is no code path that can leak it to a client.
function serializeAccount(db, account) {
  const links = db.prepare(`
    SELECT p.id, p.name FROM properties p
    JOIN property_bank_accounts pba ON pba.property_id = p.id
    WHERE pba.bank_account_id = ?
    ORDER BY p.name
  `).all(account.id);

  const connection = account.bank_connection_id
    ? db.prepare('SELECT id, provider, institution_name, status, error_message FROM bank_connections WHERE id = ?').get(account.bank_connection_id)
    : null;

  return {
    id: account.id,
    nickname: account.nickname,
    mode: account.mode, // 'manual' | 'connected'
    institutionName: account.institution_name || (connection ? connection.institution_name : null),
    mask: account.mask || null,
    balanceCents: account.manual_balance_cents,
    balanceType: account.balance_type || (account.mode === 'manual' ? 'manual' : null),
    // Manual accounts are "as of" whatever date the owner typed; connected
    // accounts are "as of" whenever we last actually synced with the provider.
    asOf: account.mode === 'connected' ? account.last_synced_at : account.manual_as_of,
    bankConnectionId: account.bank_connection_id || null,
    connectedProvider: connection ? connection.provider : account.connected_provider,
    // A connection problem is a property of the CONNECTION (the whole bank
    // login), not any one account, so every account sharing a broken
    // connection reports the same needsReconnect/connectionError together.
    connectedStatus: connection ? connection.status : (account.mode === 'connected' ? account.connected_status : null),
    connectionError: connection ? connection.error_message : null,
    needsReconnect: !!(connection && connection.status !== 'active'),
    linkedProperties: links,
    isShared: links.length > 1,
    isSample: !!account.is_sample,
  };
}

function registerBankAccountRoutes(router, { db }) {
  router.get('/api/bank-accounts', async (req, res) => {
    const owner = requireAuth(db, req);
    const rows = db.prepare('SELECT * FROM bank_accounts WHERE owner_id = ? ORDER BY nickname').all(owner.id);
    sendJson(res, 200, rows.map((r) => serializeAccount(db, r)));
  });

  router.get('/api/properties/:id/bank-accounts', async (req, res) => {
    const owner = requireAuth(db, req);
    const property = getOwnedPropertyOr404(db, owner.id, req.params.id);
    const rows = db.prepare(`
      SELECT ba.* FROM bank_accounts ba
      JOIN property_bank_accounts pba ON pba.bank_account_id = ba.id
      WHERE pba.property_id = ? ORDER BY ba.nickname
    `).all(property.id);
    sendJson(res, 200, rows.map((r) => serializeAccount(db, r)));
  });

  router.post('/api/bank-accounts', async (req, res) => {
    const owner = requireAuth(db, req);
    const { nickname, balance, asOf, propertyIds } = req.body;
    if (!nickname || !nickname.trim()) throw apiError(400, 'Account nickname is required');
    const balanceCents = dollarsToCents(balance || 0);

    // Validate every property id BEFORE writing anything, then do all the
    // writing inside a transaction too — belt and suspenders, so a bad id
    // anywhere in the list can never leave behind an account with only some
    // of its intended links (or, on the "add a bank account from inside a
    // rental" flow, an account silently missing the one link the owner
    // actually asked for).
    const propertyIdList = Array.isArray(propertyIds) ? propertyIds : [];
    for (const pid of propertyIdList) getOwnedPropertyOr404(db, owner.id, pid);

    const accountId = runInTransaction(db, () => {
      const result = db.prepare(`
        INSERT INTO bank_accounts (owner_id, nickname, mode, manual_balance_cents, manual_as_of, balance_type)
        VALUES (?, ?, 'manual', ?, ?, 'manual')
      `).run(owner.id, nickname.trim(), balanceCents, asOf || new Date().toISOString().slice(0, 10));
      const id = result.lastInsertRowid;
      for (const pid of propertyIdList) {
        db.prepare('INSERT OR IGNORE INTO property_bank_accounts (property_id, bank_account_id) VALUES (?, ?)').run(pid, id);
      }
      return id;
    });

    logAudit(db, { actorType: 'owner', actorId: owner.id, action: 'create', entityType: 'bank_account', entityId: accountId, after: { nickname, balanceCents, propertyIds: propertyIdList } });
    sendJson(res, 201, serializeAccount(db, db.prepare('SELECT * FROM bank_accounts WHERE id = ?').get(accountId)));
  });

  router.put('/api/bank-accounts/:id', async (req, res) => {
    const owner = requireAuth(db, req);
    const before = db.prepare('SELECT * FROM bank_accounts WHERE id = ? AND owner_id = ?').get(req.params.id, owner.id);
    if (!before) throw apiError(404, 'Bank account not found');

    const { nickname, balance, asOf, propertyIds } = req.body;
    const balanceCents = balance !== undefined ? dollarsToCents(balance) : before.manual_balance_cents;
    if (propertyIds) for (const pid of propertyIds) getOwnedPropertyOr404(db, owner.id, pid);

    runInTransaction(db, () => {
      db.prepare(`
        UPDATE bank_accounts SET nickname=?, manual_balance_cents=?, manual_as_of=?, updated_at=datetime('now') WHERE id=?
      `).run(nickname ? nickname.trim() : before.nickname, balanceCents, asOf || before.manual_as_of, before.id);

      if (propertyIds) {
        db.prepare('DELETE FROM property_bank_accounts WHERE bank_account_id = ?').run(before.id);
        for (const pid of propertyIds) {
          db.prepare('INSERT OR IGNORE INTO property_bank_accounts (property_id, bank_account_id) VALUES (?, ?)').run(pid, before.id);
        }
      }
    });

    logAudit(db, { actorType: 'owner', actorId: owner.id, action: 'update', entityType: 'bank_account', entityId: before.id, before, after: req.body });
    sendJson(res, 200, serializeAccount(db, db.prepare('SELECT * FROM bank_accounts WHERE id = ?').get(before.id)));
  });

  // Full delete — removes the account (and, via ON DELETE CASCADE, every
  // property_bank_accounts row that referenced it) everywhere, not just from
  // one rental. If this was the last account still using its bank_connection
  // (a connected account), the now-unused connection — and the access token
  // it holds — is cleaned up too rather than left orphaned.
  router.delete('/api/bank-accounts/:id', async (req, res) => {
    const owner = requireAuth(db, req);
    const account = db.prepare('SELECT * FROM bank_accounts WHERE id = ? AND owner_id = ?').get(req.params.id, owner.id);
    if (!account) throw apiError(404, 'Bank account not found');

    runInTransaction(db, () => {
      db.prepare('DELETE FROM bank_accounts WHERE id = ?').run(account.id);
      if (account.bank_connection_id) {
        const stillUsed = db.prepare('SELECT COUNT(*) AS n FROM bank_accounts WHERE bank_connection_id = ?').get(account.bank_connection_id).n;
        if (stillUsed === 0) db.prepare('DELETE FROM bank_connections WHERE id = ?').run(account.bank_connection_id);
      }
    });

    logAudit(db, { actorType: 'owner', actorId: owner.id, action: 'delete', entityType: 'bank_account', entityId: account.id, before: account });
    sendJson(res, 200, { ok: true });
  });

  // Link an ACCOUNT THAT ALREADY EXISTS (created from elsewhere, or shared
  // with another rental already) to this rental too — distinct from POST
  // /api/bank-accounts, which creates a brand new manual account. Ownership
  // of both sides is checked independently before the single-row insert.
  router.post('/api/properties/:id/bank-accounts/link', async (req, res) => {
    const owner = requireAuth(db, req);
    const property = getOwnedPropertyOr404(db, owner.id, req.params.id);
    const account = db.prepare('SELECT * FROM bank_accounts WHERE id = ? AND owner_id = ?').get(req.body.bankAccountId, owner.id);
    if (!account) throw apiError(404, 'Bank account not found');

    db.prepare('INSERT OR IGNORE INTO property_bank_accounts (property_id, bank_account_id) VALUES (?, ?)').run(property.id, account.id);
    logAudit(db, { actorType: 'owner', actorId: owner.id, action: 'link', entityType: 'bank_account', entityId: account.id, after: { propertyId: property.id } });
    sendJson(res, 200, serializeAccount(db, account));
  });

  // Unlink from just this ONE rental — the account itself, and every other
  // rental it's linked to, are untouched. A single DELETE on the join row is
  // atomic by construction; both sides' ownership are still checked first so
  // this can't be used to tamper with another owner's data via a guessed id.
  router.delete('/api/properties/:propertyId/bank-accounts/:accountId', async (req, res) => {
    const owner = requireAuth(db, req);
    getOwnedPropertyOr404(db, owner.id, req.params.propertyId);
    const account = db.prepare('SELECT * FROM bank_accounts WHERE id = ? AND owner_id = ?').get(req.params.accountId, owner.id);
    if (!account) throw apiError(404, 'Bank account not found');

    const result = db.prepare('DELETE FROM property_bank_accounts WHERE property_id = ? AND bank_account_id = ?').run(req.params.propertyId, account.id);
    if (result.changes === 0) throw apiError(404, 'This account is not linked to that property');

    logAudit(db, { actorType: 'owner', actorId: owner.id, action: 'unlink', entityType: 'bank_account', entityId: account.id, before: { propertyId: req.params.propertyId } });
    sendJson(res, 200, { ok: true });
  });
}

module.exports = { registerBankAccountRoutes, serializeAccount };

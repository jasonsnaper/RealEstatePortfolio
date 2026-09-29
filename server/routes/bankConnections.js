const { apiError, sendJson } = require('../lib/router');
const { requireAuth, getOwnedPropertyOr404, logAudit, runInTransaction } = require('../lib/helpers');
const bankProvider = require('../lib/bankProvider');
const { serializeAccount } = require('./bankAccounts');

// Real-bank-connection routes (Plaid-backed — see server/lib/bankProvider.js
// for the actual provider calls and setup instructions). This file only ever
// talks to the provider through that module's functions, and only ever
// stores/reads the resulting access_token through the database — it is never
// part of any response built here.
function registerBankConnectionRoutes(router, { db }) {
  // Lets the client decide, BEFORE offering "Connect a real bank" as if it
  // will work, whether it actually will — never guessed client-side.
  router.get('/api/bank-connections/provider-status', async (req, res) => {
    requireAuth(db, req);
    sendJson(res, 200, bankProvider.describeProvider());
  });

  router.post('/api/bank-connections/link-token', async (req, res) => {
    const owner = requireAuth(db, req);
    const { linkToken, expiration } = await bankProvider.createLinkToken({ ownerId: owner.id });
    sendJson(res, 200, { linkToken, expiration });
  });

  // The browser already ran the entire Plaid Link flow (the owner
  // authenticated with their real bank INSIDE Plaid's own hosted UI — this
  // server never saw those credentials) and got back a one-time
  // public_token plus, from Link's own onSuccess metadata, the institution's
  // name. This exchanges that for a permanent access_token, stores it
  // server-side, and returns the candidate account list so the OWNER can
  // choose which ones to associate with which rentals next — nothing is
  // assigned to any property yet.
  router.post('/api/bank-connections/exchange', async (req, res) => {
    const owner = requireAuth(db, req);
    const { publicToken, institutionName } = req.body;
    if (!publicToken) throw apiError(400, 'Missing publicToken from the bank-linking flow');

    const { accessToken, itemId } = await bankProvider.exchangePublicToken(publicToken);
    const result = db.prepare(`
      INSERT INTO bank_connections (owner_id, provider, institution_name, item_id, access_token, status)
      VALUES (?, 'plaid', ?, ?, ?, 'active')
    `).run(owner.id, institutionName || null, itemId || null, accessToken);
    const connectionId = result.lastInsertRowid;

    logAudit(db, { actorType: 'owner', actorId: owner.id, action: 'create', entityType: 'bank_connection', entityId: connectionId, after: { institutionName } });

    const accounts = await bankProvider.fetchAccounts(accessToken);
    sendJson(res, 201, { connectionId, institutionName: institutionName || null, accounts });
  });

  // Finalize the owner's picks from the candidate list exchange() returned:
  // create a real bank_accounts row (mode='connected') per selected account
  // and link each to whichever rentals the owner chose — all validated and
  // written together, so a bad property id anywhere in the batch leaves
  // nothing partially created.
  router.post('/api/bank-connections/:id/import', async (req, res) => {
    const owner = requireAuth(db, req);
    const connection = db.prepare('SELECT * FROM bank_connections WHERE id = ? AND owner_id = ?').get(req.params.id, owner.id);
    if (!connection) throw apiError(404, 'Bank connection not found');

    const selections = Array.isArray(req.body.selections) ? req.body.selections : [];
    if (selections.length === 0) throw apiError(400, 'Choose at least one account to add');
    for (const sel of selections) {
      if (!sel.externalAccountId) throw apiError(400, 'Each selected account needs its externalAccountId');
      for (const pid of sel.propertyIds || []) getOwnedPropertyOr404(db, owner.id, pid);
    }

    const createdIds = runInTransaction(db, () => selections.map((sel) => {
      const result = db.prepare(`
        INSERT INTO bank_accounts (
          owner_id, nickname, mode, manual_balance_cents, manual_as_of, connected_provider, connected_status,
          last_synced_at, bank_connection_id, external_account_id, mask, institution_name, balance_type
        ) VALUES (?, ?, 'connected', ?, ?, 'plaid', 'active', datetime('now'), ?, ?, ?, ?, ?)
      `).run(
        owner.id, (sel.nickname || sel.name || 'Bank account').trim(), sel.balanceCents ?? 0, new Date().toISOString().slice(0, 10),
        connection.id, sel.externalAccountId, sel.mask || null, connection.institution_name || null, sel.balanceType || 'current'
      );
      const accountId = result.lastInsertRowid;
      for (const pid of sel.propertyIds || []) {
        db.prepare('INSERT OR IGNORE INTO property_bank_accounts (property_id, bank_account_id) VALUES (?, ?)').run(pid, accountId);
      }
      return accountId;
    }));

    logAudit(db, { actorType: 'owner', actorId: owner.id, action: 'import', entityType: 'bank_connection', entityId: connection.id, after: { count: createdIds.length } });
    const created = createdIds.map((id) => serializeAccount(db, db.prepare('SELECT * FROM bank_accounts WHERE id = ?').get(id)));
    sendJson(res, 201, created);
  });

  // "Reconnect": get an update-mode Link token scoped to this exact
  // connection so Plaid walks the owner through fixing THIS bank login
  // (expired consent, changed password, etc.) rather than creating a
  // duplicate connection.
  router.post('/api/bank-connections/:id/reconnect-token', async (req, res) => {
    const owner = requireAuth(db, req);
    const connection = db.prepare('SELECT * FROM bank_connections WHERE id = ? AND owner_id = ?').get(req.params.id, owner.id);
    if (!connection) throw apiError(404, 'Bank connection not found');
    const { linkToken, expiration } = await bankProvider.createLinkToken({ ownerId: owner.id, accessToken: connection.access_token });
    sendJson(res, 200, { linkToken, expiration });
  });

  router.post('/api/bank-connections/:id/reconnect-exchange', async (req, res) => {
    const owner = requireAuth(db, req);
    const connection = db.prepare('SELECT * FROM bank_connections WHERE id = ? AND owner_id = ?').get(req.params.id, owner.id);
    if (!connection) throw apiError(404, 'Bank connection not found');
    const { publicToken } = req.body;
    if (!publicToken) throw apiError(400, 'Missing publicToken from the bank-linking flow');

    const { accessToken, itemId } = await bankProvider.exchangePublicToken(publicToken);
    db.prepare(`
      UPDATE bank_connections SET access_token=?, item_id=?, status='active', error_message=NULL, updated_at=datetime('now') WHERE id=?
    `).run(accessToken, itemId || connection.item_id, connection.id);
    // Every account under this connection was showing the SAME "needs
    // reconnect" state (see serializeAccount) purely by joining to the
    // connection's own status — nothing on the account rows themselves
    // needs to change here for that to clear.
    logAudit(db, { actorType: 'owner', actorId: owner.id, action: 'reconnect', entityType: 'bank_connection', entityId: connection.id });
    sendJson(res, 200, { ok: true });
  });

  // Re-fetch one connected account's current balance from its provider.
  // There's no live webhook/polling wired up in this build (see README), so
  // this on-demand sync is how a connected balance actually gets refreshed,
  // and it's also how a broken connection gets DISCOVERED — a failure here
  // marks the connection (and so every account under it) as needing
  // reconnection, rather than silently keeping a stale balance forever.
  router.post('/api/bank-accounts/:id/sync', async (req, res) => {
    const owner = requireAuth(db, req);
    const account = db.prepare('SELECT * FROM bank_accounts WHERE id = ? AND owner_id = ?').get(req.params.id, owner.id);
    if (!account) throw apiError(404, 'Bank account not found');
    if (account.mode !== 'connected' || !account.bank_connection_id) throw apiError(409, 'This is a manual account — edit its balance directly instead of syncing.');
    const connection = db.prepare('SELECT * FROM bank_connections WHERE id = ?').get(account.bank_connection_id);
    if (!connection) throw apiError(404, 'Bank connection not found');

    try {
      const accounts = await bankProvider.fetchAccounts(connection.access_token);
      const match = accounts.find((a) => a.externalAccountId === account.external_account_id);
      if (!match) throw apiError(404, 'This account was not returned by the bank anymore — it may have been closed or removed.');

      db.prepare(`
        UPDATE bank_accounts SET manual_balance_cents=?, manual_as_of=?, balance_type=?, last_synced_at=datetime('now'), updated_at=datetime('now')
        WHERE id=?
      `).run(match.balanceCents ?? account.manual_balance_cents, new Date().toISOString().slice(0, 10), match.balanceType || account.balance_type, account.id);
      if (connection.status !== 'active') {
        db.prepare("UPDATE bank_connections SET status='active', error_message=NULL, updated_at=datetime('now') WHERE id=?").run(connection.id);
      }
    } catch (err) {
      // A real provider error (expired consent, revoked access, etc.) — mark
      // the CONNECTION as needing reconnect, which every account under it
      // immediately reflects, and surface the provider's own message rather
      // than a generic failure.
      if (err.code === 'bank_provider_error' || err.code === 'bank_provider_unreachable') {
        db.prepare("UPDATE bank_connections SET status='reauth_required', error_message=?, updated_at=datetime('now') WHERE id=?").run(err.message, connection.id);
      }
      throw err;
    }

    sendJson(res, 200, serializeAccount(db, db.prepare('SELECT * FROM bank_accounts WHERE id = ?').get(account.id)));
  });
}

module.exports = { registerBankConnectionRoutes };

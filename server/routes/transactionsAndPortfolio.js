const { apiError, sendJson } = require('../lib/router');
const { requireAuth, getOwnedPropertyOr404, logAudit } = require('../lib/helpers');
const { dollarsToCents, centsToDisplay } = require('../lib/money');
const { computePortfolioTotals } = require('../lib/portfolio');

const EXPENSE_TYPES = new Set([
  'expense', 'mortgage_payment', 'fee', 'owner_contribution', 'owner_withdrawal', 'transfer',
  'deposit', 'deposit_refund', 'capital_improvement',
]);

function serializeTransaction(t) {
  return {
    id: t.id, type: t.type, direction: t.direction, amountCents: t.amount_cents,
    category: t.category, description: t.description, date: t.txn_date, status: t.status,
    isOperating: !!t.is_operating, isCapital: !!t.is_capital, isDebtService: !!t.is_debt_service,
    bankTransactionExtId: t.bank_transaction_ext_id,
  };
}

function registerTransactionRoutes(router, { db }) {
  router.get('/api/properties/:id/transactions', async (req, res) => {
    const owner = requireAuth(db, req);
    const property = getOwnedPropertyOr404(db, owner.id, req.params.id);
    let rows = db.prepare('SELECT * FROM transactions WHERE property_id = ? ORDER BY txn_date DESC, id DESC').all(property.id);
    if (req.query.type) rows = rows.filter((t) => t.type === req.query.type);
    if (req.query.start) rows = rows.filter((t) => t.txn_date >= req.query.start);
    if (req.query.end) rows = rows.filter((t) => t.txn_date <= req.query.end);
    if (req.query.q) {
      const q = req.query.q.toLowerCase();
      rows = rows.filter((t) => (t.description || '').toLowerCase().includes(q) || (t.category || '').toLowerCase().includes(q));
    }
    sendJson(res, 200, rows.map(serializeTransaction));
  });

  router.post('/api/properties/:id/transactions', async (req, res) => {
    const owner = requireAuth(db, req);
    const property = getOwnedPropertyOr404(db, owner.id, req.params.id);
    const b = req.body;
    if (!b.type || !EXPENSE_TYPES.has(b.type)) throw apiError(400, `Type must be one of: ${[...EXPENSE_TYPES].join(', ')}`);
    if (!b.amount || !b.date) throw apiError(400, 'Amount and date are required');

    const direction = b.direction === 'in' ? 'in' : 'out';
    const isCapital = b.isCapital ? 1 : 0;
    const isDebtService = b.type === 'mortgage_payment' ? 1 : 0;
    const isOperating = (isCapital || isDebtService) ? 0 : 1;

    const result = db.prepare(`
      INSERT INTO transactions (property_id, type, direction, amount_cents, category, description, txn_date, is_operating, is_capital, is_debt_service)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(property.id, b.type, direction, dollarsToCents(b.amount), b.category || null, b.description || null, b.date, isOperating, isCapital, isDebtService);

    logAudit(db, { actorType: 'owner', actorId: owner.id, action: 'create', entityType: 'transaction', entityId: result.lastInsertRowid, after: b });
    sendJson(res, 201, serializeTransaction(db.prepare('SELECT * FROM transactions WHERE id = ?').get(result.lastInsertRowid)));
  });

  // Bank-import reconciliation: given a batch of external bank transactions
  // (each with a stable ext id, amount, and date), match against or create
  // ledger rows without ever creating a duplicate for the same bank txn, and
  // without creating a second copy of a rent payment recorded manually first.
  // Matching rule: same property, same day, same amount, and (same bank ext id
  // already stored OR no ext id stored yet on a transaction that looks like the
  // same real-world event) counts as a duplicate and is skipped, not inserted.
  router.post('/api/properties/:id/transactions/import', async (req, res) => {
    const owner = requireAuth(db, req);
    const property = getOwnedPropertyOr404(db, owner.id, req.params.id);
    const importRows = Array.isArray(req.body.transactions) ? req.body.transactions : [];
    if (importRows.length === 0) throw apiError(400, 'No transactions provided to import');

    const results = { imported: 0, skippedDuplicates: 0, details: [] };

    for (const row of importRows) {
      if (!row.extId || !row.amount || !row.date) {
        results.details.push({ extId: row.extId, outcome: 'skipped_invalid' });
        continue;
      }
      const amountCents = Math.abs(dollarsToCents(row.amount));
      const direction = dollarsToCents(row.amount) >= 0 ? 'in' : 'out';

      // 1. Already imported this exact bank transaction before? Never duplicate it.
      const alreadyImported = db.prepare('SELECT id FROM transactions WHERE bank_transaction_ext_id = ?').get(row.extId);
      if (alreadyImported) {
        results.skippedDuplicates += 1;
        results.details.push({ extId: row.extId, outcome: 'already_imported' });
        continue;
      }

      // 2. Does an existing manually-recorded transaction on the same property/day/amount
      //    already represent this same real-world event (e.g. a rent payment the owner
      //    already logged by hand)? If so, attach this bank ext id to it instead of
      //    inserting a second row for the same money.
      const possibleMatch = db.prepare(`
        SELECT id FROM transactions
        WHERE property_id = ? AND txn_date = ? AND amount_cents = ? AND direction = ? AND bank_transaction_ext_id IS NULL
        LIMIT 1
      `).get(property.id, row.date, amountCents, direction);
      if (possibleMatch) {
        db.prepare('UPDATE transactions SET bank_transaction_ext_id = ? WHERE id = ?').run(row.extId, possibleMatch.id);
        results.skippedDuplicates += 1;
        results.details.push({ extId: row.extId, outcome: 'matched_existing', transactionId: possibleMatch.id });
        continue;
      }

      // 3. Genuinely new: insert it as an operating transaction pending categorization.
      const insertResult = db.prepare(`
        INSERT INTO transactions (property_id, type, direction, amount_cents, category, description, txn_date, is_operating, bank_transaction_ext_id)
        VALUES (?, 'bank_import', ?, ?, 'Uncategorized', ?, ?, 1, ?)
      `).run(property.id, direction, amountCents, row.description || 'Imported bank transaction', row.date, row.extId);
      results.imported += 1;
      results.details.push({ extId: row.extId, outcome: 'imported', transactionId: insertResult.lastInsertRowid });
    }

    logAudit(db, { actorType: 'owner', actorId: owner.id, action: 'import_transactions', entityType: 'property', entityId: property.id, after: results });
    sendJson(res, 200, results);
  });

  router.get('/api/properties/:id/transactions/export.csv', async (req, res) => {
    const owner = requireAuth(db, req);
    const property = getOwnedPropertyOr404(db, owner.id, req.params.id);
    const rows = db.prepare('SELECT * FROM transactions WHERE property_id = ? ORDER BY txn_date').all(property.id);
    const header = 'Date,Type,Direction,Amount,Category,Description,Status\n';
    const body = rows.map((t) =>
      [t.txn_date, t.type, t.direction, centsToDisplay(t.amount_cents), csvEscape(t.category), csvEscape(t.description), t.status].join(',')
    ).join('\n');
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${property.name.replace(/[^a-z0-9]+/gi, '-')}-transactions.csv"`,
    });
    res.end(header + body + '\n');
  });

  // Portfolio-wide rent roll export: one row per active lease with current status.
  router.get('/api/portfolio/rent-roll.csv', async (req, res) => {
    const owner = requireAuth(db, req);
    const { ensureChargesGenerated } = require('../lib/chargeGenerator');
    const { getChargeStatus } = require('../lib/rentStatus');
    const { todayInTimezone } = require('../lib/dates');

    const properties = db.prepare("SELECT * FROM properties WHERE owner_id = ? AND status = 'active'").all(owner.id);
    const header = 'Property,Address,Tenant,Monthly Rent,Status,Outstanding,Due Date,Late Date\n';
    const lines = [];
    for (const property of properties) {
      const lease = db.prepare("SELECT * FROM leases WHERE property_id = ? AND status = 'active'").get(property.id);
      if (!lease) { lines.push([property.name, csvEscape(property.address_line1), 'VACANT', '', '', '', '', ''].join(',')); continue; }
      ensureChargesGenerated(db, lease.id, property.timezone);
      const today = todayInTimezone(property.timezone);
      const charge = db.prepare('SELECT * FROM charges WHERE lease_id = ? ORDER BY period_start DESC LIMIT 1').get(lease.id);
      if (!charge) continue;
      const payments = db.prepare('SELECT * FROM payments WHERE charge_id = ?').all(charge.id);
      const result = getChargeStatus(charge, payments, today);
      lines.push([
        csvEscape(property.name), csvEscape(property.address_line1), csvEscape(lease.tenant_name),
        centsToDisplay(charge.amount_cents), result.status, centsToDisplay(result.outstanding),
        charge.due_date, charge.late_date,
      ].join(','));
    }
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="rent-roll.csv"',
    });
    res.end(header + lines.join('\n') + '\n');
  });

  router.get('/api/portfolio', async (req, res) => {
    const owner = requireAuth(db, req);
    const totals = computePortfolioTotals(db, owner.id, { start: req.query.start, end: req.query.end });
    sendJson(res, 200, totals);
  });
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

module.exports = { registerTransactionRoutes };

const { apiError, sendJson } = require('../lib/router');
const { requireAuth, getOwnedPropertyOr404, logAudit } = require('../lib/helpers');
const { dollarsToCents } = require('../lib/money');

function registerFinancialRoutes(router, { db }) {
  // ---- Valuations ----
  router.get('/api/properties/:id/valuations', async (req, res) => {
    const owner = requireAuth(db, req);
    const property = getOwnedPropertyOr404(db, owner.id, req.params.id);
    const rows = db.prepare('SELECT * FROM property_valuations WHERE property_id = ? ORDER BY valuation_date DESC, id DESC').all(property.id);
    sendJson(res, 200, rows.map((r) => ({
      id: r.id, valueCents: r.value_cents, valuationDate: r.valuation_date,
      source: r.source, isPurchase: !!r.is_purchase, notes: r.notes,
    })));
  });

  router.post('/api/properties/:id/valuations', async (req, res) => {
    const owner = requireAuth(db, req);
    const property = getOwnedPropertyOr404(db, owner.id, req.params.id);
    const { value, valuationDate, source, isPurchase, notes } = req.body;
    if (!value || !valuationDate) throw apiError(400, 'Value and date are required');

    const result = db.prepare(`
      INSERT INTO property_valuations (property_id, value_cents, valuation_date, source, is_purchase, notes)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(property.id, dollarsToCents(value), valuationDate, source || (isPurchase ? 'Purchase price' : 'Manual estimate'), isPurchase ? 1 : 0, notes || null);

    logAudit(db, { actorType: 'owner', actorId: owner.id, action: 'create', entityType: 'valuation', entityId: result.lastInsertRowid, after: req.body });
    sendJson(res, 201, { id: result.lastInsertRowid });
  });

  // ---- Capital improvements ----
  router.get('/api/properties/:id/capital-improvements', async (req, res) => {
    const owner = requireAuth(db, req);
    const property = getOwnedPropertyOr404(db, owner.id, req.params.id);
    const rows = db.prepare('SELECT * FROM capital_improvements WHERE property_id = ? ORDER BY improvement_date DESC').all(property.id);
    sendJson(res, 200, rows.map((r) => ({ id: r.id, description: r.description, amountCents: r.amount_cents, date: r.improvement_date })));
  });

  router.post('/api/properties/:id/capital-improvements', async (req, res) => {
    const owner = requireAuth(db, req);
    const property = getOwnedPropertyOr404(db, owner.id, req.params.id);
    const { description, amount, date } = req.body;
    if (!description || !amount || !date) throw apiError(400, 'Description, amount, and date are required');
    const result = db.prepare('INSERT INTO capital_improvements (property_id, description, amount_cents, improvement_date) VALUES (?, ?, ?, ?)')
      .run(property.id, description.trim(), dollarsToCents(amount), date);
    // Every capital improvement also becomes a transaction, flagged is_capital,
    // so it shows up in the Transactions tab and is correctly excluded from NOI
    // (but still counted in cash flow) without double-entry.
    db.prepare(`
      INSERT INTO transactions (property_id, type, direction, amount_cents, category, description, txn_date, is_operating, is_capital)
      VALUES (?, 'capital_improvement', 'out', ?, 'Capital improvement', ?, ?, 0, 1)
    `).run(property.id, dollarsToCents(amount), description.trim(), date);
    logAudit(db, { actorType: 'owner', actorId: owner.id, action: 'create', entityType: 'capital_improvement', entityId: result.lastInsertRowid, after: req.body });
    sendJson(res, 201, { id: result.lastInsertRowid });
  });

  // ---- Mortgages (a property can carry more than one loan) ----
  router.get('/api/properties/:id/mortgages', async (req, res) => {
    const owner = requireAuth(db, req);
    const property = getOwnedPropertyOr404(db, owner.id, req.params.id);
    const rows = db.prepare('SELECT * FROM mortgages WHERE property_id = ? ORDER BY created_at').all(property.id);
    sendJson(res, 200, rows.map(serializeMortgage));
  });

  router.post('/api/properties/:id/mortgages', async (req, res) => {
    const owner = requireAuth(db, req);
    const property = getOwnedPropertyOr404(db, owner.id, req.params.id);
    const m = req.body;
    if (!m.lender || !m.originalAmount) throw apiError(400, 'Lender and original loan amount are required');

    const result = db.prepare(`
      INSERT INTO mortgages (property_id, lender, original_amount_cents, current_principal_cents, interest_rate_bps,
                              monthly_payment_cents, due_day, origination_date, term_months, maturity_date, escrow_cents, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      property.id, m.lender.trim(), dollarsToCents(m.originalAmount),
      dollarsToCents(m.currentPrincipal ?? m.originalAmount),
      m.interestRatePct != null ? Math.round(Number(m.interestRatePct) * 100) : null,
      m.monthlyPayment != null ? dollarsToCents(m.monthlyPayment) : null,
      m.dueDay || null, m.originationDate || null, m.termMonths || null, m.maturityDate || null,
      m.escrow != null ? dollarsToCents(m.escrow) : 0, m.notes || null
    );

    logAudit(db, { actorType: 'owner', actorId: owner.id, action: 'create', entityType: 'mortgage', entityId: result.lastInsertRowid, after: m });
    sendJson(res, 201, serializeMortgage(db.prepare('SELECT * FROM mortgages WHERE id = ?').get(result.lastInsertRowid)));
  });

  router.put('/api/mortgages/:id', async (req, res) => {
    const owner = requireAuth(db, req);
    const before = db.prepare(`
      SELECT m.* FROM mortgages m JOIN properties p ON p.id = m.property_id WHERE m.id = ? AND p.owner_id = ?
    `).get(req.params.id, owner.id);
    if (!before) throw apiError(404, 'Loan not found');

    const m = req.body;
    db.prepare(`
      UPDATE mortgages SET lender=?, current_principal_cents=?, interest_rate_bps=?, monthly_payment_cents=?,
             due_day=?, escrow_cents=?, notes=?, updated_at=datetime('now') WHERE id=?
    `).run(
      m.lender ?? before.lender,
      m.currentPrincipal != null ? dollarsToCents(m.currentPrincipal) : before.current_principal_cents,
      m.interestRatePct != null ? Math.round(Number(m.interestRatePct) * 100) : before.interest_rate_bps,
      m.monthlyPayment != null ? dollarsToCents(m.monthlyPayment) : before.monthly_payment_cents,
      m.dueDay ?? before.due_day,
      m.escrow != null ? dollarsToCents(m.escrow) : before.escrow_cents,
      m.notes ?? before.notes,
      before.id
    );
    logAudit(db, { actorType: 'owner', actorId: owner.id, action: 'update', entityType: 'mortgage', entityId: before.id, before, after: m });
    sendJson(res, 200, serializeMortgage(db.prepare('SELECT * FROM mortgages WHERE id = ?').get(before.id)));
  });

  // Recording a mortgage payment splits it into principal/interest/escrow (when
  // known) and logs it as a single debt-service transaction — the amount that
  // matters for cash flow and NOI is the whole payment, but we still store the
  // breakdown so the mortgage section can show real principal paydown over time.
  router.post('/api/mortgages/:id/payments', async (req, res) => {
    const owner = requireAuth(db, req);
    const mortgage = db.prepare(`
      SELECT m.* FROM mortgages m JOIN properties p ON p.id = m.property_id WHERE m.id = ? AND p.owner_id = ?
    `).get(req.params.id, owner.id);
    if (!mortgage) throw apiError(404, 'Loan not found');

    const { amount, principalPortion, date, notes } = req.body;
    if (!amount || !date) throw apiError(400, 'Amount and date are required');
    const amountCents = dollarsToCents(amount);
    const principalCents = principalPortion != null ? dollarsToCents(principalPortion) : amountCents;

    db.prepare(`
      INSERT INTO transactions (property_id, type, direction, amount_cents, category, description, txn_date, is_operating, is_debt_service)
      VALUES (?, 'mortgage_payment', 'out', ?, 'Mortgage', ?, ?, 0, 1)
    `).run(mortgage.property_id, amountCents, notes || `Mortgage payment — ${mortgage.lender}`, date);

    const newPrincipal = Math.max(0, mortgage.current_principal_cents - principalCents);
    db.prepare("UPDATE mortgages SET current_principal_cents = ?, updated_at = datetime('now') WHERE id = ?").run(newPrincipal, mortgage.id);

    logAudit(db, { actorType: 'owner', actorId: owner.id, action: 'record_mortgage_payment', entityType: 'mortgage', entityId: mortgage.id, after: req.body });
    sendJson(res, 201, serializeMortgage(db.prepare('SELECT * FROM mortgages WHERE id = ?').get(mortgage.id)));
  });
}

function serializeMortgage(m) {
  return {
    id: m.id, lender: m.lender,
    originalAmountCents: m.original_amount_cents, currentPrincipalCents: m.current_principal_cents,
    interestRatePct: m.interest_rate_bps != null ? m.interest_rate_bps / 100 : null,
    monthlyPaymentCents: m.monthly_payment_cents, dueDay: m.due_day,
    originationDate: m.origination_date, termMonths: m.term_months, maturityDate: m.maturity_date,
    escrowCents: m.escrow_cents, notes: m.notes,
  };
}

module.exports = { registerFinancialRoutes };

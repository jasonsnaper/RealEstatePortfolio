// Generates a Rental Payment Statement PDF for a lease over a date range,
// and records it in payment_statements (see db.js's table comment: a
// generated statement is an immutable snapshot — once created, its file and
// totals never change even if a later correction changes the ledger, so a
// statement someone already downloaded never silently disagrees with itself).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PdfDocument } = require('./pdf');
const { getChargeStatus } = require('./rentStatus');
const { centsToDisplay } = require('./money');
const { formatDateShort: formatDate } = (() => {
  // Tiny local formatter — this app's date libs are calendar-string based
  // (server/lib/dates.js) and don't include a human display formatter (that
  // lives client-side in public/js/util.js), so statements.js gets its own
  // minimal one rather than reaching into frontend code from the server.
  function formatDateShort(dateStr) {
    if (!dateStr) return '—';
    const [y, m, d] = dateStr.split('-').map(Number);
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${MONTHS[m - 1]} ${d}, ${y}`;
  }
  return { formatDateShort };
})();

const { UPLOADS_DIR } = require('../db');

const MARGIN = 50;
const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const CONTENT_BOTTOM = 70; // leave room for the footer/disclaimer

const COLS = { period: MARGIN, due: 195, amount: 280, paid: 360, outstanding: 440, status: 510 };

function addressLine(property) {
  return [property.address_line1, property.address_line2, [property.city, property.state].filter(Boolean).join(', '), property.zip]
    .filter(Boolean).join(' · ');
}

/**
 * Builds the PDF and returns { buffer, totals }. Pure/testable in isolation
 * from the database — the route layer (server/routes/statements.js) is the
 * only thing that touches disk or the payment_statements table.
 */
function renderStatementPdf({ property, lease, charges, rangeStart, rangeEnd, isSample, generatedAt }) {
  const doc = new PdfDocument();
  let page = doc.addPage();
  let y = PAGE_HEIGHT - 60;

  function newPageIfNeeded(neededSpace = 20) {
    if (y - neededSpace < CONTENT_BOTTOM) {
      drawFooter(page);
      page = doc.addPage();
      y = PAGE_HEIGHT - 60;
      drawTableHeader();
    }
  }
  function drawFooter(pg) {
    pg.line(MARGIN, 45, PAGE_WIDTH - MARGIN, 45);
    pg.text(MARGIN, 32, `Generated ${formatDate(generatedAt)} · Rental Portfolio Manager`, { size: 8 });
    if (isSample) pg.text(PAGE_WIDTH - MARGIN - 150, 32, 'SAMPLE DATA — not a real statement', { size: 8, font: 'F2' });
  }
  function drawTableHeader() {
    page.text(COLS.period, y, 'Period', { size: 9, font: 'F2' });
    page.text(COLS.due, y, 'Due', { size: 9, font: 'F2' });
    page.text(COLS.amount, y, 'Amount', { size: 9, font: 'F2' });
    page.text(COLS.paid, y, 'Paid', { size: 9, font: 'F2' });
    page.text(COLS.outstanding, y, 'Owed', { size: 9, font: 'F2' });
    y -= 6;
    page.line(MARGIN, y, PAGE_WIDTH - MARGIN, y);
    y -= 16;
  }

  page.text(MARGIN, y, 'Rental Payment Statement', { size: 18, font: 'F2' }); y -= 22;
  page.text(MARGIN, y, property.name, { size: 12, font: 'F2' }); y -= 15;
  page.text(MARGIN, y, addressLine(property), { size: 10 }); y -= 20;
  page.text(MARGIN, y, `Tenant: ${lease.tenant_name}${lease.co_tenant_name ? ' & ' + lease.co_tenant_name : ''}`, { size: 10 }); y -= 15;
  page.text(MARGIN, y, `Statement period: ${formatDate(rangeStart)} – ${formatDate(rangeEnd)}`, { size: 10 }); y -= 25;
  if (isSample) {
    page.text(MARGIN, y, 'SAMPLE DATA — this statement was generated from sample properties, not a real tenant.', { size: 9, font: 'F2' });
    y -= 20;
  }

  drawTableHeader();

  let totalBilled = 0, totalPaid = 0;
  const rangedCharges = charges.filter((c) => c.period_start >= rangeStart && c.period_start <= rangeEnd);
  for (const c of rangedCharges) {
    newPageIfNeeded(18);
    const { netPaid, outstanding, status } = getChargeStatus(c, c.__payments, rangeEnd);
    totalBilled += c.amount_cents;
    totalPaid += netPaid;
    page.text(COLS.period, y, `${formatDate(c.period_start)} – ${formatDate(c.period_end)}`, { size: 9 });
    page.text(COLS.due, y, formatDate(c.due_date), { size: 9 });
    page.text(COLS.amount, y, centsToDisplay(c.amount_cents), { size: 9 });
    page.text(COLS.paid, y, centsToDisplay(netPaid), { size: 9 });
    page.text(COLS.outstanding, y, centsToDisplay(outstanding), { size: 9 });
    y -= 16;

    for (const p of c.__payments) {
      if (p.status !== 'completed') continue;
      newPageIfNeeded(14);
      const sign = (p.type === 'refund' || p.type === 'reversal') ? '−' : '';
      page.text(COLS.period + 14, y, `${formatDate(p.paid_at)} — ${p.type} (${p.method})`, { size: 8 });
      page.text(COLS.paid, y, `${sign}${centsToDisplay(p.amount_cents)}`, { size: 8 });
      y -= 13;
    }
  }

  if (rangedCharges.length === 0) {
    page.text(MARGIN, y, 'No charges fall within this date range.', { size: 10 });
    y -= 18;
  }

  newPageIfNeeded(60);
  y -= 10;
  page.line(MARGIN, y, PAGE_WIDTH - MARGIN, y); y -= 20;
  page.text(COLS.amount, y, 'Total billed:', { size: 10, font: 'F2' });
  page.text(COLS.outstanding, y, centsToDisplay(totalBilled), { size: 10 }); y -= 16;
  page.text(COLS.amount, y, 'Total paid:', { size: 10, font: 'F2' });
  page.text(COLS.outstanding, y, centsToDisplay(totalPaid), { size: 10 }); y -= 16;
  page.text(COLS.amount, y, 'Balance:', { size: 10, font: 'F2' });
  page.text(COLS.outstanding, y, centsToDisplay(totalBilled - totalPaid), { size: 10 });

  drawFooter(page);

  return { buffer: doc.save(), totals: { billedCents: totalBilled, paidCents: totalPaid, outstandingCents: totalBilled - totalPaid, chargeCount: rangedCharges.length } };
}

/** Full pipeline: render + write file + insert payment_statements row. Returns the DB row. */
function generateStatement(db, { lease, property, rangeType, rangeStart, rangeEnd, generatedBy, generatedByRenterId, isSample }) {
  const charges = db.prepare('SELECT * FROM charges WHERE lease_id = ? ORDER BY period_start').all(lease.id)
    .map((c) => ({ ...c, __payments: db.prepare('SELECT * FROM payments WHERE charge_id = ? ORDER BY paid_at').all(c.id) }));

  const { buffer, totals } = renderStatementPdf({ property, lease, charges, rangeStart, rangeEnd, isSample, generatedAt: new Date().toISOString().slice(0, 10) });

  const destDir = path.join(UPLOADS_DIR, 'properties', String(property.id), 'statements');
  fs.mkdirSync(destDir, { recursive: true });
  const filename = `statement-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.pdf`;
  fs.writeFileSync(path.join(destDir, filename), buffer);

  const result = db.prepare(`
    INSERT INTO payment_statements (lease_id, range_type, range_start, range_end, generated_by, generated_by_renter_id, is_sample, file_path, totals_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(lease.id, rangeType, rangeStart, rangeEnd, generatedBy, generatedByRenterId || null, isSample ? 1 : 0, filename, JSON.stringify(totals));

  return db.prepare('SELECT * FROM payment_statements WHERE id = ?').get(result.lastInsertRowid);
}

function serializeStatement(s) {
  return {
    id: s.id,
    leaseId: s.lease_id,
    rangeType: s.range_type,
    rangeStart: s.range_start,
    rangeEnd: s.range_end,
    generatedBy: s.generated_by,
    isSample: !!s.is_sample,
    sharedWithRenter: !!s.shared_with_renter,
    emailedAt: s.emailed_at,
    emailedTo: s.emailed_to,
    totals: s.totals_json ? JSON.parse(s.totals_json) : null,
    createdAt: s.created_at,
  };
}

module.exports = { renderStatementPdf, generateStatement, serializeStatement };

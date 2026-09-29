// All money in this app is stored and calculated as INTEGER CENTS.
// We never store or compute with floating point dollars, so rounding
// errors can't creep into rent, balances, or reports.

/** Parse a user-facing dollar string/number ("1,250.50", 1250.5) into integer cents. Throws on bad input. */
function dollarsToCents(input) {
  if (input === null || input === undefined || input === '') return 0;
  const cleaned = String(input).replace(/[$,\s]/g, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) {
    throw new Error(`Invalid money amount: "${input}"`);
  }
  const negative = cleaned.startsWith('-');
  const abs = negative ? cleaned.slice(1) : cleaned;
  const [whole, frac = ''] = abs.split('.');
  const fracPadded = (frac + '00').slice(0, 2);
  const cents = parseInt(whole, 10) * 100 + parseInt(fracPadded, 10);
  return negative ? -cents : cents;
}

/** Format integer cents as a display dollar string, e.g. 125050 -> "$1,250.50" */
function centsToDisplay(cents, { showSign = false } = {}) {
  if (cents === null || cents === undefined) return '—';
  const n = Number(cents);
  const negative = n < 0;
  const abs = Math.abs(n);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  const wholeFormatted = whole.toLocaleString('en-US');
  const sign = negative ? '-' : (showSign ? '+' : '');
  return `${sign}$${wholeFormatted}.${frac}`;
}

/** Sum an array of integer-cent values safely. */
function sumCents(values) {
  return values.reduce((total, v) => total + (Number.isFinite(v) ? v : 0), 0);
}

module.exports = { dollarsToCents, centsToDisplay, sumCents };

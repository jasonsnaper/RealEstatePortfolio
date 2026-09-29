// Date handling philosophy for this app:
//
// Rent due dates, late dates, and "today" for status purposes are all
// CALENDAR dates (e.g. "2026-09-27"), not instants in time. We deliberately
// work with calendar-date strings (YYYY-MM-DD) rather than JS Date/instant
// math wherever a lease's timezone matters, because:
//   - A property's due date should mean the same calendar day regardless of
//     what server timezone this code happens to run in.
//   - Adding "5 days" to a date should never be thrown off by daylight saving
//     time shifts, which is a classic source of off-by-one billing bugs.
//
// All functions below take/return YYYY-MM-DD strings and an IANA timezone
// name (e.g. "America/Denver"). They never use raw `new Date() + ms` math
// for calendar arithmetic.

/** Today's calendar date, as YYYY-MM-DD, in the given IANA timezone. */
function todayInTimezone(timeZone) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(new Date()); // en-CA formats as YYYY-MM-DD
}

/** Number of days in a given month (1-12) of a given year. Handles leap years. */
function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Build a calendar date string for "this year/month, clamped to dueDay".
 * If dueDay is larger than the month has (e.g. 31 in February), it clamps
 * to the last real day of that month, per the spec's "months with fewer
 * days" requirement.
 */
function clampedDate(year, month, dueDay) {
  const lastDay = daysInMonth(year, month);
  const day = Math.min(Math.max(1, dueDay), lastDay);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Add whole calendar days to a YYYY-MM-DD date string. Pure calendar math, DST-safe. */
function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  // Noon UTC avoids any chance of drifting to the previous/next day.
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** Add whole calendar months to a YYYY-MM-DD date string, clamping the day if needed. */
function addMonths(dateStr, months) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const totalMonths = (y * 12 + (m - 1)) + months;
  const newYear = Math.floor(totalMonths / 12);
  const newMonth = (totalMonths % 12) + 1;
  return clampedDate(newYear, newMonth, d);
}

/** Compare two YYYY-MM-DD strings: -1, 0, 1. Safe because the format sorts lexicographically. */
function compareDates(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Last day of the month containing dateStr, as YYYY-MM-DD. */
function endOfMonth(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  return clampedDate(y, m, 31);
}

/** First day of the month containing dateStr, as YYYY-MM-DD. */
function startOfMonth(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  return clampedDate(y, m, 1);
}

module.exports = {
  todayInTimezone,
  daysInMonth,
  clampedDate,
  addDays,
  addMonths,
  compareDates,
  endOfMonth,
  startOfMonth,
};

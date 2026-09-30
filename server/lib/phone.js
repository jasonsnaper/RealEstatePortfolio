// Phone number validation, shared by renter self-serve signup
// (server/routes/renterAuth.js) and SMS invitations (server/routes/
// renterManagement.js + server/lib/smsProvider.js). This app has zero npm
// dependencies by design (see README.md), so there is no libphonenumber here
// — just E.164 syntax validation ("+" followed by 8-15 digits, first digit
// 1-9), which is exactly what a real SMS provider (Twilio included) requires
// on the wire. It does NOT verify that a number is actually assigned to a
// real, reachable handset — only a provider can tell you that, by actually
// trying to deliver to it, which is exactly why SMS invitations report a
// real delivery status (see smsProvider.js) rather than a client-side check
// pretending to guarantee deliverability.
//
// The UI pairs this with a small country-code picker (public/js/phone.js) so
// a renter or owner types only the national number and picks a country —
// composeE164 below joins the two into the wire format this validates.

const E164_RE = /^\+[1-9]\d{7,14}$/;

function isValidE164(value) {
  return typeof value === 'string' && E164_RE.test(value.trim());
}

/** Join a country calling code (e.g. "1", "+44") and a national number (may
 * contain spaces/dashes/parens from how someone typed it) into E.164. Never
 * throws — returns null for input that can't be made into something
 * plausible, so callers can give one consistent "invalid phone number" error
 * rather than a stack of separate parsing failures. */
function composeE164(countryCode, nationalNumber) {
  if (!countryCode || !nationalNumber) return null;
  const cc = String(countryCode).trim().replace(/^\+/, '');
  const national = String(nationalNumber).trim().replace(/[^\d]/g, '');
  if (!/^\d{1,4}$/.test(cc) || !national) return null;
  const candidate = `+${cc}${national}`;
  return isValidE164(candidate) ? candidate : null;
}

/** Accepts either an already-composed phone string or {countryCode, nationalNumber} parts. Returns a normalized E.164 string or null. */
function normalizePhoneInput(input) {
  if (input == null) return null;
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) return null;
    // Someone may have typed "+1 (555) 555-0100" as one field — strip
    // everything but leading + and digits before validating.
    const collapsed = '+' + trimmed.replace(/[^\d]/g, '');
    return isValidE164(collapsed) ? collapsed : null;
  }
  if (typeof input === 'object' && (input.countryCode || input.nationalNumber)) {
    return composeE164(input.countryCode, input.nationalNumber);
  }
  return null;
}

module.exports = { isValidE164, composeE164, normalizePhoneInput };

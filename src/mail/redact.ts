/**
 * Placeholders are short, bracketed and language-neutral so the extractor still sees that
 * "an IBAN / a card / a code was sent" without seeing the value.
 */
export const REDACTION_TOKENS = { iban: "[IBAN]", card: "[CARD]", secret: "[SECRET]" } as const;

// Greek IBAN: GR + 2 check digits + 23 digits, often grouped in fours.
const GR_IBAN = /\bGR\s?\d{2}(?:[ \xa0-]?\d){23}\b/gu;
// Generic IBAN candidate: 2 letters + 2 digits + 11–30 alphanumerics (optionally grouped). Checksum-validated.
const ANY_IBAN = /\b[A-Z]{2}\d{2}(?:[ \xa0]?[A-Z0-9]){11,30}\b/gu;
// 13–19 digits, optionally separated by single spaces or dashes. Luhn + IIN-validated.
const CARD = /(?<![\d.,/-])\d(?:[ \xa0-]?\d){12,18}(?![\d/-]|[.,]\d)/gu;

/** Label (group 1) followed by a secret value (group 2). The label is kept, the value replaced. */
const SECRET_LABELED = new RegExp(
  "(?<![\\p{L}\\p{N}])(" +
    [
      "password", "passwd", "pwd", "pass", "passcode", "pin", "otp",
      "one[- ]time (?:pass)?code", "one[- ]time password", "verification code", "security code", "auth(?:entication)? code",
      "2fa code", "access code", "login code",
      "κωδικ[οό]ς", "κωδικ[οό]ς πρ[οό]σβασης", "κωδικ[οό]ς εισ[οό]δου", "κωδικ[οό]ς ασφαλε[ιί]ας", "κωδικ[οό]ς μι[αά]ς χρ[ηή]σης",
      "κωδικ[οό]ς επαλ[ηή]θευσης", "κωδικ[οό]ς επιβεβα[ιί]ωσης", "κωδικ[οό]ς otp", "κωδικ[οό]ς pin", "συνθηματικ[οό]",
      "μυστικ[οό]ς κωδικ[οό]ς",
    ].join("|") +
    ")(?:\\s*[:=]|\\s+(?:is|είναι|ειναι))\\s*([^\\s,;]{3,64})",
  "giu",
);

/** "Your code is 123456" / "ο κωδικός σας είναι 123456" (numeric OTPs without a colon). */
const OTP_SENTENCE = /((?:code|κωδικ[οό]ς)(?:\s+(?:σας|your))?\s+(?:is|είναι|ειναι)\s+)(\d{4,8})\b/giu;

/** Deterministic redaction before any AI call: IBAN, card numbers, password/OTP patterns. */
export function redactSensitive(text: string): { text: string; redactions: number } {
  if (!text) return { text: text ?? "", redactions: 0 };
  let n = 0;
  let out = text.replace(GR_IBAN, () => {
    n++;
    return REDACTION_TOKENS.iban;
  });
  out = out.replace(ANY_IBAN, (m) => {
    const end = validIbanPrefixEnd(m);
    if (end === null) return m;
    n++;
    return REDACTION_TOKENS.iban + m.slice(end);
  });
  out = out.replace(CARD, (m) => {
    const digits = m.replace(/\D/g, "");
    if (!isPlausibleCard(digits)) return m;
    n++;
    return REDACTION_TOKENS.card;
  });
  out = out.replace(SECRET_LABELED, (_m, label: string, value: string) => {
    if (value === REDACTION_TOKENS.secret || /^\[(?:IBAN|CARD|SECRET)\]$/.test(value)) return _m;
    if (!looksLikeSecret(label, value)) return _m;
    n++;
    return _m.slice(0, _m.length - value.length) + REDACTION_TOKENS.secret;
  });
  out = out.replace(OTP_SENTENCE, (_m, lead: string) => {
    n++;
    return lead + REDACTION_TOKENS.secret;
  });
  return { text: out, redactions: n };
}

/** A bare "κωδικός:" ("code:") is ambiguous (product/customer code); only redact values that look like credentials. */
function looksLikeSecret(label: string, value: string): boolean {
  const l = label.toLowerCase();
  const isBareGreekCode = /^κωδικ[οό]ς$/u.test(l);
  if (/^(pin|otp)$/.test(l) || /otp|pin|μι[αά]ς χρ|επαλ|επιβεβ|verification|one[- ]time|security|2fa|auth/u.test(l)) {
    return /^[A-Za-z0-9-]{3,12}$/.test(value);
  }
  if (isBareGreekCode) {
    // Product/customer codes are typically all digits or UPPER-DIGIT codes; passwords mix classes or cases.
    const hasLower = /\p{Ll}/u.test(value);
    const hasUpper = /\p{Lu}/u.test(value);
    const hasDigit = /\d/.test(value);
    const hasSymbol = /[^\p{L}\p{N}]/u.test(value) && !/^[\p{L}\p{N}]+[-/.][\p{L}\p{N}]+$/u.test(value);
    const classes = [hasLower, hasUpper, hasDigit, hasSymbol].filter(Boolean).length;
    return (hasLower && hasDigit) || classes >= 3 || (hasSymbol && value.length >= 6);
  }
  return true;
}

/** Longest prefix of a greedy IBAN match that passes mod-97 (the regex may swallow a trailing code). */
function validIbanPrefixEnd(m: string): number | null {
  const ends: number[] = [];
  let compact = "";
  for (let i = 0; i < m.length; i++) {
    if (/[A-Z0-9]/.test(m[i]!)) {
      compact += m[i];
      ends.push(i + 1);
    }
  }
  for (let k = compact.length; k >= 15; k--) {
    if (isValidIban(compact.slice(0, k))) return ends[k - 1]!;
  }
  return null;
}

/** ISO 13616 mod-97 check. */
export function isValidIban(candidate: string): boolean {
  const s = candidate.replace(/[\s\xa0]/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const rearranged = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of rearranged) {
    const v = ch >= "A" && ch <= "Z" ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}

export function luhnValid(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/** Luhn-valid and a plausible issuer prefix/length (cuts false positives on EAN codes and order numbers). */
function isPlausibleCard(d: string): boolean {
  if (d.length < 13 || d.length > 19 || !luhnValid(d)) return false;
  const p2 = Number(d.slice(0, 2));
  const p4 = Number(d.slice(0, 4));
  const p3 = Number(d.slice(0, 3));
  if (d[0] === "4") return [13, 16, 19].includes(d.length); // Visa
  if ((p2 >= 51 && p2 <= 55) || (p4 >= 2221 && p4 <= 2720)) return d.length === 16; // Mastercard
  if (p2 === 34 || p2 === 37) return d.length === 15; // Amex
  if (p4 === 6011 || p2 === 65 || (p3 >= 644 && p3 <= 649)) return d.length >= 16; // Discover
  if (p4 >= 3528 && p4 <= 3589) return d.length >= 16; // JCB
  if (p2 === 36 || p2 === 38 || (p3 >= 300 && p3 <= 305)) return d.length >= 14; // Diners
  if (/^(50|5[6-9]|6[0-9])/.test(d)) return d.length >= 16; // Maestro & others
  return false;
}

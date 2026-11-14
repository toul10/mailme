import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** RFC 6238 TOTP (SHA-1, 30 s, 6 digits) with ±1 step tolerance. */

export const TOTP_PERIOD_SEC = 30;
export const TOTP_DIGITS = 6;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32, upper-case, no padding. */
export function base32Encode(buf: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const byte of buf) {
    value = ((value << 8) | byte) & 0xfff;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Lenient base32 decode: ignores case, spaces, dashes and padding. Throws on other characters. */
export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s=-]/g, "");
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error("Invalid base32 character");
    value = ((value << 5) | idx) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** 160-bit random secret (RFC 4226 recommendation), base32. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** RFC 4226 HOTP value for a counter, zero-padded to `digits`. */
export function hotp(key: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", key).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(bin % 10 ** digits).padStart(digits, "0");
}

export function totpCounter(atMs: number): number {
  return Math.floor(atMs / 1000 / TOTP_PERIOD_SEC);
}

export function totpCode(secretBase32: string, atMs: number): string {
  return hotp(base32Decode(secretBase32), totpCounter(atMs));
}

/**
 * Returns the matched time step (for replay protection) or null. Accepts the previous, current and next step.
 * The code may contain spaces ("123 456").
 */
export function matchTotpStep(secretBase32: string, code: string, atMs: number): number | null {
  const given = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(given)) return null;
  let key: Buffer;
  try {
    key = base32Decode(secretBase32);
  } catch {
    return null;
  }
  if (key.length === 0) return null;
  const now = totpCounter(atMs);
  let matched: number | null = null;
  // Check every candidate (no early exit) so timing doesn't reveal which step matched.
  for (const step of [now - 1, now, now + 1]) {
    const expected = Buffer.from(hotp(key, step), "utf8");
    if (timingSafeEqual(expected, Buffer.from(given, "utf8")) && matched === null) matched = step;
  }
  return matched;
}

export function verifyTotp(secretBase32: string, code: string, atMs: number): boolean {
  return matchTotpStep(secretBase32, code, atMs) !== null;
}

/** Key URI for authenticator apps (Google Authenticator format). */
export function otpauthUri(secretBase32: string, account: string, issuer: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SEC),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

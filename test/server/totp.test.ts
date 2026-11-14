import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  matchTotpStep,
  otpauthUri,
  totpCode,
  verifyTotp,
} from "../../src/lib/totp.js";

// RFC 6238 Appendix B, SHA-1 seed "12345678901234567890" (8-digit values; 6-digit codes are the last six).
const SEED = base32Encode(Buffer.from("12345678901234567890", "ascii"));
const VECTORS: Array<[number, string]> = [
  [59, "94287082"],
  [1111111109, "07081804"],
  [1111111111, "14050471"],
  [1234567890, "89005924"],
  [2000000000, "69279037"],
  [20000000000, "65353130"],
];

describe("totp", () => {
  it("encodes the RFC seed in base32", () => {
    expect(SEED).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(base32Decode(SEED).toString("ascii")).toBe("12345678901234567890");
    expect(base32Decode("gezd gnbv-gy3t qojq====").toString("ascii")).toBe("1234567890");
    expect(() => base32Decode("ABC1")).toThrow();
  });

  it.each(VECTORS)("matches the RFC 6238 vector at T=%i", (t, eight) => {
    expect(totpCode(SEED, t * 1000)).toBe(eight.slice(-6));
  });

  it("accepts ±1 step and rejects further drift", () => {
    const at = 1111111111 * 1000;
    const code = totpCode(SEED, at);
    expect(verifyTotp(SEED, code, at)).toBe(true);
    expect(verifyTotp(SEED, code, at + 30_000)).toBe(true);
    expect(verifyTotp(SEED, code, at - 30_000)).toBe(true);
    expect(verifyTotp(SEED, code, at + 61_000)).toBe(false);
    expect(verifyTotp(SEED, code, at - 61_000)).toBe(false);
    expect(verifyTotp(SEED, `${code.slice(0, 3)} ${code.slice(3)}`, at)).toBe(true);
  });

  it("returns the matched step and rejects malformed codes", () => {
    const at = 1234567890 * 1000;
    expect(matchTotpStep(SEED, totpCode(SEED, at), at)).toBe(Math.floor(1234567890 / 30));
    expect(matchTotpStep(SEED, "12345", at)).toBeNull();
    expect(matchTotpStep(SEED, "abcdef", at)).toBeNull();
    expect(matchTotpStep("!!!", "123456", at)).toBeNull();
  });

  it("generates 160-bit secrets", () => {
    const s = generateTotpSecret();
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(s)).toHaveLength(20);
    expect(generateTotpSecret()).not.toBe(s);
  });

  it("builds an otpauth URI", () => {
    const uri = otpauthUri("JBSWY3DPEHPK3PXP", "owner@contoso.example", "MailMe");
    expect(uri).toBe(
      "otpauth://totp/MailMe:owner%40contoso.example?secret=JBSWY3DPEHPK3PXP&issuer=MailMe&algorithm=SHA1&digits=6&period=30",
    );
  });
});

import { describe, expect, it } from "vitest";
import { defangText, sanitizeAiText } from "../../../src/digest/sanitize.js";

/** A dotted host (any dot IDNA maps to ".") followed by a path: what a client would auto-link. */
const LINKABLE = /[\p{L}\p{N}-][.。．｡][\p{L}\p{N}-]+\//u;

/** Only platform-signed links are clickable; sanitize.ts: link-like text is defanged so clients can't auto-link it. */
describe("digest-bare-domain-links", () => {
  const LINK_LIKE = [
    "Πληρωμή στο paypal-verify.pl/login σήμερα",
    "Πληρωμή: secure-pay.am/x",
    "Τιμολόγιο invoice.ch/pay",
    "Admin 192.168.1.10/admin",
    "Πληρωμή στο ελληνικό-site.ελ/πληρωμή",
    "Δες evil。com/pay",
    "Δες evil．com/pay",
    "Νέο site: shop.example.co.uk/deal",
    "IDN: xn--80ak6aa92e.com/a",
    "Τιμολόγιο.pdf και verify.pdf/login",
    "x_y.evil.com/pay",
    "port evil.com:8443/x",
  ];

  it.each(LINK_LIKE)("defangText breaks the dot in %s (mail-derived subject)", (input) => {
    const out = defangText(input);
    expect(out).not.toMatch(LINKABLE);
  });

  it.each(LINK_LIKE)("sanitizeAiText breaks the dot in %s (AI title / next action)", (input) => {
    const out = sanitizeAiText(input);
    expect(out).not.toMatch(LINKABLE);
  });

  it.each(["secure-pay.am", "evil.zip", "evil.com.pdf", "10.0.0.1"])("a bare host without a path is defanged too: %s", (host) => {
    expect(defangText(`Δες ${host}`)).not.toContain(host.replace(/\.pdf$/, ""));
  });

  it("defangText breaks an e-mail address on a non-listed TLD", () => {
    expect(defangText("Στείλε στο john@evil.am")).not.toContain("evil.am");
  });

  it("keeps ordinary text readable and unchanged", () => {
    for (const text of [
      "Προσφορά 2026-09-24 για 1.250,00 € — Prosfora_ABC_v2.pdf",
      "Συνάντηση 24.09.2026 στις 10:00",
      "π.χ. η Α.Ε. και κ.α.",
      "Τιμοκατάλογος_2026.xlsx και φωτό.jpg",
      "Ποσό 12.50€ — v2.0",
    ]) {
      expect(defangText(text)).toBe(text);
      expect(sanitizeAiText(text)).toBe(text);
    }
    expect(defangText("Example.com — Αποστολή")).toBe("Example․com — Αποστολή");
  });

  it("is idempotent on defanged output", () => {
    for (const input of LINK_LIKE) {
      expect(defangText(defangText(input))).toBe(defangText(input));
      expect(sanitizeAiText(sanitizeAiText(input))).toBe(sanitizeAiText(input));
    }
  });
});

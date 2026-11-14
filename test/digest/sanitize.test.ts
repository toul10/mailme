import { describe, expect, it } from "vitest";
import { cleanText, defangText, escapeHtml, sanitizeAiText } from "../../src/digest/sanitize.js";

describe("escapeHtml", () => {
  it("escapes the five HTML metacharacters", () => {
    expect(escapeHtml(`<script>alert("x")</script> & 'y'`)).toBe("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39;");
    expect(escapeHtml(null)).toBe("");
  });
});

describe("cleanText", () => {
  it("removes control and bidi-override characters and collapses whitespace", () => {
    expect(cleanText("a\u0000b\u202Ec\u200B d\n\n e")).toBe("abc d e");
  });
  it("caps length with an ellipsis", () => {
    expect(cleanText("x".repeat(20), 10)).toBe("xxxxxxxxx…");
  });
});

describe("sanitizeAiText (AI-written fields)", () => {
  it("removes URLs with a scheme and www links", () => {
    const out = sanitizeAiText("Πλήρωσε εδώ https://evil.example/pay?x=1 ή www.evil.gr/login τώρα");
    expect(out).not.toMatch(/https?:|evil|www/i);
    expect(out).toContain("[link]");
  });
  it("removes javascript:/data:/mailto:/tel: pseudo-links", () => {
    for (const s of ["javascript:alert(1)", "data:text/html;base64,AAAA", "mailto:x@y.example", "tel:+302101234567"]) {
      expect(sanitizeAiText(`Κάνε κλικ ${s}`)).toBe("Κάνε κλικ [link]");
    }
  });
  it("does not treat an ordinary word followed by a colon as a link", () => {
    expect(sanitizeAiText("Missing data: send the file")).toBe("Missing data: send the file");
  });
  it("removes e-mail addresses", () => {
    expect(sanitizeAiText("Στείλε στο pay@evil-bank.com την απόδειξη")).toBe("Στείλε στο [email] την απόδειξη");
  });
  it("removes Greek and international phone numbers", () => {
    expect(sanitizeAiText("Πάρε τηλέφωνο στο 210 123 4567")).toBe("Πάρε τηλέφωνο στο [phone]");
    expect(sanitizeAiText("Κινητό 6912345678 για επιβεβαίωση")).toBe("Κινητό [phone] για επιβεβαίωση");
    expect(sanitizeAiText("Call +44 20 7946 0958 now")).toBe("Call [phone] now");
  });
  it("keeps dates, amounts and file names", () => {
    expect(sanitizeAiText("Προσφορά 2026-09-24 για 1.250,00 € — Prosfora_ABC_v2.pdf")).toBe("Προσφορά 2026-09-24 για 1.250,00 € — Prosfora_ABC_v2.pdf");
  });
  it("defangs bare domains so company names stay readable but are not links", () => {
    const out = sanitizeAiText("Example.com — Αποστολή τιμολογίου");
    expect(out).toBe("Example\u2024com — Αποστολή τιμολογίου");
    expect(out).not.toMatch(/example\.com/i);
  });
  it("is idempotent", () => {
    const once = sanitizeAiText("Δες https://x-gr.example και mail a@b-gr.example, 2101234567, abc.com");
    expect(sanitizeAiText(once)).toBe(once);
  });
});

describe("defangText (mail-derived fields)", () => {
  it("keeps the words but breaks link-like tokens", () => {
    const out = defangText("ΑΠ: Πληρωμή https://evil.gr/pay από client@abc-gr.example");
    expect(out).toContain("ΑΠ: Πληρωμή");
    expect(out).not.toMatch(/https:\/\/|evil\.gr|abc\.gr/);
    expect(out).toContain("evil\u2024gr");
  });
  it("leaves ordinary subjects untouched", () => {
    expect(defangText("Προσφορά για ηχεία — Παρασκευή 10:00")).toBe("Προσφορά για ηχεία — Παρασκευή 10:00");
  });
});

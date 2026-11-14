import { simpleParser } from "mailparser";
import { describe, expect, it } from "vitest";
import { composeDigestMime, digestMessageId } from "../../src/digest/mime.js";

describe("digestMessageId", () => {
  it("is deterministic per user and local date, without angle brackets", () => {
    const id = digestMessageId("3f1c-user", "2026-09-24", "mailme.contoso.example");
    expect(id).toBe("digest.3f1c-user.2026-09-24@mailme.contoso.example");
    expect(digestMessageId("3f1c-user", "2026-09-24", "MailMe.Contoso.example")).toBe(id);
  });
});

describe("composeDigestMime", () => {
  it("produces a multipart/alternative message with the loop-prevention headers", async () => {
    const raw = await composeDigestMime({
      from: '"MailMe" <owner@contoso.example>',
      to: "owner@contoso.example",
      subject: "📋 Tasks — Thu 24 Sep · 3 due today",
      html: "<p>Good morning ☕</p>",
      text: "Good morning ☕",
      messageId: "digest.u1.2026-09-24@mailme.test",
      date: new Date("2026-09-24T04:30:00Z"),
    });
    const head = raw.toString("utf8").split(/\r?\n\r?\n/)[0]!;
    expect(head).toMatch(/^Auto-Submitted: auto-generated$/m);
    expect(head).toMatch(/^X-Auto-Response-Suppress: All$/m);
    // nodemailer normalizes the field-name case (X-Mailme-Kind); field names are case-insensitive (RFC 5322).
    expect(head).toMatch(/^X-MailMe-Kind: digest$/im);
    expect(head).toMatch(/^Message-ID: <digest\.u1\.2026-09-24@mailme\.test>$/im);
    expect(head).toMatch(/^Content-Type: multipart\/alternative/m);

    const parsed = await simpleParser(raw);
    expect(parsed.subject).toBe("📋 Tasks — Thu 24 Sep · 3 due today");
    expect(parsed.messageId).toBe("<digest.u1.2026-09-24@mailme.test>");
    expect(parsed.text?.trim()).toBe("Good morning ☕");
    expect(parsed.html).toContain("<p>Good morning ☕</p>");
    expect(parsed.from?.value[0]?.address).toBe("owner@contoso.example");
    expect(parsed.date?.toISOString()).toBe("2026-09-24T04:30:00.000Z");
    expect(parsed.headers.get("x-mailme-kind")).toBe("digest");
    expect(parsed.headers.get("auto-submitted")).toBe("auto-generated");
  });

  it("accepts a Message-ID that already has angle brackets", async () => {
    const raw = await composeDigestMime({ from: "a@b-gr.example", to: "a@b-gr.example", subject: "x", html: "<p>x</p>", text: "x", messageId: "<digest.u.2026-09-24@m.test>", date: new Date() });
    expect(raw.toString("utf8")).toMatch(/^Message-ID: <digest\.u\.2026-09-24@m\.test>$/im);
  });
});

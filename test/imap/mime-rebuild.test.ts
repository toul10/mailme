import { describe, expect, it } from "vitest";
import { simpleParser } from "mailparser";
import type { MessageStructureObject } from "imapflow";
import { encodeWords, filterHeaders, rebuildMime } from "../../src/mail/imap/mime-rebuild.js";

const top = (extra: string[] = []) =>
  Buffer.from(
    [
      "From: Client <client@abc-gr.example>",
      "To: owner@contoso.example",
      "Subject: FW: order",
      "Message-ID: <fw@abc-gr.example>",
      "Date: Tue, 22 Sep 2026 10:00:00 +0300",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed;\r\n boundary="xyz"',
      "Content-Transfer-Encoding: 7bit",
      ...extra,
      "",
      "",
    ].join("\r\n"),
    "latin1",
  );

describe("rebuildMime", () => {
  it("keeps a forwarded-as-attachment message (header + text) and turns other leaves into named placeholders", async () => {
    const structure: MessageStructureObject = {
      type: "multipart/mixed",
      childNodes: [
        { part: "1", type: "text/plain", parameters: { charset: "utf-8" }, encoding: "8bit", size: 40 },
        {
          part: "2",
          type: "message/rfc822",
          size: 30_000_000,
          childNodes: [
            {
              part: "2",
              type: "multipart/mixed",
              childNodes: [
                { part: "2.1", type: "text/plain", parameters: { charset: "utf-8" }, encoding: "base64", size: 100 },
                { part: "2.2", type: "application/vnd.ms-excel", parameters: { name: "Τιμές.xls" }, encoding: "base64", size: 29_000_000, disposition: "attachment" },
              ],
            },
          ],
        },
        { part: "3", type: "text/plain", encoding: "base64", size: 5000, disposition: "attachment", dispositionParameters: { filename: "notes.txt" } },
      ],
    };
    const parts = new Map<string, Buffer>([
      ["1", Buffer.from("Μπορείς να το αναλάβεις;", "utf8")],
      ["2.header", Buffer.from("From: Supplier <s@sup.example>\r\nSubject: Order 55\r\nDate: Mon, 21 Sep 2026 09:00:00 +0300\r\nContent-Type: multipart/mixed; boundary=\"inner\"\r\n\r\n", "latin1")],
      ["2.1", Buffer.from(Buffer.from("Παραγγελία 55 επισυνάπτεται.", "utf8").toString("base64"), "latin1")],
    ]);
    const raw = rebuildMime(top(), structure, parts);
    const text = raw.toString("latin1");
    expect(text).not.toContain('boundary="xyz"');
    expect(text).toContain("X-MailMe-Partial: large-message");

    const parsed = await simpleParser(raw);
    expect(parsed.subject).toBe("FW: order");
    expect(parsed.text).toContain("Μπορείς να το αναλάβεις;");
    const names = parsed.attachments.map((a) => [a.contentType, a.filename]);
    expect(names).toContainEqual(["text/plain", "notes.txt"]);
    const embedded = parsed.attachments.find((a) => a.contentType === "message/rfc822");
    expect(embedded).toBeDefined();
    const inner = await simpleParser(embedded!.content);
    expect(inner.subject).toBe("Order 55");
    expect(inner.from?.value[0]?.address).toBe("s@sup.example");
    expect(inner.text).toContain("Παραγγελία 55 επισυνάπτεται.");
    expect(inner.attachments.map((a) => a.filename)).toEqual(["Τιμές.xls"]);
  });

  it("single-part text messages use the TEXT section; placeholders carry the size", async () => {
    const plain: MessageStructureObject = { type: "text/plain", parameters: { charset: "utf-8", format: "flowed" }, encoding: "quoted-printable", size: 9_000_000 };
    const parsed = await simpleParser(rebuildMime(top(), plain, new Map([["text", Buffer.from("Hello =CE=B3=CE=B5=CE=B9=CE=B1", "latin1")]])));
    expect(parsed.text?.trim()).toBe("Hello γεια");

    const pdfOnly: MessageStructureObject = { type: "application/pdf", parameters: { name: "big.pdf" }, encoding: "base64", size: 12_345_678 };
    const raw = rebuildMime(top(), pdfOnly, new Map());
    expect(raw.toString("latin1")).toMatch(/Content-Disposition: attachment; filename="big.pdf"; size="12345678"/);
    const p2 = await simpleParser(raw);
    expect(p2.attachments.map((a) => [a.filename, a.contentType])).toEqual([["big.pdf", "application/pdf"]]);
  });

  it("filterHeaders keeps folded non-structure fields and 8-bit bytes", () => {
    const raw = Buffer.concat([
      Buffer.from("Subject: first\r\n second\r\nContent-Type: text/plain\r\nX-Name: ", "latin1"),
      Buffer.from("Κ", "utf8"),
      Buffer.from("\r\nMIME-Version: 1.0\r\n\r\n", "latin1"),
    ]);
    const out = filterHeaders(raw);
    expect(out).toEqual(["Subject: first\r\n second", `X-Name: ${Buffer.from("Κ", "utf8").toString("latin1")}`]);
  });

  it("encodeWords never splits a character and keeps words short", () => {
    const w = encodeWords("Προσφορά για την ανανέωση του συμβολαίου συντήρησης 2026");
    for (const word of w.split(" ")) expect(word.length).toBeLessThanOrEqual(75);
    const decoded = w
      .split(" ")
      .map((x) => Buffer.from(x.slice(10, -2), "base64").toString("utf8"))
      .join("");
    expect(decoded).toBe("Προσφορά για την ανανέωση του συμβολαίου συντήρησης 2026");
  });
});

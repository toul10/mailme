import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HEADER_ALLOWLIST, parseMime } from "../../src/mail/parse.js";
import { segmentBody } from "../../src/mail/segment.js";
import { FIXTURES, fixture, parseFixture } from "./helpers.js";

const segmentsOf = async (name: string) => {
  const p = await parseFixture(name);
  return segmentBody({ textPlain: p.textPlain, textHtml: p.textHtml }, { subject: p.subject });
};

describe("parseMime — every fixture", () => {
  const files = readdirSync(FIXTURES).filter((f) => f.endsWith(".eml"));

  it("has at least 25 synthetic fixtures", () => {
    expect(files.length).toBeGreaterThanOrEqual(25);
  });

  it.each(files)("%s parses without throwing and keeps only allow-listed headers", async (f) => {
    const p = await parseMime(fixture(f));
    expect(Object.keys(p.headers).every((h) => (HEADER_ALLOWLIST as readonly string[]).includes(h))).toBe(true);
    expect(p.sizeBytes).toBe(fixture(f).length);
    expect(p.messageIdHeader ?? "").not.toMatch(/[<>]/);
    for (const a of p.attachments) expect(Object.keys(a).sort()).toEqual(["contentType", "filename", "inline", "size"]);
  });
});

describe("parseMime — envelope", () => {
  it("normalizes ids, decodes Greek names/subjects, keeps allow-listed headers and the delivery trace", async () => {
    const p = await parseFixture("el-outlook-reply.eml");
    expect(p.messageIdHeader).toBe("AM9P193MB1234ALFA0001@am9p193mb1234.eurprd09.prod.outlook.example");
    expect(p.inReplyTo).toBe("owner-offer-1@contoso.example");
    expect(p.references).toEqual(["owner-offer-1@contoso.example"]);
    expect(p.from).toEqual({ address: "g.georgiou@alfa-ilektroniki.example", name: "Γιάννης Γεωργίου" });
    expect(p.cc).toEqual([{ address: "g.antoniou@contoso.example", name: "Γιώργος Αντωνίου" }]);
    expect(p.subject).toBe("ΑΠ: Προσφορά ηχείων για το συνεδριακό κέντρο");
    expect(p.dateHeader?.toISOString()).toBe("2026-09-09T07:02:11.000Z");
    expect(p.threadIndex).toBe("AQHc8e2Qx1bXfT0uS0WmI3mZ5Gm1YrJ+AbCdEfGh");
    expect(p.headers["thread-topic"]).toBe("Προσφορά ηχείων για το συνεδριακό κέντρο");
    expect(p.headers["x-mailer"]).toBe("Microsoft Outlook 16.0");
    expect(p.hasDeliveryTrace).toBe(true);
    expect(p.textHtml).toContain("border-top:solid #E1E1E1");
  });

  it("client-saved Sent copies have no delivery trace", async () => {
    expect((await parseFixture("outbound-offer.eml")).hasDeliveryTrace).toBe(false);
    expect((await parseFixture("self-sent-sent.eml")).hasDeliveryTrace).toBe(false);
    expect((await parseFixture("self-sent-inbox.eml")).hasDeliveryTrace).toBe(true);
  });

  it("returns null (not 'now') for a missing or invalid Date and a missing Message-ID", async () => {
    const noDate = await parseMime(Buffer.from("From: a@b.example\r\nSubject: x\r\n\r\nbody"));
    expect(noDate.dateHeader).toBeNull();
    const bad = await parseMime(Buffer.from("From: a@b.example\r\nDate: someday soon\r\nSubject: x\r\n\r\nbody"));
    expect(bad.dateHeader).toBeNull();
    expect(bad.decodeWarnings).toContain("date_unparseable");
    const noId = await parseFixture("no-message-id.eml");
    expect(noId.messageIdHeader).toBeNull();
  });

  it("repairs raw 8-bit windows-1253 subjects", async () => {
    const raw = Buffer.concat([
      Buffer.from("From: a@b.example\r\nSubject: ", "latin1"),
      Buffer.from([0xd0, 0xf1, 0xef, 0xf3, 0xf6, 0xef, 0xf1, 0xdc]),
      Buffer.from("\r\nDate: Wed, 9 Sep 2026 10:02:00 +0300\r\n\r\nbody", "latin1"),
    ]);
    const p = await parseMime(raw);
    expect(p.subject).toBe("Προσφορά");
  });

  it("never throws on garbage input", async () => {
    const p = await parseMime(Buffer.from([0, 1, 2, 3, 0xff, 0xfe]));
    expect(p.from).toBeNull();
    expect(p.subject).toBe("");
  });
});

describe("parseMime — charsets", () => {
  it("decodes correctly declared windows-1253 and iso-8859-7 (headers and bodies)", async () => {
    const w = await parseFixture("windows-1253.eml");
    expect(w.subject).toBe("Επιβεβαίωση παραγγελίας");
    expect(w.from?.name).toBe("Άννα Μιχαήλ");
    expect(w.textPlain).toContain("Επιβεβαιώνουμε την παραγγελία των 10 ηχείων");
    expect(w.decodeWarnings).toEqual([]);
    const iso = await parseFixture("iso-8859-7-html.eml");
    expect(iso.subject).toBe("Επισκευή κονσόλας");
    expect(iso.textHtml).toContain("Αγαπητέ κύριε Παπαδόπουλε");
  });

  it("repairs windows-1253 bytes mislabeled as UTF-8", async () => {
    const p = await parseFixture("mislabeled-1253.eml");
    expect(p.textPlain).toContain("Στείλτε μας παρακαλώ την προσφορά για τα μικρόφωνα μέχρι αύριο.");
    expect(p.textPlain).not.toMatch(/\u{FFFD}/u);
    expect(p.decodeWarnings).toContain("charset_repaired:windows-1253");
  });
});

describe("parseMime — more charset & report cases", () => {
  it("repairs Greek text declared as iso-8859-1 (HTML only)", async () => {
    const greek = Buffer.from([0xca, 0xe1, 0xeb, 0xe7, 0xec, 0xdd, 0xf1, 0xe1, 0x20, 0xf3, 0xe1, 0xf2]); // «Καλημέρα σας» ("Good morning")
    const raw = Buffer.concat([
      Buffer.from("From: a@b.example\r\nSubject: x\r\nContent-Type: text/html; charset=iso-8859-1\r\nContent-Transfer-Encoding: 8bit\r\n\r\n<p>", "latin1"),
      greek,
      Buffer.from("</p>", "latin1"),
    ]);
    const p = await parseMime(raw);
    expect(p.textHtml).toBe("<p>Καλημέρα σας</p>");
    expect(p.decodeWarnings).toContain("charset_repaired:windows-1253");
  });

  it("flags read receipts (multipart/report; report-type=disposition-notification) without treating them as bounces", async () => {
    const raw = [
      "From: m.konstantinou@vita-texniki.example",
      "To: owner@contoso.example",
      "Subject: Read: Offer",
      "Content-Type: multipart/report; report-type=disposition-notification; boundary=R",
      "",
      "--R",
      "Content-Type: text/plain",
      "",
      "Your message was read.",
      "--R",
      "Content-Type: message/disposition-notification",
      "",
      "Final-Recipient: rfc822;m.konstantinou@vita-texniki.example",
      "Disposition: manual-action/MDN-sent-manually; displayed",
      "--R--",
    ].join("\r\n");
    const p = await parseMime(Buffer.from(raw));
    expect(p.decodeWarnings).toContain("mdn");
    expect(p.bounce).toBeNull();
    expect(p.attachments).toEqual([]);
  });
});

describe("parseMime — attachments", () => {
  it("keeps metadata only; inline images are flagged", async () => {
    const p = await parseFixture("outbound-offer.eml");
    expect(p.attachments).toEqual([
      { filename: "image001.png", contentType: "image/png", size: 69, inline: true },
      { filename: "Prosfora_Alfa_v2.pdf", contentType: "application/pdf", size: 70, inline: false },
    ]);
    expect(JSON.stringify(p)).not.toContain("%PDF");
  });

  it("flags TNEF and S/MIME", async () => {
    const t = await parseFixture("tnef.eml");
    expect(t.decodeWarnings).toContain("tnef");
    expect(t.attachments.map((a) => a.filename)).toEqual(["winmail.dat"]);
    const s = await parseFixture("smime-encrypted.eml");
    expect(s.decodeWarnings).toContain("smime_encrypted");
    expect(s.textPlain).toBeNull();
  });

  it("turns a message/rfc822 attachment into a FORWARDED segment", async () => {
    const p = await parseFixture("forward-as-attachment.eml");
    expect(p.decodeWarnings).toContain("embedded_message");
    expect(p.attachments).toEqual([]);
    const segs = await segmentsOf("forward-as-attachment.eml");
    expect(segs.map((s) => s.kind)).toEqual(["NEW", "FORWARDED"]);
    expect(segs[1]).toMatchObject({
      author: "Μαρία Κωνσταντίνου <m.konstantinou@vita-texniki.example>",
      date: "2026-09-09T11:00:00Z",
      text: "Η παράδοση καθυστερεί ήδη μία εβδομάδα. Παρακαλούμε ενημερώστε μας άμεσα για τη νέα ημερομηνία.",
    });
  });
});

describe("parseMime — calendar", () => {
  it("parses an Outlook invite (GTB Standard Time, folded lines, escaped text)", async () => {
    const p = await parseFixture("calendar-invite.eml");
    expect(p.calendar).toEqual({
      method: "REQUEST",
      summary: "Συνάντηση για την εγκατάσταση ηχείων στο συνεδριακό κέντρο",
      start: "2026-09-15T07:00:00Z",
      end: "2026-09-15T08:00:00Z",
      tzid: "GTB Standard Time",
      organizer: "g.georgiou@alfa-ilektroniki.example",
      location: "Γραφεία Άλφα, Λεωφ. Κηφισίας 100",
    });
    expect(p.attachments).toEqual([]);
  });

  it("parses a calendar reply", async () => {
    expect((await parseFixture("calendar-reply.eml")).calendar?.method).toBe("REPLY");
  });
});

describe("parseMime — delivery reports", () => {
  it("Postfix DSN with text/rfc822-headers", async () => {
    const p = await parseFixture("bounce-postfix.eml");
    expect(p.bounce).toEqual({
      action: "failed",
      originalMessageId: "owner-offer-1@contoso.example",
      recipient: "g.georgiou@alfa-ilektroniki.example",
      diagnostic: "550 5.1.1 <g.georgiou@alfa-ilektroniki.example>: Recipient address rejected: User unknown",
    });
    expect(p.attachments).toEqual([]);
  });

  it("Exchange NDR with the original as message/rfc822 (not turned into a forward)", async () => {
    const p = await parseFixture("bounce-exchange.eml");
    expect(p.bounce).toMatchObject({ action: "failed", originalMessageId: "owner-q118@contoso.example", recipient: "old.buyer@northwind-audio.example" });
    expect(p.decodeWarnings).not.toContain("embedded_message");
  });

  it("qmail plain-text bounce (heuristic)", async () => {
    const p = await parseFixture("bounce-qmail.eml");
    expect(p.bounce).toEqual({
      action: "failed",
      originalMessageId: "owner-inv-457@contoso.example",
      recipient: "accounts@vita-texniki.example",
      diagnostic: "Sorry, no mailbox here by that name. (#5.1.1)",
    });
  });

  it("an ordinary message is not a bounce", async () => {
    expect((await parseFixture("gmail-reply-en.eml")).bounce).toBeNull();
  });
});

describe("fixtures × segmentBody", () => {
  it("Greek Outlook reply: NEW without signature/disclaimer, QUOTED owner's offer", async () => {
    const segs = await segmentsOf("el-outlook-reply.eml");
    expect(segs.map((s) => [s.kind, s.author, s.date])).toEqual([
      ["NEW", null, null],
      ["QUOTED", "Νίκος Παπαδόπουλος <owner@contoso.example>", "2026-09-08T12:45:00Z"],
    ]);
    expect(segs[0]!.text).toBe(
      "Καλημέρα κύριε Παπαδόπουλε,\n\nΕυχαριστούμε για την προσφορά. Μπορείτε να μας στείλετε και τα τεχνικά φυλλάδια των ηχείων μέχρι την Πέμπτη;",
    );
  });

  it("the text alternative of the same reply segments the same way", async () => {
    const p = await parseFixture("el-outlook-reply.eml");
    const segs = segmentBody({ textPlain: p.textPlain, textHtml: null }, { subject: p.subject });
    expect(segs.map((s) => s.kind)).toEqual(["NEW", "QUOTED"]);
    expect(segs[0]!.text).toContain("μέχρι την Πέμπτη;");
    expect(segs[0]!.text).not.toMatch(/εμπιστευτικά|210 5551234/);
  });

  it("English Outlook 365 reply: two quoted messages with authors and dates, disclaimer dropped", async () => {
    const segs = await segmentsOf("en-outlook-reply.eml");
    expect(segs.map((s) => [s.kind, s.author, s.date])).toEqual([
      ["NEW", null, null],
      ["QUOTED", "Nikos Papadopoulos <owner@contoso.example>", "2026-09-10T13:12:00Z"],
      ["QUOTED", "John Carter <j.carter@northwind-audio.example>", "2026-09-09T08:30:00Z"],
    ]);
    expect(segs[0]!.text).not.toContain("Procurement");
    expect(segs[2]!.text).toBe("Hello Nikos, please quote 4 x Class-D amplifiers, 2x500W.");
  });

  it("ΠΡΘ forward keeps the forwarded payload as FORWARDED", async () => {
    const segs = await segmentsOf("el-forward-prth.eml");
    expect(segs.map((s) => s.kind)).toEqual(["NEW", "FORWARDED"]);
    expect(segs[0]!.text).toContain("μπορείς να το αναλάβεις;");
    expect(segs[1]!.text).toContain("5 ασύρματα μικρόφωνα");
  });

  it("Gmail (EN/EL), Apple Mail, Thunderbird, inline replies", async () => {
    expect((await segmentsOf("gmail-reply-en.eml")).map((s) => s.kind)).toEqual(["NEW", "QUOTED"]);
    const el = await segmentsOf("gmail-reply-el.eml");
    expect(el[1]).toMatchObject({ kind: "QUOTED", author: "Νίκος Παπαδόπουλος <owner@contoso.example>", date: "2026-09-09T07:02:00Z" });
    expect((await segmentsOf("gmail-forward.eml")).map((s) => s.kind)).toEqual(["NEW", "FORWARDED"]);
    const apple = await segmentsOf("apple-mail-reply.eml");
    expect(apple.map((s) => [s.kind, s.text])).toEqual([
      ["NEW", "Great, see you on Monday at 10:00."],
      ["QUOTED", "Hi John, can we meet on Monday to finalize the installation plan?\nNikos"],
    ]);
    expect((await segmentsOf("thunderbird-reply.eml")).map((s) => s.kind)).toEqual(["NEW", "QUOTED", "QUOTED"]);
    expect((await segmentsOf("inline-reply.eml")).map((s) => s.kind)).toEqual(["QUOTED", "NEW", "QUOTED", "NEW"]);
    expect((await segmentsOf("outlook-original-message.eml")).map((s) => s.kind)).toEqual(["NEW", "QUOTED"]);
    expect((await segmentsOf("el-plain-header-block.eml")).map((s) => s.kind)).toEqual(["NEW", "QUOTED"]);
  });

  it("newsletter HTML drops hidden preheaders and styles", async () => {
    const segs = await segmentsOf("newsletter.eml");
    expect(segs[0]!.text).not.toContain("preheader");
    expect(segs[0]!.text).toContain("Έως -30% σε επιλεγμένα ηχεία!");
  });
});

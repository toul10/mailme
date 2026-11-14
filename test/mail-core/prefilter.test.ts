import { describe, expect, it } from "vitest";
import type { MailRule } from "../../src/domain/rules.js";
import type { Direction, FolderRole, ParsedMail } from "../../src/domain/types.js";
import { phishingSignals, prefilter, type PrefilterInput } from "../../src/mail/prefilter.js";
import { segmentBody } from "../../src/mail/segment.js";
import { parsedMail, parseFixture } from "./helpers.js";

function run(parsed: ParsedMail, over: Partial<PrefilterInput> = {}) {
  return prefilter({
    parsed,
    direction: "INBOUND",
    folderRole: "inbox",
    flags: [],
    platformMailDomain: "mailme.local",
    isKnownPlatformMessage: false,
    denyList: [],
    isKnownContact: false,
    segments: segmentBody({ textPlain: parsed.textPlain, textHtml: parsed.textHtml }, { subject: parsed.subject }),
    ...over,
  });
}

async function runFixture(name: string, over: Partial<PrefilterInput> & { direction?: Direction; folderRole?: FolderRole | null } = {}) {
  return run(await parseFixture(name), over);
}

describe("prefilter — fixtures", () => {
  it.each<[string, string | null, string | null, Partial<PrefilterInput>?]>([
    ["el-outlook-reply.eml", null, null],
    ["en-outlook-reply.eml", null, null],
    ["gmail-forward.eml", null, null],
    ["calendar-invite.eml", null, null],
    ["no-message-id.eml", null, null],
    ["mislabeled-1253.eml", null, null],
    ["tnef.eml", null, null],
    // Own mail = a recorded digest (ingest looks it up in `digests`); the headers alone never count.
    ["platform-digest.eml", "OWN_MAIL", "AUTOMATED", { isKnownPlatformMessage: true }],
    ["bounce-postfix.eml", "BOUNCE", "AUTOMATED"],
    ["bounce-exchange.eml", "BOUNCE", "AUTOMATED"],
    ["bounce-qmail.eml", "BOUNCE", "AUTOMATED"],
    ["ooo-auto-submitted.eml", "OUT_OF_OFFICE", "AUTOMATED"],
    ["ooo-exchange.eml", "OUT_OF_OFFICE", "AUTOMATED"],
    ["calendar-reply.eml", "CALENDAR_REPLY", "AUTOMATED"],
    ["newsletter.eml", "BULK", "MARKETING"],
    ["noreply-notification.eml", "NOREPLY", "AUTOMATED"],
    ["smime-encrypted.eml", "ENCRYPTED", null],
    ["empty-reply.eml", "EMPTY", null],
  ])("%s → %s", async (name, reason, classification, over) => {
    expect(await runFixture(name, over)).toEqual({ reason, classification });
  });

  it("MAILER-DAEMON mail is BOUNCE, not NOREPLY; OOO wins over Precedence: bulk", async () => {
    expect((await runFixture("bounce-qmail.eml")).reason).toBe("BOUNCE");
    expect((await parseFixture("ooo-exchange.eml")).headers.precedence).toBe("bulk");
    expect((await runFixture("ooo-exchange.eml")).reason).toBe("OUT_OF_OFFICE");
  });

  it("drafts and deleted copies are never read", async () => {
    expect((await runFixture("draft.eml", { direction: "OUTBOUND", folderRole: "drafts" })).reason).toBe("DRAFT_OR_DELETED");
    expect((await runFixture("draft.eml", { direction: "OUTBOUND", folderRole: "sent", flags: ["\\Draft"] })).reason).toBe("DRAFT_OR_DELETED");
    expect((await runFixture("el-outlook-reply.eml", { flags: ["\\Seen", "\\Deleted"] })).reason).toBe("DRAFT_OR_DELETED");
    expect((await runFixture("outbound-promise.eml", { direction: "OUTBOUND", folderRole: "sent", flags: ["\\Seen"] })).reason).toBeNull();
  });

  it("spam folder is filtered unless the sender is a known contact", async () => {
    expect((await runFixture("el-outlook-reply.eml", { folderRole: "junk" })).reason).toBe("SPAM_FOLDER");
    expect((await runFixture("el-outlook-reply.eml", { folderRole: "junk", isKnownContact: true })).reason).toBeNull();
  });

  it("own mail is checked first and needs a recorded digest: a platform-domain Message-ID + X-MailMe-Kind can be forged", async () => {
    const digest = await parseFixture("platform-digest.eml");
    expect(run(digest, { folderRole: "junk", flags: ["\\Deleted"], isKnownPlatformMessage: true }).reason).toBe("OWN_MAIL");
    // Headers alone (platform domain + X-MailMe-Kind, no digests row) are not own mail.
    expect(run(digest).reason).not.toBe("OWN_MAIL");
    const forgedHeaderOnly = { ...digest, messageIdHeader: "abc@evil.example" };
    expect(run(forgedHeaderOnly).reason).not.toBe("OWN_MAIL");
    const domainOnly = { ...digest, headers: {} };
    expect(run(domainOnly).reason).not.toBe("OWN_MAIL");
    expect(run(domainOnly, { isKnownPlatformMessage: true }).reason).toBe("OWN_MAIL");
  });
});

describe("prefilter — rules", () => {
  it("deny-list: INBOUND sender by address or domain (incl. subdomains)", () => {
    const m = parsedMail({ from: { address: "alerts@mybank.example", name: null } });
    expect(run(m, { denyList: ["@mybank.example"] })).toEqual({ reason: "DENYLIST", classification: "PERSONAL" });
    expect(run(parsedMail({ from: { address: "x@e.mybank.example", name: null } }), { denyList: ["mybank.example"] }).reason).toBe("DENYLIST");
    expect(run(parsedMail({ from: { address: "doctor@clinic.example", name: null } }), { denyList: ["doctor@clinic.example"] }).reason).toBe("DENYLIST");
    expect(run(parsedMail(), { denyList: ["@mybank.example"] }).reason).toBeNull();
  });

  it("muted (the owner's “Ignore”): INBOUND sender by address or domain, never OUTBOUND", () => {
    const m = parsedMail({ from: { address: "offers@supplier.example", name: null } });
    expect(run(m, { mutedList: ["@supplier.example"] })).toEqual({ reason: "MUTED", classification: null });
    expect(run(parsedMail({ from: { address: "x@news.supplier.example", name: null } }), { mutedList: ["@supplier.example"] }).reason).toBe("MUTED");
    expect(run(m, { mutedList: ["offers@supplier.example"] }).reason).toBe("MUTED");
    expect(run(m, { mutedList: ["sales@supplier.example"] }).reason).toBeNull();
    expect(run(m, { mutedList: [] }).reason).toBeNull();
    const owner = { address: "owner@contoso.example", name: null };
    const promise = parsedMail({ from: owner, to: [{ address: "offers@supplier.example", name: null }] });
    expect(run(promise, { direction: "OUTBOUND", mutedList: ["@supplier.example"] }).reason).toBeNull();
    // The privacy deny-list still wins (bodies dropped).
    expect(run(m, { denyList: ["@supplier.example"], mutedList: ["@supplier.example"] }).reason).toBe("DENYLIST");
  });

  it("deny-list: OUTBOUND only when every recipient is denied", () => {
    const owner = { address: "owner@contoso.example", name: null };
    const toDoctor = parsedMail({ from: owner, to: [{ address: "doctor@clinic.example", name: null }] });
    expect(run(toDoctor, { direction: "OUTBOUND", denyList: ["@clinic.example"] }).reason).toBe("DENYLIST");
    const mixed = parsedMail({ from: owner, to: [{ address: "doctor@clinic.example", name: null }, { address: "b@alfa.example", name: null }] });
    expect(run(mixed, { direction: "OUTBOUND", denyList: ["@clinic.example"] }).reason).toBeNull();
  });

  it("bulk / noreply only apply to INBOUND", () => {
    const bulk = parsedMail({ headers: { "list-unsubscribe": "<mailto:u@x.example>" } });
    expect(run(bulk).reason).toBe("BULK");
    expect(run(bulk, { direction: "OUTBOUND" }).reason).toBeNull();
    expect(run(parsedMail({ headers: { precedence: "junk" } })).reason).toBe("BULK");
    expect(run(parsedMail({ headers: { "x-mailchimp-campaign": "x" } })).reason).toBe("BULK");
    expect(run(parsedMail({ from: { address: "donotreply@shop.example", name: null } })).reason).toBe("NOREPLY");
    expect(run(parsedMail({ from: { address: "noreply+123@shop.example", name: null } })).reason).toBe("NOREPLY");
    expect(run(parsedMail({ from: { address: "info@shop.example", name: null } })).reason).toBeNull();
  });

  it("out-of-office variants (RFC 3834, X-Autoreply, subject prefixes)", () => {
    expect(run(parsedMail({ headers: { "auto-submitted": "auto-replied (vacation)" } })).reason).toBe("OUT_OF_OFFICE");
    expect(run(parsedMail({ headers: { "x-autoreply": "yes" } })).reason).toBe("OUT_OF_OFFICE");
    expect(run(parsedMail({ subject: "Εκτός γραφείου: Προσφορά" })).reason).toBe("OUT_OF_OFFICE");
    expect(run(parsedMail({ subject: "Out of Office: Re: Quote" })).reason).toBe("OUT_OF_OFFICE");
    expect(run(parsedMail({ subject: "Automatic reply: Προσφορά" })).reason).toBe("OUT_OF_OFFICE");
    expect(run(parsedMail({ subject: "Αυτόματη απάντηση: Προσφορά" })).reason).toBe("OUT_OF_OFFICE");
    expect(run(parsedMail({ subject: "Εκτός γραφείου" })).reason).toBe("OUT_OF_OFFICE");
    expect(run(parsedMail({ subject: "Out of Office AutoReply: Order" })).reason).toBe("OUT_OF_OFFICE");
    expect(run(parsedMail({ headers: { "auto-submitted": "auto-generated" } })).reason).toBeNull();
  });

  it("bare out-of-office words in a human subject need an automation hint", () => {
    const handover = parsedMail({ subject: "Εκτός γραφείου 28/9-2/10 — εκκρεμότητες", textPlain: "Σε παρακαλώ στείλε εσύ την προσφορά." });
    expect(run(handover).reason).toBeNull();
    expect(run(parsedMail({ subject: "Out of office next week - please cover ABC order" })).reason).toBeNull();
    expect(run({ ...handover, headers: { "x-auto-response-suppress": "All" } }).reason).toBe("OUT_OF_OFFICE");
    expect(run({ ...handover, headers: { precedence: "auto_reply" } }).reason).toBe("OUT_OF_OFFICE");
    expect(run({ ...handover, headers: { "return-path": "<>" } }).reason).toBe("OUT_OF_OFFICE");
    expect(run({ ...handover, headers: { "auto-submitted": "no" } }).reason).toBeNull();
  });

  it("read receipts (MDN) are automated", () => {
    expect(run(parsedMail({ decodeWarnings: ["mdn"], subject: "Διαβάστηκε: Προσφορά" })).reason).toBe("NOREPLY");
  });

  it("X-Spam-Flag: YES in the inbox is treated like the spam folder", () => {
    expect(run(parsedMail({ headers: { "x-spam-flag": "YES" } })).reason).toBe("SPAM_FOLDER");
    expect(run(parsedMail({ headers: { "x-spam-flag": "NO" } })).reason).toBeNull();
  });

  it("EMPTY: nothing new — but a subject-only message or an attachment is content", () => {
    expect(run(parsedMail({ subject: "ΑΠ: Θέμα", textPlain: "" })).reason).toBe("EMPTY");
    expect(run(parsedMail({ subject: "", textPlain: null })).reason).toBe("EMPTY");
    expect(run(parsedMail({ subject: "Στείλε μου τον τιμοκατάλογο", textPlain: "" })).reason).toBeNull();
    const withPdf = parsedMail({ subject: "ΑΠ: Θέμα", textPlain: "", attachments: [{ filename: "a.pdf", contentType: "application/pdf", size: 1, inline: false }] });
    expect(run(withPdf).reason).toBeNull();
    const inlineOnly = parsedMail({ subject: "ΑΠ: Θέμα", textPlain: "", attachments: [{ filename: "image001.png", contentType: "image/png", size: 1, inline: true }] });
    expect(run(inlineOnly).reason).toBe("EMPTY");
  });

  it("derives emptiness from the parsed body when segments are not given", () => {
    const m = parsedMail({ subject: "ΑΠ: Θέμα", textPlain: null, textHtml: "<p>Γεια</p>" });
    expect(prefilter({ parsed: m, direction: "INBOUND", folderRole: null, flags: [], platformMailDomain: "mailme.local", isKnownPlatformMessage: false, denyList: [], isKnownContact: false }).reason).toBeNull();
  });
});

describe("prefilter — PHISHING (impersonation + lure)", () => {
  const own = { ownDomains: ["contoso.example"] };
  const sa = (tests: string, tail = " autolearn=no autolearn_force=no version=3.4.6") => ({ "x-spam-status": `No, score=3.9 required=5.0 tests=${tests}${tail}` });
  // A typical sample: an own-domain display name on a foreign address, scored just under the server's spam threshold.
  const expiry = parsedMail({
    from: { address: "billing@lure-sender.example", name: "contoso.example" },
    subject: "Password Expiration Notice",
    textPlain: "Your email password for shop@contoso.example is scheduled to expire today. Keep My Same Password",
  });

  it("an own-domain display name on a foreign address, with a lure, is PHISHING / SPAM", () => {
    expect(run(expiry, own)).toEqual({ reason: "PHISHING", classification: "SPAM" });
    expect(run({ ...expiry, from: { address: "x@sender.example", name: "contoso.example Support" }, subject: "(owner) Your Password is Set to Expire.", textPlain: "" }, own).reason).toBe("PHISHING");
    expect(run(expiry, { ...own, direction: "OUTBOUND" }).reason).toBeNull();
  });

  it("needs both signals: a contact form named after the shop, or a customer asking about a password, still reach the AI", () => {
    const form = parsedMail({
      from: { address: "wordpress@webhost.example", name: "contoso.example" },
      subject: "Νέο μήνυμα από τη φόρμα επικοινωνίας",
      textPlain: "Όνομα: Γιώργος. Μήνυμα: Θα ήθελα προσφορά για 20 ηχεία. Αποδέχομαι την επεξεργασία των προσωπικών μου στοιχείων.",
    });
    expect(run(form, own).reason).toBeNull();
    const customer = parsedMail({ subject: "Κωδικός πρόσβασης B2B", textPlain: "Ο κωδικός πρόσβασης στο B2B έληξε, μπορείτε να μου στείλετε νέο;" });
    expect(run(customer, own).reason).toBeNull();
    // An order confirmation is not «verify your details».
    expect(run({ ...form, subject: "Επιβεβαίωση παραγγελίας", textPlain: "Επιβεβαίωση των στοιχείων της παραγγελίας #1234." }, own).reason).toBeNull();
  });

  it("SpamAssassin's phishing tests count as the second signal; its display-name test does not", () => {
    const bare = { ...expiry, subject: "Notice", textPlain: "Click below." };
    expect(run({ ...bare, headers: sa("BAYES_00,DKIM_VALID,KAM_MAILBOX2,SPF_PASS") }, own).reason).toBe("PHISHING");
    expect(run({ ...bare, headers: sa("BAYES_00,PDS_FROM_NAME_TO_DOMAIN,SPF_PASS") }, own).reason).toBeNull();
  });

  it("a forged own address needs SpamAssassin's complete verdict: no SPF pass, no aligned DKIM", () => {
    const forged = parsedMail({
      from: { address: "shop@contoso.example", name: null },
      subject: "Activity Sent From Your Own Account",
      textPlain: "Unusual activity has been detected from your account.",
      headers: sa("BAYES_00,KAM_DMARC_NONE,RDNS_NONE,SPF_NEUTRAL,TO_EQ_FM_DIRECT_MX"),
    });
    expect(run(forged, { ...own, claimsOwnerSender: true }).reason).toBe("PHISHING");
    // The owner's real self-forwards pass SPF and carry the domain's DKIM signature.
    expect(run({ ...forged, headers: sa("BAYES_00,DKIM_SIGNED,DKIM_VALID,DKIM_VALID_AU,SPF_PASS") }, { ...own, claimsOwnerSender: true }).reason).toBeNull();
    // No verdict, or one cut short by the header cap (no «version=» tail), proves nothing.
    expect(run({ ...forged, headers: {} }, { ...own, claimsOwnerSender: true }).reason).toBeNull();
    expect(run({ ...forged, headers: sa("BAYES_00,KAM_DMARC_NONE,RDNS_NONE,SPF_NEUTRAL", "") }, { ...own, claimsOwnerSender: true }).reason).toBeNull();
  });

  it("brands in the display name: look-alike letters, other domains, a «bank» on free mail", () => {
    const bank = parsedMail({
      from: { address: "info@zohomail.example", name: "ᴏᴘᴛɪᴍᴀʙᴀɴᴋ" },
      subject: "Απαιτείται ενέργεια για τον λογαριασμό σας",
      textPlain: "Αγαπητέ πελάτη, η πρόσβαση σε ορισμένες ηλεκτρονικές υπηρεσίες έχει περιοριστεί προσωρινά.",
    });
    expect(run(bank).reason).toBe("PHISHING");
    expect(run({ ...bank, from: { address: "x@agent.example", name: "Е u r о b а n k" } }).reason).toBe("PHISHING");
    expect(run({ ...bank, from: { address: "x@gmail.com", name: "Viva.com – Τμήμα Ασφαλείας" } }).reason).toBe("PHISHING");
    expect(run({ ...bank, from: { address: "x@gmail.com", name: "Τράπεζα Κρήτης" } }).reason).toBe("PHISHING");
    expect(run({ ...bank, from: { address: "x@govgre.example", name: "Gov.gr" }, subject: "Ολοκληρώστε την ενεργοποίηση του λογαριασμού σας #10293847", textPlain: "" }).reason).toBe("PHISHING");
    // The bank's own domain, a person with the brand's TLD twin, and a name that is the address itself are not impersonation.
    expect(run({ ...bank, from: { address: "info@optimabank.example", name: "Optima bank" } }).reason).toBeNull();
    expect(run({ ...bank, from: { address: "info@partner-shop.example", name: "info@partner-shop.example" } }).reason).toBeNull();
    expect(run({ ...bank, from: { address: "news@jobboard.example", name: "jobboard.test" }, subject: "Νέες θέσεις εργασίας", textPlain: "Δείτε τις νέες αγγελίες." }).reason).toBeNull();
  });

  it("reads lures written as HTML entities, even in the plain-text part", () => {
    const encoded = [..."Ο λογαριασμός σας θα απενεργοποιηθεί"].map((c) => `&#${c.codePointAt(0)};`).join("");
    expect(run({ ...expiry, subject: "Ειδοποίηση", textPlain: encoded }, own).reason).toBe("PHISHING");
  });

  it("reads the HTML when the plain part is blank", () => {
    const htmlOnly = { ...expiry, subject: "Notice", textPlain: " ", textHtml: "<p>Your mailbox will be <b>deactivated</b> today.</p>" };
    expect(run(htmlOnly, own).reason).toBe("PHISHING");
  });

  it("X-Spam-Flag still wins as SPAM_FOLDER; PHISHING has no known-contact rescue", () => {
    const flagged = { ...expiry, headers: { "x-spam-flag": "YES" } };
    expect(run(flagged, own).reason).toBe("SPAM_FOLDER");
    expect(run(flagged, { ...own, isKnownContact: true }).reason).toBe("PHISHING");
  });

  it("phishingSignals reports what fired", () => {
    expect(phishingSignals({ from: expiry.from, subject: expiry.subject, text: expiry.textPlain!, headers: {}, ownDomains: ["contoso.example"], claimsOwnerSender: false })).toEqual({
      displayNameSpoof: true,
      forgedSender: false,
      lure: true,
      spamAssassinPhish: false,
    });
  });
});

describe("prefilter — the user's own rules (users.mail_rules)", () => {
  const rules: MailRule[] = [
    { id: "orders-cc", kind: "ignore", enabled: true, text: "Παραγγελίες με το orders@: αγνόησε", topics: ["παραγγελ", "order"], recipients: ["orders@contoso.example"] },
    { id: "webinars", kind: "ignore", enabled: true, text: "Webinar: ignore", topics: ["webinar", "σεμινάρι"] },
  ];
  const order = parsedMail({ subject: "Συνημμένη παραγγελία", textPlain: "Καλημέρα, σας στέλνουμε την παραγγελία.", cc: [{ address: "orders@contoso.example", name: null }] });

  it("an ignore rule filters as RULE and names itself, in both directions", () => {
    expect(run(order, { rules })).toEqual({ reason: "RULE", classification: null, rule: "orders-cc" });
    expect(run(order, { rules, direction: "OUTBOUND" }).rule).toBe("orders-cc");
    expect(run(parsedMail({ subject: "Webinar | Μισθολογική Διαφάνεια", textPlain: "Δηλώστε συμμετοχή." }), { rules }).rule).toBe("webinars");
  });

  it("needs the recipient when the rule names one; an address in the text is not a topic", () => {
    expect(run({ ...order, cc: [] }, { rules }).reason).toBeNull();
    const signature = parsedMail({ subject: "Τιμή και διαθεσιμότητα", textPlain: "Ευχαριστώ. Για παραγγελίες: orders@contoso.example", cc: [{ address: "orders@contoso.example", name: null }] });
    // «παραγγελίες» ("orders") in the text is a topic word; the address itself is not.
    expect(run(signature, { rules }).rule).toBe("orders-cc");
    expect(run({ ...signature, textPlain: "Ευχαριστώ. orders@contoso.example" }, { rules }).reason).toBeNull();
  });

  it("quoted history does not count: only the subject and new/forwarded text", () => {
    const reply = parsedMail({ subject: "ΑΠ: Τιμή", textPlain: "Ευχαριστώ.\n\n-----Original Message-----\nFrom: x\nΗ παραγγελία μας είναι έτοιμη.", cc: [{ address: "orders@contoso.example", name: null }] });
    expect(run(reply, { rules }).reason).toBeNull();
  });

  it("a switched-off spam rule lets spam and phishing through; without rules nothing changes", () => {
    const spam = parsedMail({ headers: { "x-spam-flag": "YES" } });
    expect(run(spam).reason).toBe("SPAM_FOLDER");
    expect(run(spam, { rules: [{ id: "spam", kind: "spam", enabled: false, text: "s" }] }).reason).toBeNull();
    expect(run(spam, { rules: [{ id: "spam", kind: "spam", enabled: true, text: "s" }] }).reason).toBe("SPAM_FOLDER");
  });
});

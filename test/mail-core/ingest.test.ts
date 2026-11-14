import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "../../src/db/schema.js";
import type { FolderRole, IngestInput } from "../../src/domain/types.js";
import { nullLogger } from "../../src/lib/log.js";
import { computeSortTs, contentHashKey, ingestMessage, isTooOld, type IngestDeps } from "../../src/mail/ingest.js";
import { parseMime } from "../../src/mail/parse.js";
import { createTestDb, insertFolder, seedOrgUserMailbox, type TestDb } from "../helpers/db.js";
import { fixture, parsedMail, parseFixture } from "./helpers.js";

let t: TestDb;
let ctx: Awaited<ReturnType<typeof seedOrgUserMailbox>>;
let folders: Record<"inbox" | "sent" | "junk" | "drafts" | "archive", { id: string }>;
let deps: IngestDeps;
let uid = 0;

/** "Now" for the tests: shortly after the fixtures' dates and after mailbox.liveSince (2026-09-01). */
const NOW = new Date("2026-09-11T12:00:00Z");

beforeEach(async () => {
  t = await createTestDb();
  ctx = await seedOrgUserMailbox(t.db);
  folders = {
    inbox: await insertFolder(t.db, ctx.mailbox.id, "INBOX", "inbox"),
    sent: await insertFolder(t.db, ctx.mailbox.id, "Sent", "sent"),
    junk: await insertFolder(t.db, ctx.mailbox.id, "Junk", "junk"),
    drafts: await insertFolder(t.db, ctx.mailbox.id, "Drafts", "drafts"),
    archive: await insertFolder(t.db, ctx.mailbox.id, "Archive", "archive"),
  };
  deps = { db: t.db, clock: { now: () => NOW }, log: nullLogger, platformMailDomain: "mailme.local", lateDiscoveryMaxDays: 7 };
});
afterEach(() => t.close());

interface Opts {
  folder?: keyof typeof folders | null;
  uid?: number;
  internalDate?: Date | null;
  flags?: string[];
  seenAt?: Date;
  declaredOutbound?: boolean;
  via?: IngestInput["via"];
}

function ingest(name: string, o: Opts = {}) {
  const folder = o.folder === undefined ? "inbox" : o.folder;
  return ingestMessage(deps, {
    mailboxId: ctx.mailbox.id,
    source: { kind: "mime", raw: fixture(name) },
    location: folder
      ? { folderId: folders[folder].id, folderRole: folder as FolderRole, uid: o.uid ?? ++uid, internalDate: o.internalDate === undefined ? null : o.internalDate, flags: o.flags ?? [] }
      : null,
    seenAt: o.seenAt ?? NOW,
    via: o.via ?? (folder ? "imap" : "eml_import"),
    declaredOutbound: o.declaredOutbound,
  });
}

const row = async (id: string) => (await t.db.select().from(s.messages).where(eq(s.messages.id, id)))[0]!;
const count = async () => (await t.db.select().from(s.messages)).length;
const locations = async (id: string) => t.db.select().from(s.messageLocations).where(eq(s.messageLocations.messageId, id));

describe("ingestMessage — storing a new message", () => {
  it("stores an inbound Greek Outlook reply with segments, metadata and its location", async () => {
    const r = await ingest("el-outlook-reply.eml", { internalDate: new Date("2026-09-09T07:02:15Z"), uid: 41 });
    expect(r).toMatchObject({ created: true, state: "pending", filterReason: null, direction: "INBOUND" });
    expect(r.threadId).toBeTruthy();
    const m = await row(r.messageId);
    expect(m).toMatchObject({
      mailboxId: ctx.mailbox.id,
      messageKey: "AM9P193MB1234ALFA0001@am9p193mb1234.eurprd09.prod.outlook.example",
      messageIdHeader: "AM9P193MB1234ALFA0001@am9p193mb1234.eurprd09.prod.outlook.example",
      fromAddress: "g.georgiou@alfa-ilektroniki.example",
      fromName: "Γιάννης Γεωργίου",
      subject: "ΑΠ: Προσφορά ηχείων για το συνεδριακό κέντρο",
      subjectNorm: "προσφορα ηχειων για το συνεδριακο κεντρο",
      inReplyTo: "owner-offer-1@contoso.example",
      references: ["owner-offer-1@contoso.example"],
      sortTs: new Date("2026-09-09T07:02:15Z"),
      internalDate: new Date("2026-09-09T07:02:15Z"),
      firstSeenAt: NOW,
      backfill: false,
      late: false,
      claimsOwnerSender: false,
      hasDeliveryTrace: true,
      via: "imap",
      threadId: r.threadId,
    });
    expect(m.segments.map((x) => x.kind)).toEqual(["NEW", "QUOTED"]);
    expect(m.headers["thread-index"]).toBeTruthy();
    expect(m.textPlain).toContain("τεχνικά φυλλάδια");
    const locs = await locations(r.messageId);
    expect(locs).toHaveLength(1);
    expect(locs[0]).toMatchObject({ folderId: folders.inbox.id, uid: 41 });
  });

  it("uses clock.now() when seenAt is not given", async () => {
    const r = await ingestMessage(deps, { mailboxId: ctx.mailbox.id, source: { kind: "mime", raw: fixture("gmail-reply-en.eml") }, location: null, via: "ingest_api" });
    expect((await row(r.messageId)).firstSeenAt).toEqual(NOW);
  });

  it("accepts an already parsed message", async () => {
    const parsed = await parseFixture("gmail-reply-el.eml");
    const r = await ingestMessage(deps, { mailboxId: ctx.mailbox.id, source: { kind: "parsed", parsed }, location: null, seenAt: NOW, via: "ingest_api" });
    expect(r).toMatchObject({ created: true, state: "pending", direction: "INBOUND" });
    expect((await row(r.messageId)).sizeBytes).toBe(parsed.sizeBytes);
  });

  it("redacts segment text before storing (raw parts are kept for the retention window)", async () => {
    const r = await ingest("sensitive-data.eml");
    const m = await row(r.messageId);
    const newText = m.segments[0]!.text;
    expect(newText).toContain("[IBAN]");
    expect(newText).toContain("[CARD]");
    expect(newText).toContain("κωδικός: [SECRET]");
    expect(newText).toContain("verification code is [SECRET]");
    expect(newText).not.toMatch(/GR16|4111 1111|Xy7#kP9q|482913/);
    expect(newText).toContain("ΚΝ-2291");
  });

  it("stores calendar and bounce structures", async () => {
    const inv = await row((await ingest("calendar-invite.eml")).messageId);
    expect(inv.state).toBe("pending");
    expect(inv.calendar).toMatchObject({ method: "REQUEST", start: "2026-09-15T07:00:00Z" });
    const b = await ingest("bounce-postfix.eml", { internalDate: new Date("2026-09-08T12:45:10Z"), seenAt: new Date("2026-09-08T12:46:00Z") });
    expect(b).toMatchObject({ state: "filtered", filterReason: "BOUNCE" });
    const bm = await row(b.messageId);
    expect(bm.bounce).toMatchObject({ action: "failed", originalMessageId: "owner-offer-1@contoso.example" });
    expect(bm.classification).toBe("AUTOMATED");
    expect(bm.segments.length).toBeGreaterThan(0);
  });

  it("rejects unknown mailboxes and folders of another mailbox", async () => {
    await expect(ingestMessage(deps, { mailboxId: "00000000-0000-4000-8000-000000000000", source: { kind: "mime", raw: fixture("gmail-reply-en.eml") }, location: null, via: "eml_import" })).rejects.toThrow(/unknown mailbox/);
    const other = await seedOrgUserMailbox(t.db, { address: "other@contoso.example" });
    const foreign = await insertFolder(t.db, other.mailbox.id, "INBOX", "inbox");
    await expect(
      ingestMessage(deps, {
        mailboxId: ctx.mailbox.id,
        source: { kind: "mime", raw: fixture("gmail-reply-en.eml") },
        location: { folderId: foreign.id, folderRole: "inbox", uid: 1, internalDate: null, flags: [] },
        via: "imap",
      }),
    ).rejects.toThrow(/folder/);
    expect(await count()).toBe(0);
  });
});

describe("ingestMessage — dedup & locations", () => {
  it("re-ingesting the same copy is a no-op", async () => {
    const a = await ingest("el-outlook-reply.eml", { uid: 7 });
    const b = await ingest("el-outlook-reply.eml", { uid: 7 });
    expect(b).toEqual({ ...a, created: false });
    expect(await count()).toBe(1);
    expect(await locations(a.messageId)).toHaveLength(1);
  });

  it("a copy in another folder adds a location, not a message", async () => {
    const a = await ingest("el-outlook-reply.eml", { folder: "inbox", uid: 7 });
    const b = await ingest("el-outlook-reply.eml", { folder: "archive", uid: 900 });
    expect(b.messageId).toBe(a.messageId);
    expect(b.created).toBe(false);
    expect((await locations(a.messageId)).map((l) => l.uid).sort()).toEqual([7, 900]);
  });

  it("dedups messages without Message-ID by a content hash", async () => {
    const a = await ingest("no-message-id.eml", { uid: 1 });
    const m = await row(a.messageId);
    expect(m.messageKey).toMatch(/^h:[0-9a-f]{64}$/);
    expect(m.messageIdHeader).toBeNull();
    const b = await ingest("no-message-id.eml", { uid: 2 });
    expect(b).toMatchObject({ messageId: a.messageId, created: false });
    expect(m.messageKey).toBe(contentHashKey(await parseFixture("no-message-id.eml")));
  });

  it("keeps two different messages that reuse one Message-ID", async () => {
    const one = await ingest("gmail-reply-en.eml");
    const forged = fixture("gmail-reply-en.eml").toString("latin1").replace("From: \"Eleni Dimitriou\" <eleni@delta-events.example>", "From: other@elsewhere.example");
    const two = await ingestMessage(deps, { mailboxId: ctx.mailbox.id, source: { kind: "mime", raw: Buffer.from(forged, "latin1") }, location: null, seenAt: NOW, via: "eml_import" });
    expect(two.created).toBe(true);
    expect(two.messageId).not.toBe(one.messageId);
    expect((await row(two.messageId)).messageKey).toMatch(/^h:/);
  });
});

describe("ingestMessage — direction & sort_ts", () => {
  it("owner's Sent copy is OUTBOUND; sort_ts is the Date header clamped to [internalDate−24h, internalDate]", async () => {
    const r = await ingest("outbound-offer.eml", { folder: "sent", internalDate: new Date("2026-09-08T12:45:30Z") });
    expect(r.direction).toBe("OUTBOUND");
    const m = await row(r.messageId);
    expect(m.sortTs).toEqual(new Date("2026-09-08T12:45:02Z"));
    expect(m.attachments.map((a) => a.filename)).toEqual(["image001.png", "Prosfora_Alfa_v2.pdf"]);
  });

  it("clamps late APPENDs and skewed client clocks", () => {
    const date = new Date("2026-09-08T12:45:00Z");
    expect(computeSortTs("OUTBOUND", date, new Date("2026-09-10T12:00:00Z"), NOW)).toEqual(new Date("2026-09-09T12:00:00Z"));
    expect(computeSortTs("OUTBOUND", date, new Date("2026-09-08T12:00:00Z"), NOW)).toEqual(new Date("2026-09-08T12:00:00Z"));
    expect(computeSortTs("OUTBOUND", null, new Date("2026-09-08T12:00:00Z"), NOW)).toEqual(new Date("2026-09-08T12:00:00Z"));
    expect(computeSortTs("OUTBOUND", date, null, NOW)).toEqual(date);
    expect(computeSortTs("INBOUND", date, new Date("2026-09-09T00:00:00Z"), NOW)).toEqual(new Date("2026-09-09T00:00:00Z"));
    expect(computeSortTs("INBOUND", date, null, NOW)).toEqual(date);
    expect(computeSortTs("INBOUND", new Date("2027-01-01T00:00:00Z"), null, NOW)).toEqual(NOW);
    expect(computeSortTs("INBOUND", null, null, NOW)).toEqual(NOW);
  });

  it("a forged From: owner delivered to INBOX stays INBOUND with claims_owner_sender", async () => {
    const r = await ingest("spoofed-owner.eml");
    expect(r.direction).toBe("INBOUND");
    expect((await row(r.messageId)).claimsOwnerSender).toBe(true);
  });

  it("self-sent: the INBOX copy is INBOUND until the Sent copy arrives, then flips to OUTBOUND", async () => {
    const a = await ingest("self-sent-inbox.eml", { folder: "inbox", internalDate: new Date("2026-09-10T15:00:05Z") });
    expect(a.direction).toBe("INBOUND");
    expect((await row(a.messageId)).claimsOwnerSender).toBe(true);
    const b = await ingest("self-sent-sent.eml", { folder: "sent", internalDate: new Date("2026-09-10T15:00:02Z") });
    expect(b).toMatchObject({ messageId: a.messageId, created: false, direction: "OUTBOUND", state: "pending" });
    const m = await row(a.messageId);
    expect(m).toMatchObject({ direction: "OUTBOUND", claimsOwnerSender: false, sortTs: new Date("2026-09-10T15:00:00Z") });
    expect(await count()).toBe(1);
  });

  it("self-sent in the other order stays OUTBOUND", async () => {
    const a = await ingest("self-sent-sent.eml", { folder: "sent" });
    const b = await ingest("self-sent-inbox.eml", { folder: "inbox" });
    expect(a.direction).toBe("OUTBOUND");
    expect(b.direction).toBe("OUTBOUND");
  });

  it("never flips direction after extraction", async () => {
    const a = await ingest("self-sent-inbox.eml", { folder: "inbox" });
    await t.db.update(s.messages).set({ state: "applied" }).where(eq(s.messages.id, a.messageId));
    const b = await ingest("self-sent-sent.eml", { folder: "sent" });
    expect(b).toMatchObject({ direction: "INBOUND", state: "applied" });
    expect(await locations(a.messageId)).toHaveLength(2);
  });

  it("declared outbound uploads (Outlook agent) are OUTBOUND when From is the owner", async () => {
    const r = await ingest("spoofed-owner.eml", { folder: null, declaredOutbound: true, via: "outlook_agent" });
    expect(r.direction).toBe("OUTBOUND");
    const other = await ingest("gmail-reply-en.eml", { folder: null, declaredOutbound: true, via: "outlook_agent" });
    expect(other.direction).toBe("INBOUND");
  });
});

describe("ingestMessage — horizon & backfill", () => {
  it("before mailbox.backfillFrom → skipped_old (TOO_OLD), never pending", async () => {
    const r = await ingest("gmail-reply-en.eml", { internalDate: new Date("2026-07-15T10:00:00Z"), seenAt: new Date("2026-08-20T10:00:00Z") });
    expect(r).toMatchObject({ state: "skipped_old", filterReason: "TOO_OLD" });
    expect((await row(r.messageId)).backfill).toBe(true);
  });

  it("during backfill (seen before liveSince) older mail within the horizon is pending + backfill", async () => {
    const r = await ingest("subject-link-1.eml", { internalDate: new Date("2026-08-31T07:00:05Z"), seenAt: new Date("2026-08-31T09:00:00Z") });
    expect(r.state).toBe("pending");
    expect((await row(r.messageId)).backfill).toBe(true);
  });

  it("after go-live, mail older than lateDiscoveryMaxDays when first seen → skipped_old", async () => {
    const old = await ingest("gmail-reply-en.eml", { internalDate: new Date("2026-09-10T08:20:05Z"), seenAt: new Date("2026-09-20T12:00:00Z") });
    expect(old).toMatchObject({ state: "skipped_old", filterReason: "TOO_OLD" });
    expect((await row(old.messageId)).backfill).toBe(false);
    const recent = await ingest("gmail-reply-el.eml", { internalDate: new Date("2026-09-09T15:40:00Z"), seenAt: new Date("2026-09-12T12:00:00Z") });
    expect(recent.state).toBe("pending");
  });

  it("without liveSince everything is backfill", async () => {
    await t.db.update(s.mailboxes).set({ liveSince: null }).where(eq(s.mailboxes.id, ctx.mailbox.id));
    const r = await ingest("gmail-reply-en.eml", { seenAt: new Date("2026-12-01T00:00:00Z") });
    expect(r.state).toBe("pending");
    expect((await row(r.messageId)).backfill).toBe(true);
  });

  it("isTooOld rules", () => {
    const from = new Date("2026-08-01T00:00:00Z");
    expect(isTooOld(new Date("2026-07-31T23:59:59Z"), NOW, true, from, 7)).toBe(true);
    expect(isTooOld(new Date("2026-08-02T00:00:00Z"), NOW, true, from, 7)).toBe(false);
    expect(isTooOld(new Date("2026-09-03T00:00:00Z"), NOW, false, from, 7)).toBe(true);
    expect(isTooOld(new Date("2026-09-05T00:00:00Z"), NOW, false, from, 7)).toBe(false);
    expect(isTooOld(new Date("2020-01-01T00:00:00Z"), NOW, true, null, 7)).toBe(false);
  });
});

describe("ingestMessage — pre-filter & minimization", () => {
  it.each([
    ["newsletter.eml", "BULK", true],
    ["ooo-auto-submitted.eml", "OUT_OF_OFFICE", true],
    ["calendar-reply.eml", "CALENDAR_REPLY", true],
    ["noreply-notification.eml", "NOREPLY", true],
    ["smime-encrypted.eml", "ENCRYPTED", true],
    ["empty-reply.eml", "EMPTY", true],
  ] as const)("%s → filtered %s (body kept for the audit sample: %s)", async (name, reason, keepsBody) => {
    const r = await ingest(name, { seenAt: new Date("2026-09-11T00:00:00Z") });
    expect(r).toMatchObject({ state: "filtered", filterReason: reason });
    const m = await row(r.messageId);
    expect(m.bodyPurgedAt === null).toBe(keepsBody);
  });

  it("deny-listed senders are filtered without storing bodies or segments", async () => {
    deps.denyList = ["@delta-events.example"];
    const r = await ingest("gmail-reply-en.eml");
    expect(r).toMatchObject({ state: "filtered", filterReason: "DENYLIST" });
    const m = await row(r.messageId);
    expect(m).toMatchObject({ textPlain: null, textHtml: null, segments: [], classification: "PERSONAL" });
    expect(m.bodyPurgedAt).toEqual(NOW);
  });

  it("the owner's muted senders (“Ignore”) are filtered before the AI, body kept", async () => {
    await t.db.update(s.users).set({ mutedSenders: ["@delta-events.example"] }).where(eq(s.users.id, ctx.user.id));
    const r = await ingest("gmail-reply-en.eml");
    expect(r).toMatchObject({ state: "filtered", filterReason: "MUTED" });
    expect((await row(r.messageId)).bodyPurgedAt).toBeNull();
  });

  it("spam folder: unknown sender filtered (no body); a known contact is rescued", async () => {
    const spam = await ingest("el-outlook-reply.eml", { folder: "junk" });
    expect(spam).toMatchObject({ state: "filtered", filterReason: "SPAM_FOLDER" });
    expect((await row(spam.messageId)).textPlain).toBeNull();

    await ingest("outbound-promise.eml", { folder: "sent" }); // owner wrote to m.konstantinou@vita-texniki.example
    const rescued = await ingest("el-plain-header-block.eml", { folder: "junk" });
    expect(rescued.state).toBe("pending");
  });

  it("PHISHING: a forged owner address, or an org-domain one on a free-mail mailbox, with a lure (own domains and claimsOwnerSender reach the prefilter)", async () => {
    const lure = {
      subject: "Activity Sent From Your Own Account",
      textPlain: "Unusual activity has been detected from your account.",
      headers: { "x-spam-status": "No, score=3.8 required=5.0 tests=BAYES_00,KAM_DMARC_NONE,SPF_NEUTRAL,TO_EQ_FM_DIRECT_MX autolearn=no autolearn_force=no version=3.4.6" },
    };
    const deliver = (messageIdHeader: string, address: string) =>
      ingestMessage(deps, {
        mailboxId: ctx.mailbox.id,
        source: { kind: "parsed", parsed: parsedMail({ ...lure, messageIdHeader, from: { address, name: null } }) },
        location: { folderId: folders.inbox.id, folderRole: "inbox", uid: ++uid, internalDate: null, flags: [] },
        seenAt: NOW,
        via: "imap",
      });

    const asOwner = await deliver("forged-1@x.example", "owner@contoso.example");
    expect(asOwner).toMatchObject({ state: "filtered", filterReason: "PHISHING", direction: "INBOUND" });
    expect((await row(asOwner.messageId)).classification).toBe("SPAM");

    // Only organizations.internal_domains makes admin@contoso.example «own» once the mailbox itself is on gmail.com.
    await t.db.update(s.mailboxes).set({ address: "contoso.owner@gmail.com" }).where(eq(s.mailboxes.id, ctx.mailbox.id));
    expect(await deliver("forged-2@x.example", "admin@contoso.example")).toMatchObject({ state: "filtered", filterReason: "PHISHING" });
  });

  it("the user's ignore rules (users.mail_rules) filter as RULE and store the rule id; an unusable rule is skipped", async () => {
    await t.db
      .update(s.users)
      .set({
        mailRules: [
          { id: "webinars", kind: "ignore", enabled: true, text: "Webinar: ignore", topics: ["webinar"] },
          { id: "broken", kind: "ignore", enabled: true, text: "no topics, no recipients" } as never,
        ],
      })
      .where(eq(s.users.id, ctx.user.id));
    const r = await ingestMessage(deps, {
      mailboxId: ctx.mailbox.id,
      source: { kind: "parsed", parsed: parsedMail({ messageIdHeader: "web-1@x.example", subject: "FREE WEBINAR: Cloud WMS", textPlain: "Δηλώστε συμμετοχή." }) },
      location: { folderId: folders.inbox.id, folderRole: "inbox", uid: ++uid, internalDate: null, flags: [] },
      seenAt: NOW,
      via: "imap",
    });
    expect(r).toMatchObject({ state: "filtered", filterReason: "RULE" });
    expect((await row(r.messageId)).filterRule).toBe("webinars");
  });

  it("drafts are filtered without a body; the real sent copy later replaces the decision", async () => {
    const d = await ingest("draft.eml", { folder: "drafts", flags: ["\\Draft"] });
    expect(d).toMatchObject({ state: "filtered", filterReason: "DRAFT_OR_DELETED", direction: "OUTBOUND" });
    expect((await row(d.messageId)).segments).toEqual([]);
    const sent = await ingest("draft.eml", { folder: "sent" });
    expect(sent).toMatchObject({ messageId: d.messageId, state: "pending", filterReason: null });
    const m = await row(d.messageId);
    expect(m.segments[0]!.text).toBe("Θα σας στείλω τα φυλλάδια αύριο το πρωί.");
    expect(m.bodyPurgedAt).toBeNull();
  });

  it("the platform's own digest is own_mail: no thread, no body", async () => {
    // The digest row (written before the report is sent) is what makes it own mail; headers alone can be forged.
    await t.db.insert(s.digests).values({ userId: ctx.user.id, localDate: "2026-09-10", messageIdHeader: "<digest.user-1.2026-09-10@mailme.local>", status: "delivered", deliveredVia: "append" });
    const r = await ingest("platform-digest.eml");
    expect(r).toMatchObject({ state: "own_mail", filterReason: "OWN_MAIL", threadId: null });
    const m = await row(r.messageId);
    expect(m).toMatchObject({ textPlain: null, textHtml: null, segments: [], threadId: null });
    expect(await t.db.select().from(s.threads)).toHaveLength(0);
    const again = await ingest("platform-digest.eml", { folder: "archive" });
    expect(again).toMatchObject({ messageId: r.messageId, created: false, state: "own_mail" });
  });

  it("recognizes digests recorded in the digests table (Message-ID or APPEND uid), even without the header", async () => {
    const raw = fixture("platform-digest.eml").toString("latin1").replace(/X-MailMe-Kind: digest\r\n/, "");
    await t.db.insert(s.digests).values({ userId: ctx.user.id, localDate: "2026-09-10", messageIdHeader: "<digest.user-1.2026-09-10@mailme.local>", status: "delivered", deliveredVia: "append", appendUid: 555 });
    const r = await ingestMessage(deps, { mailboxId: ctx.mailbox.id, source: { kind: "mime", raw: Buffer.from(raw, "latin1") }, location: null, seenAt: NOW, via: "imap" });
    expect(r.state).toBe("own_mail");

    const raw2 = raw.replace("digest.user-1.2026-09-10@mailme.local", "digest.user-1.2026-09-11@mailme.local");
    const byUid = await ingestMessage(deps, {
      mailboxId: ctx.mailbox.id,
      source: { kind: "mime", raw: Buffer.from(raw2, "latin1") },
      location: { folderId: folders.inbox.id, folderRole: "inbox", uid: 555, internalDate: null, flags: [] },
      seenAt: NOW,
      via: "imap",
    });
    expect(byUid.state).toBe("own_mail");
  });

  it("a forged X-MailMe-Kind header from another domain is not own mail", async () => {
    const raw = fixture("platform-digest.eml").toString("latin1").replace("digest.user-1.2026-09-10@mailme.local", "x@evil.example");
    const r = await ingestMessage(deps, { mailboxId: ctx.mailbox.id, source: { kind: "mime", raw: Buffer.from(raw, "latin1") }, location: null, seenAt: NOW, via: "imap" });
    expect(r.state).not.toBe("own_mail");
  });
});

describe("ingestMessage — threads & late flag", () => {
  it("a reply joins the thread of the owner's offer (HIGH), in either arrival order", async () => {
    const offer = await ingest("outbound-offer.eml", { folder: "sent" });
    const reply = await ingest("el-outlook-reply.eml");
    const ooo = await ingest("ooo-auto-submitted.eml", { seenAt: new Date("2026-09-08T13:00:00Z") });
    expect(reply.threadId).toBe(offer.threadId);
    expect(ooo.threadId).toBe(offer.threadId);

    const t2 = await createTestDb();
    try {
      const c2 = await seedOrgUserMailbox(t2.db);
      const d2 = { ...deps, db: t2.db };
      const r1 = await ingestMessage(d2, { mailboxId: c2.mailbox.id, source: { kind: "mime", raw: fixture("el-outlook-reply.eml") }, location: null, seenAt: NOW, via: "eml_import" });
      const r2 = await ingestMessage(d2, { mailboxId: c2.mailbox.id, source: { kind: "mime", raw: fixture("outbound-offer.eml") }, location: null, seenAt: NOW, via: "eml_import" });
      expect(r2.threadId).toBe(r1.threadId);
    } finally {
      await t2.close();
    }
  });

  it("Thread-Index root links messages without References (MEDIUM)", async () => {
    const a = await ingest("thread-index-1.eml");
    const b = await ingest("thread-index-2.eml");
    expect(b.threadId).toBe(a.threadId);
    const [th] = await t.db.select().from(s.threads).where(eq(s.threads.id, a.threadId!));
    expect(th!.linkConfidence).toBe("MEDIUM");
  });

  it("same specific subject + same contact links LOW; generic subjects never link", async () => {
    const a = await ingest("subject-link-1.eml", { seenAt: new Date("2026-08-31T09:00:00Z") });
    const b = await ingest("subject-link-2.eml");
    expect(b.threadId).toBe(a.threadId);
    const [th] = await t.db.select().from(s.threads).where(eq(s.threads.id, a.threadId!));
    expect(th!.linkConfidence).toBe("LOW");

    const g1 = await ingest("generic-subject-1.eml");
    const g2 = await ingest("generic-subject-2.eml");
    expect(g2.threadId).not.toBe(g1.threadId);
  });

  it("flags a message older than the thread's last applied message as late", async () => {
    const reply = await ingest("el-outlook-reply.eml", { internalDate: new Date("2026-09-09T07:02:15Z") });
    await t.db.update(s.messages).set({ state: "applied" }).where(eq(s.messages.id, reply.messageId));
    const offer = await ingest("outbound-offer.eml", { folder: "sent", internalDate: new Date("2026-09-08T12:45:30Z") });
    expect(offer.threadId).toBe(reply.threadId);
    expect((await row(offer.messageId)).late).toBe(true);
    expect((await row(reply.messageId)).late).toBe(false);
  });
});

describe("parse → ingest round trip on every fixture", () => {
  it("ingests the whole corpus twice without duplicates or errors", async () => {
    const { readdirSync } = await import("node:fs");
    const { FIXTURES } = await import("./helpers.js");
    const files = readdirSync(FIXTURES).filter((f) => f.endsWith(".eml")).sort();
    const first = [];
    for (const f of files) first.push(await ingest(f, { folder: null, seenAt: new Date("2026-09-11T00:00:00Z") }));
    const total = await count();
    for (const f of files) {
      const again = await ingest(f, { folder: null, seenAt: new Date("2026-09-11T00:00:00Z") });
      expect(again.created).toBe(false);
    }
    expect(await count()).toBe(total);
    // The two self-sent copies share one Message-ID → one row fewer than files.
    expect(total).toBe(files.length - 1);
    const parsedIds = new Set((await Promise.all(files.map((f) => parseMime(fixture(f))))).map((p) => p.messageIdHeader ?? p.subject));
    expect(parsedIds.size).toBe(total);
    expect(first.every((r) => r.messageId)).toBe(true);
  });
});

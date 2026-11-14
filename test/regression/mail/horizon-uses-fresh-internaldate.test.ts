import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "../../../src/db/schema.js";
import type { FolderRole } from "../../../src/domain/types.js";
import { nullLogger } from "../../../src/lib/log.js";
import { computeSortTs, horizonTs, ingestMessage, isTooOld, type IngestDeps } from "../../../src/mail/ingest.js";
import { createTestDb, insertFolder, seedOrgUserMailbox, type TestDb } from "../../helpers/db.js";
import { parsedMail } from "../../mail-core/helpers.js";

// Also covers horizon-bypassed-by-fresh-internaldate (same bug: the horizon was judged on sort_ts, which is
// INTERNALDATE for inbound mail and clamped to INTERNALDATE − 24 h for outbound mail).

let t: TestDb;
let ctx: Awaited<ReturnType<typeof seedOrgUserMailbox>>;
let other: { id: string };
let sent: { id: string };
let archive: { id: string };
let deps: IngestDeps;
/** After go-live (liveSince 2026-09-01), backfillFrom 2026-08-01. */
const NOW = new Date("2026-09-24T08:00:00Z");
const BACKFILL_FROM = new Date("2026-08-01T00:00:00Z");

beforeEach(async () => {
  t = await createTestDb();
  ctx = await seedOrgUserMailbox(t.db);
  other = await insertFolder(t.db, ctx.mailbox.id, "INBOX.Πελάτες", "other");
  sent = await insertFolder(t.db, ctx.mailbox.id, "INBOX.Sent", "sent");
  archive = await insertFolder(t.db, ctx.mailbox.id, "Archive", "archive");
  deps = { db: t.db, clock: { now: () => NOW }, log: nullLogger, platformMailDomain: "mailme.local", lateDiscoveryMaxDays: 7 };
});
afterEach(() => t.close());

function eml(id: string, from: string, date: string): Buffer {
  return Buffer.from(
    [
      `From: ${from}`,
      "To: owner@contoso.example",
      "Subject: Παραγγελία Ιουνίου",
      `Date: ${new Date(date).toUTCString()}`,
      `Message-ID: <${id}>`,
      "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="utf-8"',
      "Content-Transfer-Encoding: 8bit",
      "",
      "Καλημέρα, στείλτε μου την προσφορά μέχρι την Παρασκευή.",
      "",
    ].join("\r\n"),
    "utf8",
  );
}

let uid = 100;
function ingestParsed(folder: { id: string }, role: FolderRole, internalDate: Date, over: Parameters<typeof parsedMail>[0]) {
  return ingestMessage(deps, {
    mailboxId: ctx.mailbox.id,
    source: { kind: "parsed", parsed: parsedMail({ dateHeader: new Date("2026-07-25T08:00:00Z"), ...over }) },
    location: { folderId: folder.id, folderRole: role, uid: ++uid, internalDate, flags: ["\\Seen"] },
    seenAt: NOW,
    via: "imap",
  });
}

describe("horizon-uses-fresh-internaldate", () => {
  it("pure: an INBOUND mail dated 2026-06-01 with INTERNALDATE = now must count as too old", () => {
    const date = new Date("2026-06-01T09:00:00Z");
    const sortTs = computeSortTs("INBOUND", date, NOW, NOW);
    // sort_ts itself is unchanged (processing order); the horizon is judged on min(Date, INTERNALDATE).
    expect(sortTs).toEqual(NOW);
    expect(isTooOld(horizonTs(date, NOW, sortTs), NOW, false, BACKFILL_FROM, 7)).toBe(true);
    // The late-discovery rule after go-live applies to it as well.
    const tenDaysAgo = new Date(NOW.getTime() - 10 * 86_400_000);
    expect(isTooOld(horizonTs(tenDaysAgo, NOW, NOW), NOW, false, BACKFILL_FROM, 7)).toBe(true);
    // A fresh message is never too old; without Date/INTERNALDATE the sort time is used.
    expect(isTooOld(horizonTs(new Date(NOW.getTime() - 3_600_000), NOW, NOW), NOW, false, BACKFILL_FROM, 7)).toBe(false);
    expect(horizonTs(null, null, NOW)).toEqual(NOW);
  });

  it("an old mail APPENDed (restored) into a synced folder today is stored skipped_old, not pending", async () => {
    const r = await ingestMessage(deps, {
      mailboxId: ctx.mailbox.id,
      source: { kind: "mime", raw: eml("restored-1@abc-gr.example", "Πελάτης <client@abc-gr.example>", "2026-06-01T09:00:00Z") },
      location: { folderId: other.id, folderRole: "other", uid: 1, internalDate: NOW, flags: ["\\Seen"] },
      seenAt: NOW,
      via: "imap",
    });
    expect(r).toMatchObject({ state: "skipped_old", filterReason: "TOO_OLD" });
    // sort_ts rules are unchanged: INBOUND = INTERNALDATE.
    const [m] = await t.db.select().from(s.messages).where(eq(s.messages.id, r.messageId));
    expect(m!.sortTs).toEqual(NOW);
  });

  it("same for an OUTBOUND restored copy (sortTs clamped to INTERNALDATE − 24 h)", async () => {
    const r = await ingestMessage(deps, {
      mailboxId: ctx.mailbox.id,
      source: { kind: "mime", raw: eml("restored-2@contoso.example", "Owner <owner@contoso.example>", "2026-06-01T09:00:00Z") },
      location: { folderId: sent.id, folderRole: "sent", uid: 2, internalDate: NOW, flags: ["\\Seen"] },
      seenAt: NOW,
      via: "imap",
    });
    expect(r.direction).toBe("OUTBOUND");
    expect(r.state).toBe("skipped_old");
  });

  // ── from horizon-bypassed-by-fresh-internaldate ──────────────────────────────
  it("control: an old inbound mail whose INTERNALDATE is also old is skipped_old", async () => {
    const r = await ingestParsed(archive, "archive", new Date("2026-07-25T08:00:05Z"), { messageIdHeader: "old-a@client.example" });
    expect(r).toMatchObject({ state: "skipped_old", filterReason: "TOO_OLD" });
  });

  it("an inbound mail dated 2026-07-25 APPENDed today (Outlook PST drag → fresh INTERNALDATE) never reaches the AI", async () => {
    const r = await ingestParsed(archive, "archive", NOW, { messageIdHeader: "old-b@client.example" });
    expect(r.state).toBe("skipped_old");
  });

  it("an owner's Sent mail dated 2026-07-25 copied into Sent today never reaches the AI", async () => {
    const r = await ingestParsed(sent, "sent", NOW, {
      messageIdHeader: "old-c@contoso.example",
      from: { address: "owner@contoso.example", name: "Owner" },
      to: [{ address: "client@alfa-ilektroniki.example", name: null }],
      hasDeliveryTrace: false,
    });
    expect(r.direction).toBe("OUTBOUND");
    expect(r.state).toBe("skipped_old");
  });

  it("a fresh mail with a fresh INTERNALDATE is still pending", async () => {
    const r = await ingestParsed(other, "other", NOW, { messageIdHeader: "fresh@client.example", dateHeader: new Date(NOW.getTime() - 60_000) });
    expect(r.state).toBe("pending");
  });

  it("a duplicate copy that flips direction re-judges the horizon on the Date header too", async () => {
    // Self-Cc: the INBOX copy of an old owner mail (old INTERNALDATE too) is skipped_old; the Sent copy dragged in
    // today (fresh INTERNALDATE) flips it to OUTBOUND but it stays skipped_old.
    const inbox = await insertFolder(t.db, ctx.mailbox.id, "INBOX", "inbox");
    const owner = { address: "owner@contoso.example", name: "Owner" };
    const first = await ingestParsed(inbox, "inbox", new Date("2026-07-25T08:00:05Z"), { messageIdHeader: "self-old@contoso.example", from: owner });
    expect(first.state).toBe("skipped_old");
    const again = await ingestParsed(sent, "sent", NOW, { messageIdHeader: "self-old@contoso.example", from: owner, hasDeliveryTrace: false });
    expect(again).toMatchObject({ messageId: first.messageId, direction: "OUTBOUND", state: "skipped_old" });
  });
});

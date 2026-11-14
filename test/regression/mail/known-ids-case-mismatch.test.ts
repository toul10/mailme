import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nullLogger } from "../../../src/lib/log.js";
import { normalizeMessageId } from "../../../src/lib/text.js";
import { findKnownMessageIds } from "../../../src/mail/imap/store.js";
import { ingestMessage, type IngestDeps } from "../../../src/mail/ingest.js";
import { createTestDb, insertFolder, insertMessage, seedOrgUserMailbox, type TestDb } from "../../helpers/db.js";

// Also covers known-msgid-case-mismatch (same bug: findKnownMessageIds never tried the normalizeMessageId form).

let t: TestDb;
let ctx: Awaited<ReturnType<typeof seedOrgUserMailbox>>;
let inbox: { id: string };
let deps: IngestDeps;
const NOW = new Date("2026-09-24T08:00:00Z");
const EXO_ID = "<AM6PR02MB4567ABC@AM6PR02MB4567.eurprd02.prod.outlook.com>";

beforeEach(async () => {
  t = await createTestDb();
  ctx = await seedOrgUserMailbox(t.db);
  inbox = await insertFolder(t.db, ctx.mailbox.id, "INBOX", "inbox");
  deps = { db: t.db, clock: { now: () => NOW }, log: nullLogger, platformMailDomain: "mailme.local", lateDiscoveryMaxDays: 7 };
});
afterEach(() => t.close());

function eml(messageId: string): Buffer {
  return Buffer.from(
    [
      "From: Client <client@abc-gr.example>",
      "To: owner@contoso.example",
      "Subject: Test",
      `Date: ${NOW.toUTCString()}`,
      `Message-ID: ${messageId}`,
      "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="utf-8"',
      "",
      "Καλημέρα.",
      "",
    ].join("\r\n"),
    "utf8",
  );
}

describe("known-ids-case-mismatch", () => {
  it("an Exchange Online Message-ID stored by ingest is recognised on UIDVALIDITY resync", async () => {
    await ingestMessage(deps, {
      mailboxId: ctx.mailbox.id,
      source: { kind: "mime", raw: eml(EXO_ID) },
      location: { folderId: inbox.id, folderRole: "inbox", uid: 1, internalDate: NOW, flags: [] },
      seenAt: NOW,
      via: "imap",
    });
    const known = await findKnownMessageIds(t.db, ctx.mailbox.id, [EXO_ID]);
    expect(known.size).toBe(1);
  });

  // ── from known-msgid-case-mismatch ───────────────────────────────────────────
  it("control: an all-lower-case id stored by ingest is found", async () => {
    await insertMessage(t.db, { mailboxId: ctx.mailbox.id, messageIdHeader: normalizeMessageId("<abc123@mail.gmail.com>")! });
    expect([...(await findKnownMessageIds(t.db, ctx.mailbox.id, ["<abc123@mail.gmail.com>"]))]).toEqual(["abc123@mail.gmail.com"]);
  });

  it("an Exchange-style id (upper-case local part and domain) stored by ingest is found on resync", async () => {
    const raw = "<AM9P193MB1234ALFA0001@AM9P193MB1234.EURPRD09.PROD.OUTLOOK.COM>";
    // ingest stores normalizeMessageId(): local part as written, domain lower-cased.
    await insertMessage(t.db, { mailboxId: ctx.mailbox.id, messageIdHeader: normalizeMessageId(raw)! });
    const known = await findKnownMessageIds(t.db, ctx.mailbox.id, [raw]);
    expect(known.has("am9p193mb1234alfa0001@am9p193mb1234.eurprd09.prod.outlook.com")).toBe(true);
  });

  it("a message only ever seen as a \\Deleted / \\Draft copy is not 'known': its clean copy must be fetched in full", async () => {
    const r = await ingestMessage(deps, {
      mailboxId: ctx.mailbox.id,
      source: { kind: "mime", raw: eml("<deleted-only@abc-gr.example>") },
      location: { folderId: inbox.id, folderRole: "inbox", uid: 2, internalDate: NOW, flags: ["\\Deleted"] },
      seenAt: NOW,
      via: "imap",
    });
    expect(r).toMatchObject({ state: "filtered", filterReason: "DRAFT_OR_DELETED" });
    expect((await findKnownMessageIds(t.db, ctx.mailbox.id, ["<deleted-only@abc-gr.example>"])).size).toBe(0);
  });
});

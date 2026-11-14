import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "../../../src/db/schema.js";
import { nullLogger } from "../../../src/lib/log.js";
import { ingestMessage, type IngestDeps } from "../../../src/mail/ingest.js";
import { createTestDb, insertFolder, seedOrgUserMailbox, type TestDb } from "../../helpers/db.js";

const NOW = new Date("2026-09-24T09:00:00Z");
let t: TestDb;
let ctx: Awaited<ReturnType<typeof seedOrgUserMailbox>>;
let inbox: { id: string };
let sent: { id: string };
let deps: IngestDeps;

beforeEach(async () => {
  t = await createTestDb();
  ctx = await seedOrgUserMailbox(t.db);
  inbox = await insertFolder(t.db, ctx.mailbox.id, "INBOX", "inbox");
  sent = await insertFolder(t.db, ctx.mailbox.id, "Sent", "sent");
  deps = { db: t.db, clock: { now: () => NOW }, log: nullLogger, platformMailDomain: "mailme.local", lateDiscoveryMaxDays: 7 };
});
afterEach(() => t.close());

const HDR = {
  From: "owner@contoso.example",
  To: "cust@abc-gr.example",
  Cc: "owner@contoso.example",
  Subject: "Παραγγελία 55",
  Date: "Thu, 24 Sep 2026 08:30:00 +0000",
  "Message-ID": "<m3@contoso.example>",
};
const BODY = "Θα σας στείλω την παραγγελία αύριο το πρωί.";
const head = (h: Record<string, string>) => Object.entries(h).map(([k, v]) => `${k}: ${v}`).join("\r\n");
const full = (h: Record<string, string>) => Buffer.from(`${head(h)}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${BODY}\r\n`, "utf8");
/** What sync hands to ingest for a \Deleted / \Draft copy (planFor → "headers"). */
const headersOnly = (h: Record<string, string>) => Buffer.from(`${head(h)}\r\n\r\n`, "utf8");

const ingestInbox = () =>
  ingestMessage(deps, {
    mailboxId: ctx.mailbox.id,
    source: { kind: "mime", raw: full({ "Delivered-To": "owner@contoso.example", "Return-Path": "<owner@contoso.example>", ...HDR }) },
    location: { folderId: inbox.id, folderRole: "inbox", uid: 5, internalDate: new Date("2026-09-24T08:30:05Z"), flags: [] },
    seenAt: new Date("2026-09-24T08:30:06Z"),
    via: "imap",
  });
const ingestSent = (raw: Buffer, flags: string[]) =>
  ingestMessage(deps, {
    mailboxId: ctx.mailbox.id,
    source: { kind: "mime", raw },
    location: { folderId: sent.id, folderRole: "sent", uid: 9, internalDate: new Date("2026-09-24T08:30:01Z"), flags },
    seenAt: new Date("2026-09-24T08:34:00Z"),
    via: "imap",
  });
const row = async (id: string) => (await t.db.select().from(s.messages).where(eq(s.messages.id, id)))[0]!;

describe("deleted-or-headers-copy-wipes-body", () => {
  it("control: self-Cc INBOX copy is INBOUND/claimsOwnerSender with body; a clean Sent copy flips it and keeps the body", async () => {
    const a = await ingestInbox();
    const before = await row(a.messageId);
    expect(before).toMatchObject({ state: "pending", direction: "INBOUND", claimsOwnerSender: true });
    expect(before.segments.length).toBe(1);
    await ingestSent(full(HDR), ["\\Seen"]);
    const after = await row(a.messageId);
    expect(after).toMatchObject({ state: "pending", direction: "OUTBOUND" });
    expect(after.segments.length).toBe(1);
  });

  it("a \\Deleted Sent copy (headers-only fetch) must not filter the message nor erase the clean INBOX copy's body", async () => {
    const a = await ingestInbox();
    await ingestSent(headersOnly(HDR), ["\\Seen", "\\Deleted"]);
    const after = await row(a.messageId);
    expect(after.direction).toBe("OUTBOUND");
    expect(after.textPlain).toContain("Θα σας στείλω");
    expect(after.segments.length).toBe(1);
    expect(after.state).toBe("pending");
  });

  it("a headers-only (UIDVALIDITY resync of a known id) clean Sent copy must not erase the stored body", async () => {
    const a = await ingestInbox();
    await ingestSent(headersOnly(HDR), ["\\Seen"]);
    const after = await row(a.messageId);
    expect(after).toMatchObject({ state: "pending", direction: "OUTBOUND" });
    expect(after.segments.length).toBe(1);
    expect(after.textPlain).toContain("Θα σας στείλω");
  });

  it("a full-source \\Deleted Sent copy flips the direction but never filters the message", async () => {
    const a = await ingestInbox();
    await ingestSent(full(HDR), ["\\Seen", "\\Deleted"]);
    const after = await row(a.messageId);
    expect(after).toMatchObject({ state: "pending", direction: "OUTBOUND", filterReason: null, bodyPurgedAt: null });
    expect(after.segments.length).toBe(1);
  });

  it("a message first seen as a \\Deleted copy is still undrafted by a later clean copy with a body", async () => {
    const d = await ingestSent(headersOnly(HDR), ["\\Seen", "\\Deleted"]);
    expect(d).toMatchObject({ state: "filtered", filterReason: "DRAFT_OR_DELETED" });
    const a = await ingestInbox();
    expect(a).toMatchObject({ messageId: d.messageId, state: "pending", filterReason: null });
    const after = await row(d.messageId);
    expect(after.textPlain).toContain("Θα σας στείλω");
    expect(after.segments.length).toBe(1);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as s from "../../src/db/schema.js";
import { nullLogger } from "../../src/lib/log.js";
import { createTestDb, insertFolder, seedOrgUserMailbox, type TestDb } from "../helpers/db.js";
import { fixture } from "./helpers.js";

// Thread resolution fails after the message row and its location were written.
vi.mock("../../src/mail/thread.js", async (orig) => ({
  ...(await orig<typeof import("../../src/mail/thread.js")>()),
  resolveThread: vi.fn(async () => {
    throw new Error("boom");
  }),
}));

const { ingestMessage } = await import("../../src/mail/ingest.js");

let t: TestDb;
beforeEach(async () => {
  t = await createTestDb();
});
afterEach(() => t.close());

describe("ingestMessage — one transaction", () => {
  it("rolls back the message and its location when a later step fails", async () => {
    const { mailbox } = await seedOrgUserMailbox(t.db);
    const inbox = await insertFolder(t.db, mailbox.id, "INBOX", "inbox");
    await expect(
      ingestMessage(
        { db: t.db, clock: { now: () => new Date("2026-09-11T12:00:00Z") }, log: nullLogger, platformMailDomain: "mailme.local", lateDiscoveryMaxDays: 7 },
        {
          mailboxId: mailbox.id,
          source: { kind: "mime", raw: fixture("el-outlook-reply.eml") },
          location: { folderId: inbox.id, folderRole: "inbox", uid: 1, internalDate: null, flags: [] },
          via: "imap",
        },
      ),
    ).rejects.toThrow("boom");
    expect(await t.db.select().from(s.messages)).toHaveLength(0);
    expect(await t.db.select().from(s.messageLocations)).toHaveLength(0);
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "../../../src/db/schema.js";
import { upsertProbeFolders } from "../../../src/cli/commands/mailbox.js";
import { classifyFolder, defaultSyncEnabled, initialSyncEnabled, type ListedFolder } from "../../../src/mail/imap/folders.js";
import type { ProbeResult } from "../../../src/mail/imap/probe.js";
import { isFolderSynced, upsertFolders } from "../../../src/mail/imap/store.js";
import { createTestDb, seedOrgUserMailbox, type TestDb } from "../../helpers/db.js";
import { cliHarness } from "./cli-harness.js";

let t: TestDb;
let ctx: Awaited<ReturnType<typeof seedOrgUserMailbox>>;
beforeEach(async () => {
  t = await createTestDb();
  ctx = await seedOrgUserMailbox(t.db);
});
afterEach(() => t.close());

const listed: ListedFolder[] = [
  { path: "INBOX", name: "INBOX", delimiter: "/", flags: [], specialUse: "\\Inbox" },
  { path: "Customers", name: "Customers", delimiter: "/", flags: [], specialUse: null },
  { path: "Virtual/All", name: "All", delimiter: "/", flags: ["\\HasNoChildren"], specialUse: "\\All" },
];
const probe = (): ProbeResult => ({
  ok: true,
  errorKind: null,
  error: null,
  capabilities: ["IMAP4rev1", "SPECIAL-USE"],
  delimiter: "/",
  quota: null,
  folders: listed.map((f) => ({ ...f, ...classifyFolder(f), roleSource: classifyFolder(f).source, messages: 10 })),
});
const synced = async () =>
  (await t.db.select().from(s.mailboxFolders).where(eq(s.mailboxFolders.mailboxId, ctx.mailbox.id))).filter(isFolderSynced).map((f) => f.path).sort();

describe("virtual-all-folder-synced", () => {
  it("control: the sync-side LIST upsert never enables a virtual \\All view", async () => {
    expect(initialSyncEnabled(listed[2]!, "other")).toBe(false);
    await upsertFolders(t.db, ctx.mailbox.id, listed, new Date("2026-09-24T09:00:00Z"));
    expect(await synced()).toEqual(["Customers", "INBOX"]);
  });

  it("setup (mailbox:add / mailbox:probe) must not enable the virtual \\All view either", async () => {
    await upsertProbeFolders(t.db, ctx.mailbox.id, probe(), defaultSyncEnabled, new Date("2026-09-24T09:00:00Z"));
    // A later sync cycle's upsert does not correct sync_enabled of existing rows.
    await upsertFolders(t.db, ctx.mailbox.id, listed, new Date("2026-09-24T09:05:00Z"));
    expect(await synced()).toEqual(["Customers", "INBOX"]);
  });

  it("a re-probe turns off a virtual view enabled by an earlier setup, and mailbox:folders refuses to enable it", async () => {
    await t.db.insert(s.mailboxFolders).values({ mailboxId: ctx.mailbox.id, path: "Virtual/All", name: "All", role: "other", specialUse: "\\All", roleSource: "special_use", syncEnabled: true });
    await upsertProbeFolders(t.db, ctx.mailbox.id, probe(), defaultSyncEnabled, new Date("2026-09-24T09:00:00Z"));
    expect(await synced()).toEqual(["Customers", "INBOX"]);

    const h = await cliHarness(t, new Date("2026-09-24T09:00:00Z"));
    expect(await h.run("mailbox:folders", "--mailbox", ctx.mailbox.id, "--enable", "Virtual/All")).toBe(2);
    expect(h.err.join("\n")).toContain("server-side view");
    expect(await synced()).toEqual(["Customers", "INBOX"]);
  });
});

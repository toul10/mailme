import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../src/db/schema.js";
import { classifyFolder, type ListedFolder } from "../../../src/mail/imap/folders.js";
import type { ProbeResult } from "../../../src/mail/imap/probe.js";
import { isFolderSynced, upsertFolders } from "../../../src/mail/imap/store.js";
import type { FolderSummary, MailboxSummary, ProbeSummary } from "../../../src/server/api-types.js";
import { api, makeHarness, sessionFor, type Harness, type Session } from "../../server/helpers.js";

/**
 * Server part of virtual-all-folder-synced: the credentials endpoint (web setup) inserted probed folders with
 * defaultSyncEnabled(role), so a SPECIAL-USE `\All` / `\Flagged` view (role "other") started synced — and with it
 * the messages of private, Trash and Drafts folders. (The CLI setup path is covered by the owner of src/cli.)
 */
const listed: ListedFolder[] = [
  { path: "INBOX", name: "INBOX", delimiter: "/", flags: [], specialUse: "\\Inbox" },
  { path: "Customers", name: "Customers", delimiter: "/", flags: [], specialUse: null },
  { path: "Virtual/All", name: "All", delimiter: "/", flags: ["\\HasNoChildren", "\\All"], specialUse: "\\All" },
  { path: "Virtual/Flagged", name: "Flagged", delimiter: "/", flags: ["\\Flagged"], specialUse: "\\Flagged" },
];
const probe = (): ProbeResult => ({
  ok: true,
  errorKind: null,
  error: null,
  capabilities: ["IMAP4rev1", "SPECIAL-USE"],
  delimiter: "/",
  quota: null,
  folders: listed.map((f) => ({ ...f, role: classifyFolder(f).role, roleSource: classifyFolder(f).source, messages: 10 })),
});

describe("virtual-all-folder-synced (web setup)", () => {
  let h: Harness;
  let me: Session;
  let mailboxId: string;
  beforeEach(async () => {
    h = await makeHarness();
    me = await sessionFor(h, h.seed.user.id);
    mailboxId = ((await api(h, me, "POST", "/api/mailboxes", { address: "sales@contoso.example", imapHost: "mail.contoso.example" })).json() as MailboxSummary).id;
  });
  afterEach(async () => {
    await h.close();
  });

  const synced = async () =>
    (await h.t.db.select().from(s.mailboxFolders).where(eq(s.mailboxFolders.mailboxId, mailboxId))).filter(isFolderSynced).map((f) => f.path).sort();

  it("the credentials probe never enables a virtual \\All / \\Flagged view, and a later sync LIST keeps it off", async () => {
    h.probe.mockResolvedValueOnce(probe());
    const res = (await api(h, me, "POST", `/api/mailboxes/${mailboxId}/credentials`, { password: "pw" })).json() as ProbeSummary;
    expect(res.ok).toBe(true);
    expect(res.folders.filter((f) => f.syncEnabled).map((f) => f.path).sort()).toEqual(["Customers", "INBOX"]);
    await upsertFolders(h.t.db, mailboxId, listed, new Date("2026-09-15T07:05:00Z"));
    expect(await synced()).toEqual(["Customers", "INBOX"]);
  });

  it("a virtual view that was synced before the fix is switched off by the next probe, and cannot be switched on", async () => {
    await h.t.db.insert(s.mailboxFolders).values({ mailboxId, path: "Virtual/All", name: "All", role: "other", specialUse: "\\All", syncEnabled: true });
    h.probe.mockResolvedValueOnce(probe());
    await api(h, me, "POST", `/api/mailboxes/${mailboxId}/credentials`, { password: "pw" });
    expect(await synced()).toEqual(["Customers", "INBOX"]);

    const folders = ((await api(h, me, "GET", `/api/mailboxes/${mailboxId}/folders`)).json() as { folders: FolderSummary[] }).folders;
    const all = folders.find((f) => f.path === "Virtual/All")!;
    expect((await api(h, me, "PATCH", `/api/mailboxes/${mailboxId}/folders/${all.id}`, { syncEnabled: true })).statusCode).toBe(400);
    // A role change does not turn it into a synced folder either.
    const reRoled = await api(h, me, "PATCH", `/api/mailboxes/${mailboxId}/folders/${all.id}`, { role: "archive" });
    expect(reRoled.json()).toMatchObject({ role: "archive", syncEnabled: false });
  });
});

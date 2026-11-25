import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as s from "../../src/db/schema.js";
import { computeFreshness } from "../../src/digest/freshness.js";
import type { FolderRole } from "../../src/domain/types.js";
import { openMailboxPassword } from "../../src/lib/credentials.js";
import { classifyFolder } from "../../src/mail/imap/folders.js";
import type { ProbeResult } from "../../src/mail/imap/probe.js";
import type { FolderSummary, HealthSummary, MailboxSummary, ProbeSummary } from "../../src/server/api-types.js";
import { loadActiveMailboxes } from "../../src/worker/worker.js";
import { insertMessage } from "../helpers/db.js";
import { addUser, api, makeHarness, sessionFor, type Harness, type Session } from "./helpers.js";

vi.mock("../../src/mail/imap/folders.js", async (importOriginal) => ({
  // initialSyncEnabled / isVirtualFolder stay real (the route uses them since the virtual-folder fix).
  ...(await importOriginal<typeof import("../../src/mail/imap/folders.js")>()),
  classifyFolder: vi.fn((f: { path: string; specialUse: string | null }) => {
    const bySpecial: Record<string, FolderRole> = { "\\Sent": "sent", "\\Drafts": "drafts", "\\Trash": "trash", "\\Junk": "junk", "\\Archive": "archive" };
    if (f.specialUse && bySpecial[f.specialUse]) return { role: bySpecial[f.specialUse]!, source: "special_use" as const };
    if (f.path === "INBOX") return { role: "inbox" as const, source: "name" as const };
    return { role: "other" as const, source: "name" as const };
  }),
  defaultSyncEnabled: vi.fn((role: FolderRole) => ["inbox", "sent", "archive", "other"].includes(role)),
}));
vi.mock("../../src/digest/freshness.js", () => ({ computeFreshness: vi.fn() }));

const PW = "Imap-Pässw0rd!";

function folder(path: string, specialUse: string | null, messages: number | null = null): ProbeResult["folders"][number] {
  return { path, name: path.replace(/^INBOX\./, ""), delimiter: ".", flags: specialUse ? [specialUse] : [], specialUse, role: "ignored", roleSource: "ignored", messages };
}

const OK_PROBE: ProbeResult = {
  ok: true,
  errorKind: null,
  error: null,
  capabilities: ["IMAP4rev1", "SPECIAL-USE", "IDLE"],
  delimiter: ".",
  folders: [folder("INBOX", null, 120), folder("INBOX.Sent", "\\Sent", 80), folder("INBOX.Drafts", "\\Drafts", 3), folder("INBOX.Πελάτες", null, 40)],
  quota: { usedKb: 1000, limitKb: 2000 },
};

let h: Harness;
let me: Session;

beforeEach(async () => {
  vi.clearAllMocks();
  h = await makeHarness();
  me = await sessionFor(h, h.seed.user.id);
});

afterEach(async () => {
  await h.close();
});

async function createMailbox(sess: Session = me, body: object = {}) {
  return api(h, sess, "POST", "/api/mailboxes", { address: "Sales@Contoso.example", imapHost: "mail.contoso.example", aliases: ["Prices@contoso.example", "sales@contoso.example", "prices@contoso.example"], ...body });
}

async function allRowsJson(): Promise<string> {
  const mbs = await h.t.db.select().from(s.mailboxes);
  const others = [
    mbs.map((m) => ({ ...m, credentialsSealed: m.credentialsSealed ? "[sealed]" : null })),
    await h.t.db.select().from(s.securityAudit),
    await h.t.db.select().from(s.mailboxLoginAttempts),
    await h.t.db.select().from(s.mailboxFolders),
  ];
  return JSON.stringify(others);
}

describe("mailbox setup", () => {
  it("creates a mailbox with normalized address and aliases", async () => {
    const res = await createMailbox();
    expect(res.statusCode).toBe(200);
    const m = res.json() as MailboxSummary;
    expect(m).toMatchObject({
      address: "sales@contoso.example",
      aliases: ["prices@contoso.example"],
      provider: "imap",
      imapHost: "mail.contoso.example",
      imapPort: 993,
      imapUsername: "sales@contoso.example",
      smtpPort: 587,
      status: "setup",
      hasCredentials: false,
    });
    const [row] = await h.t.db.select().from(s.mailboxes).where(eq(s.mailboxes.id, m.id));
    expect(row!.userId).toBe(h.seed.user.id);
    expect(row!.backfillFrom!.toISOString()).toBe("2026-08-25T07:00:00.000Z");
    expect((await createMailbox()).statusCode).toBe(409);
    expect((await createMailbox(me, { address: "sales2@contoso.example", imapHost: null })).statusCode).toBe(400);
    expect((await createMailbox(me, { address: "not-an-address" })).statusCode).toBe(400);
    expect((await createMailbox(me, { address: "x@contoso.example", imapHost: "bad host!" })).statusCode).toBe(400);
    const ingestOnly = await createMailbox(me, { address: "agent@contoso.example", provider: "ingest", imapHost: null });
    expect(ingestOnly.json()).toMatchObject({ provider: "ingest", imapHost: null, imapUsername: null });
    const list = await api(h, me, "GET", "/api/mailboxes");
    expect((list.json() as { mailboxes: MailboxSummary[] }).mailboxes.map((x) => x.address)).toEqual(["owner@contoso.example", "sales@contoso.example", "agent@contoso.example"]);
  });

  it("probes once, seals the password with the public key and stores folders", async () => {
    const m = (await createMailbox()).json() as MailboxSummary;
    h.probe.mockResolvedValueOnce(OK_PROBE);
    const res = await api(h, me, "POST", `/api/mailboxes/${m.id}/credentials`, { password: PW });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(PW);
    const p = res.json() as ProbeSummary;
    expect(p).toMatchObject({ ok: true, error: null, capabilities: OK_PROBE.capabilities, quota: { usedKb: 1000, limitKb: 2000 } });
    expect(p.folders.map((f) => [f.path, f.role, f.roleSource, f.syncEnabled, f.messages])).toEqual([
      ["INBOX", "inbox", "name", true, 120],
      ["INBOX.Sent", "sent", "special_use", true, 80],
      ["INBOX.Πελάτες", "other", "name", true, 40],
      ["INBOX.Drafts", "drafts", "special_use", false, 3],
    ]);
    expect(p.folders.every((f) => f.id)).toBe(true);

    expect(h.probe).toHaveBeenCalledTimes(1);
    expect(h.probe).toHaveBeenCalledWith(
      { mailboxId: m.id, address: "sales@contoso.example", imapHost: "mail.contoso.example", imapPort: 993, imapUsername: "sales@contoso.example", smtpHost: null, smtpPort: 587 },
      PW,
    );

    const [row] = await h.t.db.select().from(s.mailboxes).where(eq(s.mailboxes.id, m.id));
    expect(row!.status).toBe("active");
    expect(row!.credentialsKid).toBe("k-test");
    expect(row!.credentialsSealed).toMatch(/^sb1\.k-test\./);
    expect(row!.credentialsSealed).not.toContain(PW);
    // Only the worker's private key opens it, and only for this mailbox (AAD).
    expect(openMailboxPassword(row!, h.keys)).toBe(PW);
    expect(() => openMailboxPassword({ ...row!, id: h.seed.mailbox.id }, h.keys)).toThrow();

    const attempts = await h.t.db.select().from(s.mailboxLoginAttempts);
    expect(attempts.map((a) => [a.purpose, a.outcome])).toEqual([["probe", "ok"]]);
    const events = (await h.t.db.select().from(s.securityAudit)).map((a) => a.event);
    expect(events).toContain("mailbox.credentials_set");

    const summary = (await api(h, me, "GET", "/api/mailboxes")).json() as { mailboxes: MailboxSummary[] };
    expect(summary.mailboxes.find((x) => x.id === m.id)).toMatchObject({ hasCredentials: true, status: "active" });
    expect(JSON.stringify(summary)).not.toContain("sb1.");
    expect(await allRowsJson()).not.toContain(PW);
    expect(JSON.stringify(h.logs)).not.toContain(PW);
  });

  it("stores nothing about the password when the probe fails", async () => {
    const m = (await createMailbox()).json() as MailboxSummary;
    h.probe.mockResolvedValueOnce({ ok: false, errorKind: "auth", error: `AUTHENTICATIONFAILED (${PW})`, capabilities: [], delimiter: null, folders: [], quota: null });
    const res = await api(h, me, "POST", `/api/mailboxes/${m.id}/credentials`, { password: PW });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: false, error: "AUTHENTICATIONFAILED (***)", errorKind: "auth", capabilities: [], folders: [], quota: null });
    const [row] = await h.t.db.select().from(s.mailboxes).where(eq(s.mailboxes.id, m.id));
    expect(row!.credentialsSealed).toBeNull();
    expect(row!.status).toBe("setup");
    expect(row!.lastError).toBe("auth");
    expect((await h.t.db.select().from(s.mailboxFolders).where(eq(s.mailboxFolders.mailboxId, m.id))).length).toBe(0);
    expect((await h.t.db.select().from(s.mailboxLoginAttempts)).map((a) => a.outcome)).toEqual(["auth_failed"]);
    expect(await allRowsJson()).not.toContain(PW);
    expect(JSON.stringify(h.logs)).not.toContain(PW);

    h.probe.mockRejectedValueOnce(new Error(`socket closed ${PW}`));
    const thrown = await api(h, me, "POST", `/api/mailboxes/${m.id}/credentials`, { password: PW });
    expect(thrown.json()).toMatchObject({ ok: false, errorKind: "other" });
    expect(thrown.body).not.toContain(PW);
    expect(JSON.stringify(h.logs)).not.toContain(PW);
  });

  it("rate-limits probes per mailbox, without calling the probe", async () => {
    const m = (await createMailbox()).json() as MailboxSummary;
    h.probe.mockResolvedValue({ ok: false, errorKind: "network", error: "timeout", capabilities: [], delimiter: null, folders: [], quota: null });
    for (let i = 0; i < 3; i++) expect((await api(h, me, "POST", `/api/mailboxes/${m.id}/credentials`, { password: PW })).statusCode).toBe(200);
    const limited = await api(h, me, "POST", `/api/mailboxes/${m.id}/credentials`, { password: PW });
    expect(limited.statusCode).toBe(429);
    expect(h.probe).toHaveBeenCalledTimes(3);
    const ingest = await createMailbox(me, { address: "agent@contoso.example", provider: "ingest", imapHost: null });
    expect((await api(h, me, "POST", `/api/mailboxes/${(ingest.json() as MailboxSummary).id}/credentials`, { password: PW })).statusCode).toBe(400);
  });

  it("folder changes: user role wins over later probes; private and drafts never sync; gone folders disappear", async () => {
    const m = (await createMailbox()).json() as MailboxSummary;
    h.probe.mockResolvedValueOnce(OK_PROBE);
    const probed = (await api(h, me, "POST", `/api/mailboxes/${m.id}/credentials`, { password: PW })).json() as ProbeSummary;
    const clients = probed.folders.find((f) => f.path === "INBOX.Πελάτες")!;
    const drafts = probed.folders.find((f) => f.path === "INBOX.Drafts")!;

    const patched = await api(h, me, "PATCH", `/api/mailboxes/${m.id}/folders/${clients.id}`, { role: "archive" });
    expect(patched.json()).toMatchObject({ role: "archive", roleSource: "user", syncEnabled: true });
    const priv = await api(h, me, "PATCH", `/api/mailboxes/${m.id}/folders/${clients.id}`, { private: true });
    expect(priv.json()).toMatchObject({ private: true, syncEnabled: false });
    expect((await api(h, me, "PATCH", `/api/mailboxes/${m.id}/folders/${clients.id}`, { syncEnabled: true })).statusCode).toBe(400);
    expect((await api(h, me, "PATCH", `/api/mailboxes/${m.id}/folders/${drafts.id}`, { syncEnabled: true })).statusCode).toBe(400);
    expect((await api(h, me, "PATCH", `/api/mailboxes/${h.seed.mailbox.id}/folders/${clients.id}`, { syncEnabled: false })).statusCode).toBe(404);

    // Re-probe: the folder list changed (Drafts gone); the user's role and choices stay.
    h.probe.mockResolvedValueOnce({ ...OK_PROBE, folders: [folder("INBOX", null, 121), folder("INBOX.Sent", "\\Sent", 81), folder("INBOX.Πελάτες", null, 41)] });
    const again = (await api(h, me, "POST", `/api/mailboxes/${m.id}/credentials`, { password: PW })).json() as ProbeSummary;
    expect(again.folders.map((f) => f.path)).toEqual(["INBOX", "INBOX.Sent", "INBOX.Πελάτες"]);
    expect(again.folders.find((f) => f.path === "INBOX.Πελάτες")).toMatchObject({ role: "archive", roleSource: "user", private: true, syncEnabled: false, messages: 41 });
    const list = (await api(h, me, "GET", `/api/mailboxes/${m.id}/folders`)).json() as { folders: FolderSummary[] };
    expect(list.folders).toHaveLength(3);
    expect(vi.mocked(classifyFolder)).toHaveBeenCalled();
  });

  it("mailbox updates: aliases, pause/resume; auth_failed needs a new password", async () => {
    const m = (await createMailbox()).json() as MailboxSummary;
    expect((await api(h, me, "PATCH", `/api/mailboxes/${m.id}`, { status: "active" })).statusCode).toBe(409);
    const upd = await api(h, me, "PATCH", `/api/mailboxes/${m.id}`, { displayName: " Πωλήσεις ", aliases: ["Info@Contoso.example"], smtpHost: "mail.contoso.example" });
    expect(upd.json()).toMatchObject({ displayName: "Πωλήσεις", aliases: ["info@contoso.example"], smtpHost: "mail.contoso.example" });
    h.probe.mockResolvedValueOnce(OK_PROBE);
    await api(h, me, "POST", `/api/mailboxes/${m.id}/credentials`, { password: PW });
    expect((await api(h, me, "PATCH", `/api/mailboxes/${m.id}`, { status: "paused" })).json()).toMatchObject({ status: "paused" });
    expect((await api(h, me, "PATCH", `/api/mailboxes/${m.id}`, { status: "active" })).json()).toMatchObject({ status: "active" });
    // A mistyped new password on a working mailbox changes nothing about it.
    h.probe.mockResolvedValueOnce({ ok: false, errorKind: "auth", error: "bad", capabilities: [], delimiter: null, folders: [], quota: null });
    await api(h, me, "POST", `/api/mailboxes/${m.id}/credentials`, { password: "typo" });
    const [still] = await h.t.db.select().from(s.mailboxes).where(eq(s.mailboxes.id, m.id));
    expect(still).toMatchObject({ status: "active", lastError: null });
    expect(openMailboxPassword(still!, h.keys)).toBe(PW);

    await h.t.db.update(s.mailboxes).set({ status: "auth_failed" }).where(eq(s.mailboxes.id, m.id));
    expect((await api(h, me, "PATCH", `/api/mailboxes/${m.id}`, { status: "active" })).statusCode).toBe(409);
    // …and not through pause → resume either.
    expect((await api(h, me, "PATCH", `/api/mailboxes/${m.id}`, { status: "paused" })).statusCode).toBe(409);
    // A successful new password reactivates it.
    h.probe.mockResolvedValueOnce(OK_PROBE);
    expect(((await api(h, me, "POST", `/api/mailboxes/${m.id}/credentials`, { password: PW })).json() as ProbeSummary).ok).toBe(true);
    expect((await api(h, me, "GET", "/api/mailboxes")).json().mailboxes.find((x: MailboxSummary) => x.id === m.id).status).toBe("active");
  });
});

describe("mailbox connection edit", () => {
  const AUTH_FAIL: ProbeResult = { ok: false, errorKind: "auth", error: "AUTHENTICATIONFAILED", capabilities: [], delimiter: null, folders: [], quota: null };
  const row = async (id: string) => (await h.t.db.select().from(s.mailboxes).where(eq(s.mailboxes.id, id)))[0]!;
  const folderCount = async (id: string) => (await h.t.db.select().from(s.mailboxFolders).where(eq(s.mailboxFolders.mailboxId, id))).length;
  const patch = (id: string, body: object, sess: Session = me) => api(h, sess, "PATCH", `/api/mailboxes/${id}`, body);
  const setPassword = (id: string) => api(h, me, "POST", `/api/mailboxes/${id}/credentials`, { password: PW });

  /** A mailbox that logged in once: stored password, folders, status active. */
  async function working(body: object = {}): Promise<MailboxSummary> {
    const m = (await createMailbox(me, body)).json() as MailboxSummary;
    h.probe.mockResolvedValueOnce(OK_PROBE);
    expect(((await setPassword(m.id)).json() as ProbeSummary).ok).toBe(true);
    return m;
  }

  it("corrects a mistyped address before the first login: the login name follows it and the old error goes", async () => {
    const m = (await createMailbox(me, { address: "acounts@contoso.example", aliases: [] })).json() as MailboxSummary;
    expect(m).toMatchObject({ imapUsername: "acounts@contoso.example", hasMail: false });
    h.probe.mockResolvedValueOnce(AUTH_FAIL);
    await setPassword(m.id);
    expect((await row(m.id)).lastError).toBe("auth");

    const res = await patch(m.id, { address: " Accounts@Contoso.example " });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ address: "accounts@contoso.example", imapUsername: "accounts@contoso.example", status: "setup", lastError: null, hasCredentials: false, hasMail: false });

    // The password is now tried as the corrected login, and sealed for the corrected address.
    h.clock.advance(61 * 60_000);
    h.probe.mockResolvedValueOnce(OK_PROBE);
    expect(((await setPassword(m.id)).json() as ProbeSummary).ok).toBe(true);
    expect(h.probe).toHaveBeenLastCalledWith(
      { mailboxId: m.id, address: "accounts@contoso.example", imapHost: "mail.contoso.example", imapPort: 993, imapUsername: "accounts@contoso.example", smtpHost: null, smtpPort: 587 },
      PW,
    );
    const after = await row(m.id);
    expect(after.status).toBe("active");
    expect(openMailboxPassword(after, h.keys)).toBe(PW);
  });

  it("keeps a login name of its own when the address changes; null sets it back to the address", async () => {
    const m = (await createMailbox(me, { imapUsername: "sales-login", aliases: ["accounts@contoso.example", "prices@contoso.example"] })).json() as MailboxSummary;
    // The new address was an alias until now: an address is not its own alias.
    expect((await patch(m.id, { address: "accounts@contoso.example" })).json()).toMatchObject({ address: "accounts@contoso.example", imapUsername: "sales-login", aliases: ["prices@contoso.example"] });
    expect((await patch(m.id, { imapUsername: null })).json()).toMatchObject({ imapUsername: "accounts@contoso.example" });
    expect((await patch(m.id, { imapUsername: " accounts-login " })).json()).toMatchObject({ imapUsername: "accounts-login" });
    expect((await patch(m.id, { address: "sales@contoso.example", aliases: ["Sales@contoso.example", "info@contoso.example"] })).json()).toMatchObject({ address: "sales@contoso.example", imapUsername: "accounts-login", aliases: ["info@contoso.example"] });
  });

  it("a new server or port is a new setup: the stored password goes, the sync stops, a stored SMTP server follows", async () => {
    const m = await working({ smtpHost: "mail.contoso.example" });
    expect((await loadActiveMailboxes(h.t.db)).map((x) => x.id)).toContain(m.id);

    const res = await patch(m.id, { imapHost: "Mail2.Contoso.example", imapPort: 143 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ imapHost: "mail2.contoso.example", imapPort: 143, smtpHost: "mail2.contoso.example", status: "setup", statusReason: null, hasCredentials: false });
    expect(await row(m.id)).toMatchObject({ credentialsSealed: null, credentialsKid: null, status: "setup", consecutiveFailures: 0, nextAttemptAt: null });
    expect((await loadActiveMailboxes(h.t.db)).map((x) => x.id)).not.toContain(m.id);
    // Nothing to resume without a password; the same account's folder list stays.
    expect((await patch(m.id, { status: "active" })).statusCode).toBe(409);
    expect(await folderCount(m.id)).toBe(4);

    const audits = (await h.t.db.select().from(s.securityAudit).where(eq(s.securityAudit.event, "mailbox.update"))).sort((a, b) => a.id - b.id);
    expect(audits.at(-1)!.detail).toMatchObject({ mailboxId: m.id, connection: ["imapHost", "imapPort"], credentialsDropped: true });
    expect(JSON.stringify(audits)).not.toContain("mail2.contoso.example");
    expect(h.logs.some((l) => l.msg === "mailbox connection settings changed")).toBe(true);
    expect(await allRowsJson()).not.toContain(PW);

    // The next password is tried against the new settings only.
    h.probe.mockResolvedValueOnce(OK_PROBE);
    await setPassword(m.id);
    expect(h.probe).toHaveBeenLastCalledWith(expect.objectContaining({ imapHost: "mail2.contoso.example", imapPort: 143, smtpHost: "mail2.contoso.example" }), PW);
    expect(await row(m.id)).toMatchObject({ status: "active" });
  });

  it("the same settings again change nothing: the password stays", async () => {
    const m = await working();
    const res = await patch(m.id, { address: "SALES@contoso.example", imapHost: "MAIL.contoso.example", imapPort: 993, imapUsername: null, displayName: "Πωλήσεις" });
    expect(res.json()).toMatchObject({ status: "active", hasCredentials: true, displayName: "Πωλήσεις" });
    expect(openMailboxPassword(await row(m.id), h.keys)).toBe(PW);
    expect(await folderCount(m.id)).toBe(4);
  });

  it("the address and the login name are fixed once the mailbox holds mail; the server is not", async () => {
    const mb = h.seed.mailbox;
    expect(((await api(h, me, "GET", "/api/mailboxes")).json() as { mailboxes: MailboxSummary[] }).mailboxes[0]!.hasMail).toBe(false);
    await insertMessage(h.t.db, { mailboxId: mb.id });
    expect(((await api(h, me, "GET", "/api/mailboxes")).json() as { mailboxes: MailboxSummary[] }).mailboxes[0]!.hasMail).toBe(true);

    const refused = await patch(mb.id, { address: "other@contoso.example" });
    expect(refused.statusCode).toBe(409);
    expect((refused.json() as { error: string }).error).toContain("already holds mail");
    expect((await patch(mb.id, { imapUsername: "other-login" })).statusCode).toBe(409);
    expect((await patch(mb.id, { address: "other@contoso.example", imapHost: "mail2.contoso.example" })).statusCode).toBe(409);
    expect(await row(mb.id)).toMatchObject({ address: "owner@contoso.example", imapUsername: "owner@contoso.example", imapHost: "mail.contoso.example", status: "active" });

    expect((await patch(mb.id, { imapHost: "mail2.contoso.example" })).json()).toMatchObject({ imapHost: "mail2.contoso.example", address: "owner@contoso.example", status: "setup", hasMail: true });
  });

  it("a corrected account forgets the folder list of the account it had logged in to", async () => {
    const m = await working();
    expect(await folderCount(m.id)).toBe(4);
    expect((await patch(m.id, { address: "accounts@contoso.example" })).json()).toMatchObject({ address: "accounts@contoso.example", imapUsername: "accounts@contoso.example", status: "setup", hasCredentials: false });
    expect(await folderCount(m.id)).toBe(0);
    expect((await row(m.id)).probe).toBeNull();
    expect(((await api(h, me, "GET", `/api/mailboxes/${m.id}/folders`)).json() as { folders: FolderSummary[] }).folders).toEqual([]);
  });

  it("refuses what would not be the user's own mailbox on a public mail server", async () => {
    const m = (await createMailbox()).json() as MailboxSummary;
    expect((await patch(m.id, { address: "Owner@contoso.example" })).statusCode).toBe(409); // the user's other mailbox
    expect((await patch(m.id, { address: "not-an-address" })).statusCode).toBe(400);
    for (const imapHost of ["127.0.0.1", "localhost", "db.internal", "bad host!", ""]) expect((await patch(m.id, { imapHost })).statusCode).toBe(400);
    for (const imapPort of [0, 70000, 99.5]) expect((await patch(m.id, { imapPort })).statusCode).toBe(400);
    expect((await patch(m.id, { imapUsername: "  " })).statusCode).toBe(400);
    // Pausing or resuming is its own request.
    expect((await patch(m.id, { imapPort: 143, status: "paused" })).statusCode).toBe(400);
    expect(await row(m.id)).toMatchObject({ address: "sales@contoso.example", imapHost: "mail.contoso.example", imapPort: 993, imapUsername: "sales@contoso.example" });

    // A mailbox fed through the ingest API has an address and nothing to log in to.
    const ingest = (await createMailbox(me, { address: "agent@contoso.example", provider: "ingest", imapHost: null })).json() as MailboxSummary;
    for (const body of [{ imapHost: "mail.contoso.example" }, { imapPort: 993 }, { imapUsername: "agent" }]) expect((await patch(ingest.id, body)).statusCode).toBe(400);
    await h.t.db.update(s.mailboxes).set({ status: "active" }).where(eq(s.mailboxes.id, ingest.id));
    expect((await patch(ingest.id, { address: "agent2@contoso.example" })).json()).toMatchObject({ address: "agent2@contoso.example", imapUsername: null, status: "active" });

    await h.t.db.update(s.mailboxes).set({ status: "disabled" }).where(eq(s.mailboxes.id, m.id));
    expect((await patch(m.id, { imapPort: 143 })).statusCode).toBe(409);
  });

  it("only the owner edits connection settings", async () => {
    const mb = h.seed.mailbox.id;
    const admin = await sessionFor(h, (await addUser(h, { email: "admin@contoso.example", role: "admin" })).id);
    for (const body of [{ address: "x@contoso.example" }, { imapHost: "mail2.contoso.example" }, { imapPort: 143 }, { imapUsername: "x" }]) expect((await patch(mb, body, admin)).statusCode).toBe(403);
    const colleague = await sessionFor(h, (await addUser(h, { email: "colleague@contoso.example" })).id);
    expect((await patch(mb, { imapPort: 143 }, colleague)).statusCode).toBe(404);
    expect((await patch(mb, { imapPort: 143 }, null as unknown as Session)).statusCode).toBe(401);
    expect(await row(mb)).toMatchObject({ address: "owner@contoso.example", imapHost: "mail.contoso.example", imapPort: 993, status: "active" });
  });

  it("a password tried against settings that were edited meanwhile is not stored", async () => {
    const m = (await createMailbox()).json() as MailboxSummary;
    let edited = 0;
    h.probe.mockImplementationOnce(async () => {
      // While the login is on its way, the server is changed (another tab, or someone holding the session).
      edited = (await patch(m.id, { imapHost: "mail2.contoso.example" })).statusCode;
      return OK_PROBE;
    });
    const res = await setPassword(m.id);
    expect(edited).toBe(200);
    expect(res.statusCode).toBe(409);
    expect(res.body).not.toContain(PW);
    expect(await row(m.id)).toMatchObject({ imapHost: "mail2.contoso.example", credentialsSealed: null, status: "setup" });
    expect(await folderCount(m.id)).toBe(0);
    expect(await allRowsJson()).not.toContain(PW);
  });
});

describe("mailbox authorization", () => {
  it("members only reach their own mailboxes; admins reach the org's, audited", async () => {
    const colleague = await addUser(h, { email: "colleague@contoso.example" });
    const colleagueSess = await sessionFor(h, colleague.id);
    const theirs = (await createMailbox(colleagueSess, { address: "colleague@contoso.example" })).json() as MailboxSummary;

    expect((await api(h, me, "GET", "/api/mailboxes")).json().mailboxes.map((x: MailboxSummary) => x.id)).toEqual([h.seed.mailbox.id]);
    expect((await api(h, me, "PATCH", `/api/mailboxes/${theirs.id}`, { displayName: "x" })).statusCode).toBe(404);
    expect((await api(h, me, "GET", `/api/mailboxes/${theirs.id}/folders`)).statusCode).toBe(404);
    expect((await api(h, me, "POST", `/api/mailboxes/${theirs.id}/credentials`, { password: PW })).statusCode).toBe(404);
    expect((await api(h, me, "POST", `/api/mailboxes/${theirs.id}/ingest-token`)).statusCode).toBe(404);
    expect(h.probe).not.toHaveBeenCalled();

    const adminUser = await addUser(h, { email: "admin@contoso.example", role: "admin" });
    const admin = await sessionFor(h, adminUser.id);
    const all = (await api(h, admin, "GET", "/api/mailboxes")).json() as { mailboxes: MailboxSummary[] };
    expect(all.mailboxes.map((x) => x.id).sort()).toEqual([h.seed.mailbox.id, theirs.id].sort());
    expect((await api(h, admin, "PATCH", `/api/mailboxes/${theirs.id}`, { status: "paused" })).statusCode).toBe(200);
    const audits = await h.t.db.select().from(s.securityAudit).where(eq(s.securityAudit.userId, adminUser.id));
    expect(audits.map((a) => a.event)).toEqual(["admin.mailboxes_list", "mailbox.update"]);
    expect(audits[1]!.detail).toMatchObject({ mailboxId: theirs.id, admin: true, targetUserId: colleague.id });

    const [org2] = await h.t.db.insert(s.organizations).values({ name: "Other" }).returning();
    const foreignAdmin = await sessionFor(h, (await addUser(h, { email: "boss@other-gr.example", role: "admin", orgId: org2!.id })).id);
    expect((await api(h, foreignAdmin, "GET", "/api/mailboxes")).json()).toEqual({ mailboxes: [] });
    expect((await api(h, foreignAdmin, "PATCH", `/api/mailboxes/${theirs.id}`, { status: "paused" })).statusCode).toBe(404);
  });
});

describe("health", () => {
  it("returns the user's freshness summary", async () => {
    vi.mocked(computeFreshness).mockResolvedValueOnce({
      lastSyncAt: new Date("2026-09-15T06:10:00Z"),
      staleMinutes: 50,
      pendingCount: 3,
      oldestPendingMinutes: 12,
      failedCount: 1,
      paused: false,
      banner: null,
    });
    const res = await api(h, me, "GET", "/api/health");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      lastSyncAt: "2026-09-15T06:10:00.000Z",
      staleMinutes: 50,
      pendingCount: 3,
      oldestPendingMinutes: 12,
      failedCount: 1,
      paused: false,
      banner: null,
      canSyncNow: false, // no TICK_JOB in tests: the button is hidden
    } satisfies HealthSummary);
    expect(vi.mocked(computeFreshness)).toHaveBeenCalledWith(h.t.db, h.seed.user.id, h.clock.now());
    expect((await api(h, null, "GET", "/api/health")).statusCode).toBe(401);
  });
});

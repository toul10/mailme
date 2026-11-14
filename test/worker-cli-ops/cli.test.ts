import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { verify } from "@node-rs/argon2";
import { bumpAiSettings } from "../../src/ai/settings.js";
import { loadConfig } from "../../src/config.js";
import * as s from "../../src/db/schema.js";
import type { FolderRole, MailboxConnectionSettings } from "../../src/domain/types.js";
import { hashPassword, type CliContext, type CliServices } from "../../src/cli/context.js";
import type { CliIO } from "../../src/cli/io.js";
import { runCli } from "../../src/cli/run.js";
import { openMailboxPassword } from "../../src/lib/credentials.js";
import { ephemeralSealingKeys, type SealingKeys } from "../../src/lib/sealed.js";
import { nullLogger } from "../../src/lib/log.js";
import type { ProbeResult } from "../../src/mail/imap/probe.js";
import type { DrainReport } from "../../src/engine/pipeline.js";
import { createRuntime } from "../../src/worker/runtime.js";
import { createTestDb, insertMessage, insertTask, seedOrgUserMailbox, type TestDb } from "../helpers/db.js";

const NOW = new Date("2026-09-24T09:00:00Z");

interface Harness {
  ctx: CliContext;
  out: string[];
  err: string[];
  answers: string[];
  services: CliServices;
  keys: SealingKeys;
  dir: string;
  run(...argv: string[]): Promise<number>;
}

function notStubbed(name: string) {
  return vi.fn(async () => {
    throw new Error(`${name} not stubbed`);
  });
}

async function harness(t: TestDb, overrides: Partial<CliServices> = {}, env: Record<string, string> = {}): Promise<Harness> {
  const dir = mkdtempSync(path.join(tmpdir(), "mailme-cli-"));
  const out: string[] = [];
  const err: string[] = [];
  const answers: string[] = [];
  const io: CliIO = {
    out: (x) => void out.push(x),
    err: (x) => void err.push(x),
    prompt: async () => {
      const a = answers.shift();
      if (a === undefined) throw new Error("unexpected prompt");
      return a;
    },
    confirm: async () => /^y/i.test(answers.shift() ?? "n"),
    close() {},
  };
  const config = loadConfig({
    MASTER_KEY: Buffer.alloc(32, 5).toString("base64"),
    APP_SECRET: "z".repeat(40),
    DATABASE_URL: "pglite://memory",
    AI_MODE: "mock",
    CREDENTIALS_PUBLIC_KEY_FILE: path.join(dir, "keys", "credentials.pub.pem"),
    CREDENTIALS_PRIVATE_KEY_FILE: path.join(dir, "keys", "credentials.key.pem"),
    ...env,
  });
  const keys = ephemeralSealingKeys(config.CREDENTIALS_KID);
  const runtime = await createRuntime(config, { handle: t, keys: "lazy", sealingKeys: keys, log: nullLogger, clock: { now: () => NOW }, env: {} });
  const services: CliServices = {
    runMigrations: vi.fn(async () => {}),
    hashPassword,
    probeMailbox: notStubbed("probeMailbox"),
    defaultSyncEnabled: vi.fn((role: FolderRole) => role === "inbox" || role === "sent" || role === "archive" || role === "other"),
    syncMailboxOnce: notStubbed("syncMailboxOnce"),
    drainMailbox: notStubbed("drainMailbox"),
    importEmlFiles: notStubbed("importEmlFiles"),
    deliverDigestForUser: notStubbed("deliverDigestForUser"),
    runRetention: notStubbed("runRetention"),
    runHealthChecks: notStubbed("runHealthChecks"),
    exec: notStubbed("exec"),
    ...overrides,
  };
  const ctx: CliContext = {
    io,
    config: () => config,
    tryConfig: () => config,
    ops: () => ({ DATA_DIR: path.join(dir, "data"), DISK_CHECK: "on", BACKUP_DIR: path.join(dir, "backups"), BACKUP_KEEP_DAYS: 30, BACKUP_MARKER_FILE: undefined }),
    runtime: async () => runtime,
    services,
    now: () => NOW,
  };
  return { ctx, out, err, answers, services, keys, dir, run: (...argv) => runCli(argv, ctx) };
}

const probeOk: ProbeResult = {
  ok: true,
  errorKind: null,
  error: null,
  capabilities: ["IMAP4rev1", "SPECIAL-USE", "QUOTA", "IDLE"],
  delimiter: ".",
  folders: [
    { path: "INBOX", name: "INBOX", delimiter: ".", flags: [], specialUse: "\\Inbox", role: "inbox", roleSource: "special_use", messages: 1200 },
    { path: "INBOX.Sent", name: "Sent", delimiter: ".", flags: ["\\Sent"], specialUse: "\\Sent", role: "sent", roleSource: "special_use", messages: 300 },
    { path: "INBOX.Drafts", name: "Drafts", delimiter: ".", flags: ["\\Drafts"], specialUse: "\\Drafts", role: "drafts", roleSource: "special_use", messages: 3 },
    { path: "INBOX.Πελάτες", name: "Πελάτες", delimiter: ".", flags: [], specialUse: null, role: "other", roleSource: "name", messages: 40 },
  ],
  quota: { usedKb: 500_000, limitKb: 2_000_000 },
};

describe("CLI commands", () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.close();
  });

  it("dispatches, prints usage and maps usage errors to exit 2", async () => {
    const h = await harness(t);
    expect(await h.run()).toBe(2);
    expect(h.out.join("\n")).toContain("mailbox:add");
    expect(await h.run("nope")).toBe(2);
    expect(h.err[0]).toContain('Unknown command "nope"');
    expect(await h.run("org:create")).toBe(2);
    expect(h.err.at(-2)).toContain("--name is required");
    expect(await h.run("org:create", "--help")).toBe(0);
    expect(h.out.at(-1)).toContain("--domains");
  });

  it("keys:generate writes a 0600 private key and refuses to overwrite without --force", async () => {
    const h = await harness(t);
    const cfg = h.ctx.config();
    expect(await h.run("keys:generate")).toBe(0);
    expect(statSync(cfg.CREDENTIALS_PRIVATE_KEY_FILE!).mode & 0o777).toBe(0o600);
    expect(readFileSync(cfg.CREDENTIALS_PUBLIC_KEY_FILE, "utf8")).toContain("BEGIN PUBLIC KEY");
    const before = readFileSync(cfg.CREDENTIALS_PRIVATE_KEY_FILE!, "utf8");
    expect(await h.run("keys:generate")).toBe(1);
    expect(h.err[0]).toContain("Refusing to overwrite");
    expect(readFileSync(cfg.CREDENTIALS_PRIVATE_KEY_FILE!, "utf8")).toBe(before);
    expect(await h.run("keys:generate", "--force")).toBe(0);
    expect(readFileSync(cfg.CREDENTIALS_PRIVATE_KEY_FILE!, "utf8")).not.toBe(before);
    expect(await h.run("keys:generate", "--out-dir", path.join(h.dir, "k2"), "--kid", "k2")).toBe(0);
    expect(existsSync(path.join(h.dir, "k2", "credentials.key.pem"))).toBe(true);
    expect(h.out.join("\n")).toContain("CREDENTIALS_KID=k2");
  });

  it("org:create and user:create (argon2id, prompted twice, validated)", async () => {
    const h = await harness(t);
    expect(await h.run("org:create", "--name", "Contoso", "--domains", "contoso.example,@Contoso2.example")).toBe(0);
    const [org] = await t.db.select().from(s.organizations);
    expect(org!.internalDomains).toEqual(["contoso.example", "contoso2.example"]);
    expect(await h.run("org:create", "--name", "contoso")).toBe(2);

    h.answers.push("short", "short");
    expect(await h.run("user:create", "--org", "Contoso", "--email", "a@contoso.example", "--name", "A")).toBe(2);
    h.answers.length = 0;
    h.answers.push("correct horse battery", "correct horse batterY");
    expect(await h.run("user:create", "--org", "Contoso", "--email", "a@contoso.example", "--name", "A")).toBe(2);
    h.answers.length = 0;
    h.answers.push("correct horse battery", "correct horse battery");
    expect(await h.run("user:create", "--org", org!.id, "--email", "A@Contoso.example", "--name", "Άννα", "--admin", "--digest-start", "2026-10-05")).toBe(0);
    const [u] = await t.db.select().from(s.users);
    expect(u!.email).toBe("a@contoso.example");
    expect(u!.role).toBe("admin");
    expect(u!.digestStartDate).toBe("2026-10-05");
    expect(u!.passwordHash).toMatch(/^\$argon2id\$/);
    expect(await verify(u!.passwordHash!, "correct horse battery")).toBe(true);
    h.answers.push("correct horse battery", "correct horse battery");
    expect(await h.run("user:create", "--org", "Contoso", "--email", "a@contoso.example", "--name", "Dup")).toBe(2);
    const audit = await t.db.select().from(s.securityAudit).where(eq(s.securityAudit.event, "user_created"));
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0]!.detail)).not.toContain("correct horse");
  });

  it("mailbox:add probes once, seals the password, stores folders and activates; failures store nothing", async () => {
    const probe = vi.fn(async (_settings: MailboxConnectionSettings, _password: string): Promise<ProbeResult> => probeOk);
    const h = await harness(t, { probeMailbox: probe });
    const { user } = await seedOrgUserMailbox(t.db, { address: "owner@contoso.example" });
    await t.db.delete(s.mailboxes);
    await t.db.update(s.users).set({ digestMailboxId: null }).where(eq(s.users.id, user.id));

    // There is no default server: a new IMAP mailbox needs --host (a usage error before anything is stored or probed).
    expect(await h.run("mailbox:add", "--user", "owner@contoso.example", "--address", "owner@contoso.example")).toBe(2);
    expect(h.err.at(-2)).toContain("--host is required");
    expect(await t.db.select().from(s.mailboxes)).toHaveLength(0);

    h.answers.push("imap-secret");
    expect(await h.run("mailbox:add", "--user", "owner@contoso.example", "--address", "Owner@Contoso.example", "--host", "mail.contoso.example", "--aliases", "sales@contoso.example")).toBe(0);
    expect(probe).toHaveBeenCalledTimes(1);
    const settings = probe.mock.calls[0]![0];
    expect(settings).toMatchObject({ address: "owner@contoso.example", imapHost: "mail.contoso.example", imapPort: 993, imapUsername: "owner@contoso.example", smtpPort: 587 });
    const [mb] = await t.db.select().from(s.mailboxes);
    expect(mb!.status).toBe("active");
    expect(mb!.aliases).toEqual(["sales@contoso.example"]);
    expect(mb!.credentialsKid).toBe(h.keys.kid);
    expect(openMailboxPassword(mb!, h.keys)).toBe("imap-secret");
    expect(mb!.probe).toMatchObject({ at: NOW.toISOString(), quota: { usedKb: 500_000, limitKb: 2_000_000 }, folderCounts: { INBOX: 1200, "INBOX.Sent": 300 } });
    expect(mb!.backfillFrom!.getTime()).toBe(NOW.getTime() - 21 * 86_400_000);
    expect(mb!.liveSince!.getTime()).toBe(NOW.getTime() + 7 * 86_400_000);
    const folders = await t.db.select().from(s.mailboxFolders).where(eq(s.mailboxFolders.mailboxId, mb!.id));
    const byPath = Object.fromEntries(folders.map((f) => [f.path, f]));
    expect(byPath["INBOX.Sent"]).toMatchObject({ role: "sent", roleSource: "special_use", syncEnabled: true });
    expect(byPath["INBOX.Drafts"]).toMatchObject({ role: "drafts", syncEnabled: false });
    expect(byPath["INBOX.Πελάτες"]).toMatchObject({ role: "other", syncEnabled: true });
    const [u] = await t.db.select().from(s.users).where(eq(s.users.id, user.id));
    expect(u!.digestMailboxId).toBe(mb!.id);
    const attempts = await t.db.select().from(s.mailboxLoginAttempts);
    expect(attempts.map((a) => [a.purpose, a.outcome])).toEqual([["probe", "ok"]]);
    expect(h.out.join("\n")).not.toContain("imap-secret");

    // Re-entering a wrong password: probe fails, the stored credential is untouched.
    probe.mockResolvedValue({ ...probeOk, ok: false, errorKind: "auth", error: "AUTHENTICATIONFAILED", folders: [], quota: null });
    for (let i = 0; i < 2; i++) {
      h.answers.push("wrong");
      expect(await h.run("mailbox:add", "--user", "owner@contoso.example", "--address", "owner@contoso.example")).toBe(1);
    }
    const [after] = await t.db.select().from(s.mailboxes);
    expect(openMailboxPassword(after!, h.keys)).toBe("imap-secret");
    expect(after!.lastError).toBe("probe:auth");
    // Two auth failures in the hour: the CLI refuses to risk an IP ban (no prompt, no probe).
    expect(await h.run("mailbox:add", "--user", "owner@contoso.example", "--address", "owner@contoso.example")).toBe(1);
    expect(probe).toHaveBeenCalledTimes(3);
    expect(h.err.at(-1)).toContain("failed logins");
  });

  it("mailbox:add re-run keeps custom connection settings and probes the configured host", async () => {
    const probe = vi.fn(async (_settings: MailboxConnectionSettings, _password: string): Promise<ProbeResult> => probeOk);
    const h = await harness(t, { probeMailbox: probe });
    const { user } = await seedOrgUserMailbox(t.db, { address: "owner@contoso.example" });
    await t.db.delete(s.mailboxes);
    await t.db.update(s.users).set({ digestMailboxId: null }).where(eq(s.users.id, user.id));

    // A failed first probe stores no password and does not make it the report mailbox.
    probe.mockResolvedValueOnce({ ...probeOk, ok: false, errorKind: "network", error: "ECONNREFUSED", folders: [], quota: null });
    h.answers.push("pw");
    expect(await h.run("mailbox:add", "--user", user.email, "--address", "owner@contoso.example", "--host", "imap.other-gr.example", "--port", "143", "--username", "legacy")).toBe(1);
    let [mb] = await t.db.select().from(s.mailboxes);
    expect(mb).toMatchObject({ status: "setup", credentialsSealed: null, imapHost: "imap.other-gr.example", imapPort: 143, imapUsername: "legacy", smtpHost: "imap.other-gr.example", smtpPort: 587 });
    expect((await t.db.select().from(s.users))[0]!.digestMailboxId).toBeNull();
    expect(h.err.join("\n")).toContain("NOT stored");

    // Re-run without connection flags (e.g. a new password or --live-since): nothing is reset.
    h.answers.push("pw");
    expect(await h.run("mailbox:add", "--user", user.email, "--address", "owner@contoso.example", "--live-since", "now")).toBe(0);
    [mb] = await t.db.select().from(s.mailboxes);
    expect(mb).toMatchObject({ status: "active", imapHost: "imap.other-gr.example", imapPort: 143, imapUsername: "legacy", smtpHost: "imap.other-gr.example", smtpPort: 587 });
    expect(mb!.liveSince!.getTime()).toBe(NOW.getTime());
    expect(probe.mock.calls[1]![0]).toMatchObject({ imapHost: "imap.other-gr.example", imapPort: 143, imapUsername: "legacy" });
    expect((await t.db.select().from(s.users))[0]!.digestMailboxId).toBe(mb!.id);

    // Only explicitly passed settings change.
    h.answers.push("pw");
    expect(await h.run("mailbox:add", "--user", user.email, "--address", "owner@contoso.example", "--port", "993")).toBe(0);
    [mb] = await t.db.select().from(s.mailboxes);
    expect(mb).toMatchObject({ imapHost: "imap.other-gr.example", imapPort: 993, imapUsername: "legacy" });
    expect(await h.run("mailbox:add", "--user", user.email, "--address", "owner@contoso.example", "--port", "70000")).toBe(2);
  });

  it("mailbox:folders changes roles and sync, never enables drafts", async () => {
    const h = await harness(t, { probeMailbox: vi.fn(async () => probeOk) });
    await seedOrgUserMailbox(t.db, { address: "owner@contoso.example" });
    await t.db.delete(s.mailboxes);
    h.answers.push("pw");
    await h.run("mailbox:add", "--user", "owner@contoso.example", "--address", "owner@contoso.example", "--host", "mail.contoso.example");
    expect(await h.run("mailbox:folders", "--mailbox", "owner@contoso.example", "--enable", "INBOX.Drafts")).toBe(2);
    expect(await h.run("mailbox:folders", "--mailbox", "owner@contoso.example", "--role", "INBOX.Πελάτες=archive", "--disable", "INBOX", "--private", "INBOX.Sent")).toBe(0);
    const folders = Object.fromEntries((await t.db.select().from(s.mailboxFolders)).map((f) => [f.path, f]));
    expect(folders["INBOX.Πελάτες"]).toMatchObject({ role: "archive", roleSource: "user" });
    expect(folders["INBOX"]!.syncEnabled).toBe(false);
    expect(folders["INBOX.Sent"]).toMatchObject({ private: true, syncEnabled: false });
    expect(await h.run("mailbox:folders", "--mailbox", "owner@contoso.example", "--enable", "INBOX.Sent")).toBe(2);
    expect(await h.run("mailbox:folders", "--mailbox", "owner@contoso.example", "--role", "nope=sent")).toBe(2);
  });

  it("mailbox:ingest-token stores only the sha256 of a token shown once; resume and ai:resume clear pauses", async () => {
    const h = await harness(t);
    const { mailbox } = await seedOrgUserMailbox(t.db);
    expect(await h.run("mailbox:ingest-token", "--mailbox", mailbox.id)).toBe(0);
    const token = h.out[1]!.trim();
    const [mb] = await t.db.select().from(s.mailboxes);
    expect(mb!.ingestTokenHash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(await h.run("mailbox:ingest-token", "--mailbox", mailbox.id)).toBe(1); // confirmation declined

    await t.db.update(s.mailboxes).set({ status: "auth_failed", aiPaused: true, aiPausedReason: "budget:usd", consecutiveFailures: 3 }).where(eq(s.mailboxes.id, mailbox.id));
    h.answers.push("n");
    expect(await h.run("mailbox:resume", "--mailbox", mailbox.id)).toBe(1);
    h.answers.push("y");
    expect(await h.run("mailbox:resume", "--mailbox", mailbox.id)).toBe(0);
    const [resumed] = await t.db.select().from(s.mailboxes);
    expect(resumed).toMatchObject({ status: "active", aiPaused: false, aiPausedReason: null, consecutiveFailures: 0 });

    await t.db.insert(s.appState).values({ key: "ai_global_pause", value: { reason: "extractor", at: NOW.toISOString() } });
    expect(await h.run("ai:resume", "--yes")).toBe(0);
    expect(await t.db.select().from(s.appState)).toHaveLength(0);
    expect(await h.run("ai:resume")).toBe(0);
    expect(h.out.at(-1)).toContain("not globally paused");
  });

  it("drain:once refuses when the chosen provider cannot run: one drain would pause AI for every mailbox", async () => {
    const drain = vi.fn(async (): Promise<DrainReport> => ({ mailboxId: "x", processed: 0, extracted: 0, applied: 0, parked: 0, transientBackoff: false, globalPause: false, budgetPaused: false, lockBusy: false }));
    const h = await harness(t, { drainMailbox: drain }, { AI_MODE: "auto" });
    const { mailbox } = await seedOrgUserMailbox(t.db);
    await bumpAiSettings(t.db, NOW, null, { provider: "openai", model: "gpt-6.1-terra" });
    expect(await h.run("drain:once", "--mailbox", mailbox.id)).toBe(1);
    expect(drain).not.toHaveBeenCalled();
    expect(h.err.at(-1)).toBe("AI cannot run: there is no OpenAI key (add one in Admin → AI, or set OPENAI_API_KEY in the worker's environment). Nothing was analysed.");
    // The CLI follows Admin → AI but writes nothing of the worker's.
    expect((await t.db.select().from(s.aiSettings))[0]!.workerReport).toBeNull();
  });

  it("import:eml, drain:once and digest commands delegate with the right arguments", async () => {
    const importEmlFiles = vi.fn(async () => ({ imported: 2, duplicates: 1, errors: [] }));
    const drain = vi.fn(async (): Promise<DrainReport> => ({ mailboxId: "x", processed: 2, extracted: 2, applied: 2, parked: 0, transientBackoff: false, globalPause: false, budgetPaused: false, lockBusy: false }));
    const deliver = vi.fn(async (_d: unknown, _u: string, _date: string, o: { dryRun?: boolean } = {}) => ({ status: o.dryRun ? "preview" : "delivered", html: "<p>report</p>", subject: "s" }));
    const h = await harness(t, { importEmlFiles, drainMailbox: drain, deliverDigestForUser: deliver });
    const { user, mailbox } = await seedOrgUserMailbox(t.db);

    const emlDir = path.join(h.dir, "eml");
    mkdirSync(path.join(emlDir, "sub"), { recursive: true });
    for (const f of ["b.eml", "a.eml", "sub/c.EML", "notes.txt"]) writeFileSync(path.join(emlDir, f), "x");
    expect(await h.run("import:eml", "--mailbox", mailbox.address, "--outbound", emlDir)).toBe(0);
    const [, mbId, files, opts] = importEmlFiles.mock.calls[0] as unknown as [unknown, string, string[], { declaredOutbound?: boolean }];
    expect(mbId).toBe(mailbox.id);
    expect(files.map((f) => path.relative(emlDir, f))).toEqual(["a.eml", "b.eml", path.join("sub", "c.EML")]);
    expect(opts.declaredOutbound).toBe(true);

    expect(await h.run("drain:once", "--mailbox", mailbox.id, "--no-settle", "--max", "5")).toBe(0);
    const [deps, , dOpts] = drain.mock.calls[0] as unknown as [{ config: { SETTLE_SEC: number } }, string, { maxMessages: number; fullCycleAt: Date }];
    expect(deps.config.SETTLE_SEC).toBe(0);
    expect(dOpts).toEqual({ maxMessages: 5, fullCycleAt: NOW });

    const outFile = path.join(h.dir, "preview.html");
    expect(await h.run("digest:preview", "--user", user.email, "--date", "2026-09-24", "--out", outFile)).toBe(0);
    expect(readFileSync(outFile, "utf8")).toBe("<p>report</p>");
    expect(statSync(outFile).mode & 0o777).toBe(0o600);
    expect(deliver.mock.calls[0]![3]).toEqual({ dryRun: true });

    // Exactly once: an already delivered report is never sent again.
    await t.db.insert(s.digests).values({ userId: user.id, localDate: "2026-09-24", status: "delivered", deliveredAt: NOW });
    expect(await h.run("digest:send-now", "--user", user.id, "--yes")).toBe(0);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(h.out.at(-1)).toContain("already delivered");
    await t.db.delete(s.digests).where(and(eq(s.digests.userId, user.id)));
    expect(await h.run("digest:send-now", "--user", user.id, "--yes")).toBe(0);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver.mock.calls[1]![2]).toBe("2026-09-24");

    // A skipped (never delivered) day is only re-sent with --retry, which clears that row first.
    await t.db.insert(s.digests).values({ userId: user.id, localDate: "2026-09-23", status: "skipped" });
    deliver.mockImplementationOnce(async () => {
      const rows = await t.db.select().from(s.digests).where(and(eq(s.digests.userId, user.id), eq(s.digests.localDate, "2026-09-23")));
      return { status: rows.length === 0 ? "delivered" : "skipped", html: "", subject: "" };
    });
    expect(await h.run("digest:send-now", "--user", user.id, "--date", "2026-09-23", "--yes", "--retry")).toBe(0);
    expect(h.out.at(-1)).toBe("Result: delivered");
  });

  it("keys:rotate re-seals every credential; user:update and user:mfa-reset", async () => {
    const h = await harness(t);
    const { user, mailbox } = await seedOrgUserMailbox(t.db);
    const { sealMailboxPassword } = await import("../../src/lib/credentials.js");
    await t.db.update(s.mailboxes).set(sealMailboxPassword(mailbox, "pw-1", h.keys)).where(eq(s.mailboxes.id, mailbox.id));
    expect(await h.run("keys:generate", "--out-dir", path.join(h.dir, "k2"), "--kid", "k2")).toBe(0);
    const k2 = path.join(h.dir, "k2");
    expect(await h.run("keys:rotate", "--new-public", path.join(k2, "credentials.pub.pem"), "--new-private", path.join(k2, "credentials.key.pem"), "--new-kid", h.keys.kid)).toBe(2);
    expect(await h.run("keys:rotate", "--new-public", path.join(k2, "credentials.pub.pem"), "--new-private", path.join(k2, "credentials.key.pem"), "--new-kid", "k2", "--yes")).toBe(0);
    const { loadSealingKeys } = await import("../../src/lib/sealed.js");
    const newKeys = loadSealingKeys({ kid: "k2", publicKeyFile: path.join(k2, "credentials.pub.pem"), privateKeyFile: path.join(k2, "credentials.key.pem") });
    const [mb] = await t.db.select().from(s.mailboxes);
    expect(mb!.credentialsKid).toBe("k2");
    expect(openMailboxPassword(mb!, newKeys)).toBe("pw-1");
    expect(() => openMailboxPassword(mb!, h.keys)).toThrow();

    expect(await h.run("user:update", "--user", user.email, "--digest-time", "08:15", "--digest-start", "2026-10-05", "--no-digest-enabled", "--digest-mailbox", mailbox.id)).toBe(0);
    let [u] = await t.db.select().from(s.users).where(eq(s.users.id, user.id));
    expect(u).toMatchObject({ digestTime: "08:15", digestStartDate: "2026-10-05", digestEnabled: false, digestMailboxId: mailbox.id });
    expect(await h.run("user:update", "--user", user.email, "--digest-start", "none", "--digest-enabled")).toBe(0);
    [u] = await t.db.select().from(s.users).where(eq(s.users.id, user.id));
    expect(u).toMatchObject({ digestStartDate: null, digestEnabled: true });
    expect(await h.run("user:update", "--user", user.email, "--digest-time", "25:00")).toBe(2);
    expect(await h.run("user:update", "--user", user.email)).toBe(2);

    await t.db.update(s.users).set({ totpEnabled: true, totpSecretEnc: "v1.x.y.z" }).where(eq(s.users.id, user.id));
    await t.db.insert(s.sessions).values({ id: "sess", userId: user.id, csrfToken: "c", expiresAt: new Date(NOW.getTime() + 86_400_000) });
    await t.db.insert(s.trustedDevices).values({ id: "dev", userId: user.id, expiresAt: new Date(NOW.getTime() + 86_400_000) });
    expect(await h.run("user:mfa-reset", "--user", user.email, "--yes")).toBe(0);
    [u] = await t.db.select().from(s.users).where(eq(s.users.id, user.id));
    expect(u).toMatchObject({ totpEnabled: false, totpSecretEnc: null });
    expect(await t.db.select().from(s.sessions)).toHaveLength(0);
    expect(await t.db.select().from(s.trustedDevices)).toHaveLength(0);
  });

  it("mailbox:probe uses the stored password; an auth rejection marks the mailbox auth_failed", async () => {
    const probe = vi.fn(async (_settings: MailboxConnectionSettings, _password: string): Promise<ProbeResult> => probeOk);
    const h = await harness(t, { probeMailbox: probe });
    const { mailbox } = await seedOrgUserMailbox(t.db);
    const { sealMailboxPassword } = await import("../../src/lib/credentials.js");
    await t.db.update(s.mailboxes).set(sealMailboxPassword(mailbox, "stored-pw", h.keys)).where(eq(s.mailboxes.id, mailbox.id));
    expect(await h.run("mailbox:probe", "--mailbox", mailbox.address)).toBe(0);
    expect(probe.mock.calls[0]![1]).toBe("stored-pw");
    expect(await t.db.select().from(s.mailboxFolders)).toHaveLength(4);
    probe.mockResolvedValueOnce({ ...probeOk, ok: false, errorKind: "auth", error: "no", folders: [], quota: null });
    expect(await h.run("mailbox:probe", "--mailbox", mailbox.address)).toBe(1);
    const [mb] = await t.db.select().from(s.mailboxes);
    expect(mb).toMatchObject({ status: "auth_failed", statusReason: "probe" });
  });

  it("backup:dump passes credentials via the environment, writes the marker and prunes old dumps", async () => {
    const exec = vi.fn(async (_cmd: string, args: string[], _o: { env?: NodeJS.ProcessEnv }) => {
      const file = args.find((a) => a.startsWith("--file="))!.slice("--file=".length);
      writeFileSync(file, "PGDMP");
      return { code: 0, stderr: "" };
    });
    const h = await harness(t, { exec });
    const cfg = { ...h.ctx.config(), DATABASE_URL: "postgres://mailme:s3cr%40t@db.internal:5433/mailme?sslmode=require" };
    const marker = path.join(h.dir, "backups", "last.json");
    h.ctx.config = () => cfg;
    h.ctx.ops = () => ({ DATA_DIR: path.join(h.dir, "data"), DISK_CHECK: "on", BACKUP_DIR: path.join(h.dir, "backups"), BACKUP_KEEP_DAYS: 30, BACKUP_MARKER_FILE: marker });
    mkdirSync(path.join(h.dir, "backups"), { recursive: true });
    const old = path.join(h.dir, "backups", "mailme-20260101-000000.dump");
    writeFileSync(old, "old");
    const { utimesSync } = await import("node:fs");
    utimesSync(old, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
    expect(await h.run("backup:dump")).toBe(0);
    const [cmd, args, opts] = exec.mock.calls[0]!;
    expect(cmd).toBe("pg_dump");
    expect(args.join(" ")).not.toContain("s3cr");
    expect(opts.env).toMatchObject({ PGHOST: "db.internal", PGPORT: "5433", PGDATABASE: "mailme", PGUSER: "mailme", PGPASSWORD: "s3cr@t", PGSSLMODE: "require" });
    expect(JSON.parse(readFileSync(marker, "utf8"))).toMatchObject({ at: NOW.toISOString(), file: "mailme-20260924-090000.dump" });
    expect(existsSync(old)).toBe(false);
    expect(statSync(path.join(h.dir, "backups", "mailme-20260924-090000.dump")).mode & 0o777).toBe(0o600);

    exec.mockResolvedValueOnce({ code: 1, stderr: "pg_dump: error: connection refused" });
    expect(await h.run("backup:dump")).toBe(1);
    h.ctx.config = () => ({ ...cfg, DATABASE_URL: "pglite://memory" });
    expect(await h.run("backup:dump")).toBe(2);
  });

  it("health:run --dry evaluates without alerting or storing state", async () => {
    const h = await harness(t);
    const { mailbox } = await seedOrgUserMailbox(t.db);
    await t.db.update(s.mailboxes).set({ status: "auth_failed" }).where(eq(s.mailboxes.id, mailbox.id));
    expect(await h.run("health:run", "--dry")).toBe(1);
    expect(h.out.join("\n")).toContain(`ALERT mailbox_status:${mailbox.id}`);
    expect(await t.db.select().from(s.healthState)).toHaveLength(0);
  });

  it("kpi reports aggregates from SQL", async () => {
    const h = await harness(t);
    const { org, user, mailbox } = await seedOrgUserMailbox(t.db);
    const task = await insertTask(t.db, { orgId: org.id, userId: user.id, mailboxId: mailbox.id });
    await t.db.update(s.tasks).set({ createdAt: new Date("2026-09-22T08:00:00Z") }).where(eq(s.tasks.id, task.id));
    await t.db.insert(s.taskEvents).values([
      { taskId: task.id, actor: "ai", op: "CREATE", tier: "auto", applied: true, createdAt: new Date("2026-09-22T08:00:00Z") },
      { taskId: task.id, actor: "ai", op: "COMPLETE", applied: true, createdAt: new Date("2026-09-22T09:00:00Z") },
      { taskId: task.id, actor: "user", op: "USER_REOPEN", applied: true, createdAt: new Date("2026-09-22T10:00:00Z") },
      { taskId: task.id, actor: "user", op: "USER_NOT_A_TASK", applied: true, createdAt: new Date("2026-09-23T10:00:00Z") },
      { taskId: task.id, actor: "ai", op: "UPDATE", suggestionState: "rejected", createdAt: new Date("2026-09-23T11:00:00Z") },
    ]);
    const m = await insertMessage(t.db, { mailboxId: mailbox.id, sortTs: new Date("2026-09-22T07:00:00Z"), state: "filtered" });
    await t.db.update(s.messages).set({ filterReason: "BULK" }).where(eq(s.messages.id, m.id));
    await t.db.insert(s.extractions).values({ messageId: m.id, mailboxId: mailbox.id, pipelineVersion: "v", status: "ok", costUsd: 0.04, inputTokens: 3000, createdAt: new Date("2026-09-22T07:05:00Z") });
    expect(await h.run("kpi", "--from", "2026-09-21", "--to", "2026-09-24", "--json")).toBe(0);
    const r = JSON.parse(h.out.at(-1)!);
    expect(r.tasksCreated).toEqual([{ origin: "ai", tier: "auto", count: 1 }]);
    expect(r.notATask).toEqual({ aiCreated: 1, dismissedNotATask: 1, pct: 100 });
    expect(r.aiCompleted).toBe(1);
    expect(r.reopenedAfterAiClose).toBe(1);
    expect(r.suggestions).toEqual([{ state: "rejected", count: 1 }]);
    expect(r.extractionCostByDay).toEqual([{ day: "2026-09-22", calls: 1, errors: 0, costUsd: 0.04, inputTokens: 3000, outputTokens: 0, cacheReadTokens: 0 }]);
    expect(r.messagesByFilterReason).toEqual([{ reason: "BULK", count: 1 }]);
    expect(r.adoption).toEqual({ businessDays: 4, activeBusinessDays: 2, activeDays: ["2026-09-22", "2026-09-23"] });
    expect(await h.run("kpi", "--from", "2026-09-21", "--to", "2026-09-24")).toBe(0);
    expect(h.out.at(-1)).toContain("Adoption: user actions on 2 of 4 business days");
  });

  it("audit:sample writes a blind 0600 sample; audit:label imports and re-imports labels", async () => {
    const h = await harness(t);
    const { mailbox } = await seedOrgUserMailbox(t.db);
    const inWeek = (d: number) => new Date(Date.UTC(2026, 8, 21 + d, 9));
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push((await insertMessage(t.db, { mailboxId: mailbox.id, sortTs: inWeek(i), state: "filtered" })).id);
    for (let i = 0; i < 3; i++) {
      const m = await insertMessage(t.db, { mailboxId: mailbox.id, sortTs: inWeek(i), state: "applied", subject: `Θέμα ${i}` });
      await t.db.update(s.messages).set({ classification: i === 0 ? "ACTIONABLE" : "FYI" }).where(eq(s.messages.id, m.id));
    }
    const personal = await insertMessage(t.db, { mailboxId: mailbox.id, sortTs: inWeek(1), state: "applied" });
    await t.db.update(s.messages).set({ classification: "PERSONAL" }).where(eq(s.messages.id, personal.id));
    await insertMessage(t.db, { mailboxId: mailbox.id, sortTs: new Date("2026-09-30T09:00:00Z"), state: "filtered" }); // next week

    const outDir = path.join(h.dir, "audit");
    expect(await h.run("audit:sample", "--week", "2026-W39", "--filtered", "2", "--seed", "42", "--out-dir", outDir)).toBe(0);
    const sampleFile = path.join(outDir, "2026-W39-sample.json");
    expect(statSync(sampleFile).mode & 0o777).toBe(0o600);
    const sample = JSON.parse(readFileSync(sampleFile, "utf8"));
    expect(sample.items).toHaveLength(5); // 2 filtered + 2 fyi + 1 actionable
    expect(sample.items.every((i: Record<string, unknown>) => !("stratum" in i) && !("classification" in i))).toBe(true);
    expect(sample.items.map((i: { messageId: string }) => i.messageId)).not.toContain(personal.id);
    expect(h.err.join("\n")).toContain("contains e-mail content");
    expect(h.out[0]).toContain("filtered 2/4, fyi 2/2, actionable 1/1");

    // Same seed → same sample.
    const again = await harness(t);
    await again.run("audit:sample", "--week", "2026-W39", "--filtered", "2", "--seed", "42", "--out-dir", path.join(h.dir, "audit2"));
    const sample2 = JSON.parse(readFileSync(path.join(h.dir, "audit2", "2026-W39-sample.json"), "utf8"));
    expect(sample2.items.map((i: { messageId: string }) => i.messageId)).toEqual(sample.items.map((i: { messageId: string }) => i.messageId));

    const labelsFile = path.join(outDir, "2026-W39-labels.json");
    const labels = JSON.parse(readFileSync(labelsFile, "utf8"));
    labels.labels[0].expected = [{ title: "ABC — Αποστολή προσφοράς", status: "ACTION_REQUIRED", owner: "ME", due: null }];
    labels.labels.push({ messageId: "00000000-0000-4000-8000-000000000000", expected: [] });
    writeFileSync(labelsFile, JSON.stringify(labels));
    expect(await h.run("audit:label", "--week", "2026-W39", labelsFile)).toBe(0);
    expect(h.out.at(-1)).toContain("5 new, 0 updated, 1 skipped");
    expect(await h.run("audit:label", "--week", "2026-W39", labelsFile)).toBe(0);
    expect(h.out.at(-1)).toContain("0 new, 5 updated");
    const rows = await t.db.select().from(s.messageLabels);
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.sampleWeek === "2026-W39" && r.stratum !== null)).toBe(true);
    expect(await h.run("audit:sample", "--week", "2026-39")).toBe(1);
  });
});

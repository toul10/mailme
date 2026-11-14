import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../../src/config.js";
import * as s from "../../../src/db/schema.js";
import type { MailboxConnectionSettings } from "../../../src/domain/types.js";
import { hashPassword, type CliContext, type CliServices } from "../../../src/cli/context.js";
import type { CliIO } from "../../../src/cli/io.js";
import { runCli } from "../../../src/cli/run.js";
import { openMailboxPassword } from "../../../src/lib/credentials.js";
import { ephemeralSealingKeys } from "../../../src/lib/sealed.js";
import { nullLogger } from "../../../src/lib/log.js";
import type { ProbeResult } from "../../../src/mail/imap/probe.js";
import { createRuntime } from "../../../src/worker/runtime.js";
import { createTestDb, seedOrgUserMailbox, type TestDb } from "../../helpers/db.js";

const NOW = new Date("2026-09-24T09:00:00Z");
const probeOk: ProbeResult = {
  ok: true,
  errorKind: null,
  error: null,
  capabilities: ["IMAP4rev1", "IDLE"],
  delimiter: ".",
  folders: [{ path: "INBOX", name: "INBOX", delimiter: ".", flags: [], specialUse: "\\Inbox", role: "inbox", roleSource: "special_use", messages: 10 }],
  quota: null,
};

describe("mailbox-add-patch-before-probe", () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(() => t.close());

  it("a failed re-probe leaves an active mailbox's connection settings next to its sealed password untouched", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mailme-repro-"));
    const answers: string[] = [];
    const err: string[] = [];
    const io: CliIO = { out: () => {}, err: (x) => void err.push(x), prompt: async () => answers.shift()!, confirm: async () => true, close() {} };
    const config = loadConfig({
      MASTER_KEY: Buffer.alloc(32, 5).toString("base64"),
      APP_SECRET: "z".repeat(40),
      DATABASE_URL: "pglite://memory",
      AI_MODE: "mock",
      CREDENTIALS_PUBLIC_KEY_FILE: path.join(dir, "keys", "credentials.pub.pem"),
      CREDENTIALS_PRIVATE_KEY_FILE: path.join(dir, "keys", "credentials.key.pem"),
    });
    const keys = ephemeralSealingKeys(config.CREDENTIALS_KID);
    const runtime = await createRuntime(config, { handle: t, keys: "lazy", sealingKeys: keys, log: nullLogger, clock: { now: () => NOW } });
    const probe = vi.fn(async (_s: MailboxConnectionSettings, _p: string): Promise<ProbeResult> => probeOk);
    const fail = () => vi.fn(async () => {
      throw new Error("not stubbed");
    });
    const services: CliServices = {
      runMigrations: vi.fn(async () => {}),
      hashPassword,
      probeMailbox: probe,
      defaultSyncEnabled: vi.fn(() => true),
      syncMailboxOnce: fail(),
      drainMailbox: fail(),
      importEmlFiles: fail(),
      deliverDigestForUser: fail(),
      runRetention: fail(),
      runHealthChecks: fail(),
      exec: fail(),
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
    const run = (...argv: string[]) => runCli(argv, ctx);

    await seedOrgUserMailbox(t.db, { address: "owner@contoso.example" });
    await t.db.delete(s.mailboxes);
    answers.push("old-secret");
    expect(await run("mailbox:add", "--user", "owner@contoso.example", "--address", "owner@contoso.example", "--host", "mail.contoso.example")).toBe(0);
    let [mb] = await t.db.select().from(s.mailboxes);
    expect(mb).toMatchObject({ status: "active", imapUsername: "owner@contoso.example" }); // precondition: working mailbox

    // Operator re-runs with a new login and mistypes the password: the probe is rejected.
    probe.mockResolvedValueOnce({ ...probeOk, ok: false, errorKind: "auth", error: "AUTHENTICATIONFAILED", folders: [] });
    answers.push("typo");
    expect(await run("mailbox:add", "--user", "owner@contoso.example", "--address", "owner@contoso.example", "--username", "a-login")).toBe(1);
    expect(err.join("\n")).toContain("NOT stored");

    [mb] = await t.db.select().from(s.mailboxes);
    expect(mb!.status).toBe("active");
    expect(openMailboxPassword(mb!, keys)).toBe("old-secret");
    // The worker's next login must still use the settings that go with the stored password.
    expect(mb!.imapUsername).toBe("owner@contoso.example");
  });
});

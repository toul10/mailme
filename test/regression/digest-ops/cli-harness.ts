import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { vi } from "vitest";
import { loadConfig } from "../../../src/config.js";
import type { FolderRole } from "../../../src/domain/types.js";
import { hashPassword, type CliContext, type CliServices } from "../../../src/cli/context.js";
import type { CliIO } from "../../../src/cli/io.js";
import { runCli } from "../../../src/cli/run.js";
import { ephemeralSealingKeys, type SealingKeys } from "../../../src/lib/sealed.js";
import { nullLogger } from "../../../src/lib/log.js";
import type { ProbeResult } from "../../../src/mail/imap/probe.js";
import { createRuntime } from "../../../src/worker/runtime.js";
import type { TestDb } from "../../helpers/db.js";

/** Minimal CLI harness (same shape as test/worker-cli-ops/cli.test.ts): scripted prompts, captured output, stubbed services. */
export interface CliHarness {
  out: string[];
  err: string[];
  answers: string[];
  keys: SealingKeys;
  services: CliServices;
  run(...argv: string[]): Promise<number>;
}

export const probeOk: ProbeResult = {
  ok: true,
  errorKind: null,
  error: null,
  capabilities: ["IMAP4rev1", "SPECIAL-USE", "IDLE"],
  delimiter: "/",
  folders: [
    { path: "INBOX", name: "INBOX", delimiter: "/", flags: [], specialUse: "\\Inbox", role: "inbox", roleSource: "special_use", messages: 10 },
    { path: "Customers", name: "Customers", delimiter: "/", flags: [], specialUse: null, role: "other", roleSource: "name", messages: 5 },
    { path: "Virtual/All", name: "All", delimiter: "/", flags: ["\\HasNoChildren"], specialUse: "\\All", role: "other", roleSource: "special_use", messages: 15 },
  ],
  quota: null,
};

export async function cliHarness(t: TestDb, now: Date, overrides: Partial<CliServices> = {}): Promise<CliHarness> {
  const dir = mkdtempSync(path.join(tmpdir(), "mailme-reg-cli-"));
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
  });
  const keys = ephemeralSealingKeys(config.CREDENTIALS_KID);
  const runtime = await createRuntime(config, { handle: t, keys: "lazy", sealingKeys: keys, log: nullLogger, clock: { now: () => now } });
  const fail = (name: string) =>
    vi.fn(async () => {
      throw new Error(`${name} not stubbed`);
    });
  const services: CliServices = {
    runMigrations: vi.fn(async () => {}),
    hashPassword,
    probeMailbox: vi.fn(async () => probeOk),
    defaultSyncEnabled: vi.fn((role: FolderRole) => role !== "drafts" && role !== "trash"),
    syncMailboxOnce: fail("syncMailboxOnce"),
    drainMailbox: fail("drainMailbox"),
    importEmlFiles: fail("importEmlFiles"),
    deliverDigestForUser: fail("deliverDigestForUser"),
    runRetention: fail("runRetention"),
    runHealthChecks: fail("runHealthChecks"),
    exec: fail("exec"),
    ...overrides,
  };
  const ctx: CliContext = {
    io,
    config: () => config,
    tryConfig: () => config,
    ops: () => ({ DATA_DIR: path.join(dir, "data"), DISK_CHECK: "on", BACKUP_DIR: path.join(dir, "backups"), BACKUP_KEEP_DAYS: 30, BACKUP_MARKER_FILE: undefined }),
    runtime: async () => runtime,
    services,
    now: () => now,
  };
  return { out, err, answers, keys, services, run: (...argv) => runCli(argv, ctx) };
}

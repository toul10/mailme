import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "../../../src/db/schema.js";
import { nullLogger } from "../../../src/lib/log.js";
import { POISON_MAX_ATTEMPTS, startMailboxWatcher, syncMailboxOnce, type SyncReport } from "../../../src/mail/imap/sync.js";
import { ingestMessage } from "../../../src/mail/ingest.js";
import { createTestDb, type TestDb } from "../../helpers/db.js";
import { folderByPath, setupEnv, type Env } from "../../imap/helpers.js";
import { fixture } from "../../mail-core/helpers.js";

async function until(cond: () => boolean | Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

let db: TestDb;
let env: Env;
let reports: SyncReport[];
let watcher: { stop(): Promise<void> } | null;
let attempts = 0;

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  env = await setupEnv(db);
  reports = [];
  watcher = null;
  attempts = 0;
  env.deps.sleep = (ms, signal) =>
    new Promise<void>((resolve) => {
      env.clock.advance(ms);
      if (signal.aborted) return resolve();
      const t = setTimeout(resolve, Math.min(ms, 10));
      signal.addEventListener("abort", () => {
        clearTimeout(t);
        resolve();
      });
    });
  env.deps.config = { ...env.deps.config, FOLDER_POLL_SEC: 0.01, SYNC_INTERVAL_SEC: 1000 };
  // Real ingest for everything else; uid 7 fails persistently. (A realistic trigger today: a DSN whose original
  // already has task links makes recordBounce throw 22P02 "malformed array literal" on every attempt.)
  const ingestDeps = { db: env.t.db, clock: env.clock, log: nullLogger, platformMailDomain: "mailme.local", lateDiscoveryMaxDays: 7 };
  env.deps.ingest = async (input) => {
    if (input.location?.uid === 7) {
      attempts++;
      throw new Error("persistent ingest failure");
    }
    return ingestMessage(ingestDeps, input);
  };
});
afterEach(async () => {
  await watcher?.stop();
});

async function expectTrace(env: Env) {
  const inbox = await folderByPath(env, "INBOX");
  const rows = await env.t.db.select().from(s.messages).where(eq(s.messages.mailboxId, env.mailboxId));
  const locs = await env.t.db.select().from(s.messageLocations).where(eq(s.messageLocations.folderId, inbox.id));
  const trace = rows.find((r) => r.messageKey === `poison:${inbox.id}:${inbox.uidValidity}:7`);
  // "Nothing disappears": a failed row, shown as "Not analysed" and counted in the recall denominator.
  expect(trace).toMatchObject({
    state: "failed",
    lastError: "ingest_failed",
    direction: "INBOUND",
    messageIdHeader: null,
    internalDate: new Date("2026-09-23T09:00:00Z"),
    sortTs: new Date("2026-09-23T09:00:00Z"),
  });
  // Envelope data from FETCH ENVELOPE, so the owner can find the mail in Outlook.
  expect(trace!.subject.length).toBeGreaterThan(0);
  expect(locs.find((l) => l.uid === 7)?.messageId).toBe(trace!.id);
}

describe("poison-skip-no-trace", () => {
  it("a DSN whose ingest keeps failing is skipped after 5 cycles and leaves a durable trace (watcher)", async () => {
    // A postfix DSN lands in INBOX; its ingest fails on every attempt.
    env.server.addMessage("INBOX", { uid: 7, raw: fixture("bounce-postfix.eml"), internalDate: new Date("2026-09-23T09:00:00Z") });

    watcher = startMailboxWatcher(env.deps, env.mailboxId, { onCycle: (r) => void reports.push(r) });
    await until(async () => (await folderByPath(env, "INBOX").catch(() => null))?.lastSeenUid === 7);
    await watcher.stop();
    watcher = null;
    expect(attempts).toBe(POISON_MAX_ATTEMPTS);
    await expectTrace(env);
  });

  it("syncMailboxOnce skips the same way (shared failure counts) and records the trace", async () => {
    env.server.addMessage("INBOX", { uid: 7, raw: fixture("bounce-postfix.eml"), internalDate: new Date("2026-09-23T09:00:00Z") });
    const runs: SyncReport[] = [];
    for (let i = 0; i < POISON_MAX_ATTEMPTS; i++) runs.push(await syncMailboxOnce(env.deps, env.mailboxId));
    expect(attempts).toBe(POISON_MAX_ATTEMPTS);
    expect(runs.slice(0, -1).every((r) => r.errorKind === "ingest" && !r.fullCycle)).toBe(true);
    expect(runs.at(-1)).toMatchObject({ ok: true, fullCycle: true });
    expect((await folderByPath(env, "INBOX")).lastSeenUid).toBe(7);
    await expectTrace(env);
    // Never fetched again.
    await syncMailboxOnce(env.deps, env.mailboxId);
    expect(attempts).toBe(POISON_MAX_ATTEMPTS);
  });
});

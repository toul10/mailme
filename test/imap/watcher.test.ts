import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "../../src/db/schema.js";
import { createTestDb, type TestDb } from "../helpers/db.js";
import { POISON_MAX_ATTEMPTS, startMailboxWatcher, type SyncReport } from "../../src/mail/imap/sync.js";
import { makeEml, type FakeImapClient } from "./fake-imap.js";
import { folderByPath, mailboxRow, setupEnv, type Env } from "./helpers.js";

const d = (iso: string) => new Date(iso);

async function until(cond: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
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
  // Compress time: every wait lasts ≤ 10 ms of real time and advances the fake clock by what was asked.
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
  env.deps.config = { ...env.deps.config, FOLDER_POLL_SEC: 1000, SYNC_INTERVAL_SEC: 1000 };
});
afterEach(async () => {
  await watcher?.stop();
});

const start = () => {
  watcher = startMailboxWatcher(env.deps, env.mailboxId, { onCycle: (r) => void reports.push(r) });
  return watcher;
};
const client = (i = -1) => env.server.clients.at(i) as FakeImapClient;

describe("startMailboxWatcher", () => {
  it("runs a full cycle, keeps INBOX selected, and syncs INBOX again on EXISTS", async () => {
    env.server.addMessage("INBOX", { uid: 3, raw: makeEml({ messageId: "w1@abc-gr.example" }), internalDate: d("2026-09-20T09:00:00Z") });
    start();
    await until(() => reports.length >= 1);
    expect(reports[0]).toMatchObject({ ok: true, fullCycle: true, newMessages: 1 });
    expect(env.server.connectOptions[0]!.mode).toBe("watch");
    await until(() => client().selectedPath === "INBOX");
    expect(env.server.callsOf("mailboxOpen").every((c) => (c.args[1] as { readOnly: boolean }).readOnly === true)).toBe(true);

    env.server.deliver("INBOX", { raw: makeEml({ messageId: "w2@abc-gr.example" }), internalDate: d("2026-09-24T07:59:00Z") });
    await until(() => reports.length >= 2);
    expect(reports[1]).toMatchObject({ ok: true, fullCycle: false, newMessages: 1 });
    const inbox = await folderByPath(env, "INBOX");
    expect(env.ingest.uidsFor(inbox.id)).toEqual([3, 4]);

    await watcher!.stop();
    expect(env.server.callsOf("logout").length).toBeGreaterThanOrEqual(1);
    expect(env.server.callsOf("connect")).toHaveLength(1);
    expect(env.server.violations).toEqual([]);
  });

  it("STATUS-polls the other folders every FOLDER_POLL_SEC and reports full cycles", async () => {
    env.deps.config = { ...env.deps.config, FOLDER_POLL_SEC: 0.03 };
    start();
    await until(() => reports.length >= 1);
    env.server.addMessage("INBOX.Sent", { raw: makeEml({ messageId: "sent1@contoso.example" }), internalDate: d("2026-09-24T07:00:00Z") });
    const sent = await folderByPath(env, "INBOX.Sent");
    await until(() => env.ingest.uidsFor(sent.id).length === 1);
    await until(() => reports.filter((r) => r.fullCycle).length >= 3);
    expect(env.server.callsOf("status").some((c) => c.args[0] === "INBOX.Sent")).toBe(true);
    expect(env.server.callsOf("connect")).toHaveLength(1);
  });

  it("stops for good on an authentication failure", async () => {
    env.server.connectError = Object.assign(new Error("Authentication failed"), { authenticationFailed: true, serverResponseCode: "AUTHENTICATIONFAILED" });
    start();
    await until(() => reports.length >= 1);
    expect(reports[0]).toMatchObject({ ok: false, errorKind: "auth" });
    await new Promise((r) => setTimeout(r, 50));
    expect(env.server.callsOf("connect")).toHaveLength(1);
    expect((await mailboxRow(env)).status).toBe("auth_failed");
  });

  it("reconnects with backoff after the server drops the connection", async () => {
    start();
    await until(() => reports.length >= 1);
    client(0).drop();
    await until(() => env.server.callsOf("connect").length >= 2);
    await until(() => reports.filter((r) => r.fullCycle).length >= 2);
    const mb = await mailboxRow(env);
    expect(mb.consecutiveFailures).toBe(0);
    expect(mb.status).toBe("active");
  });

  it("waits out a paused mailbox without logging in", async () => {
    await env.t.db.update(s.mailboxes).set({ status: "paused" }).where(eq(s.mailboxes.id, env.mailboxId));
    start();
    await new Promise((r) => setTimeout(r, 60));
    expect(env.server.callsOf("connect")).toHaveLength(0);
    await env.t.db.update(s.mailboxes).set({ status: "active" }).where(eq(s.mailboxes.id, env.mailboxId));
    await until(() => reports.length >= 1);
    expect(reports[0]!.ok).toBe(true);
  });

  it("stop() during the IDLE wait returns promptly", async () => {
    start();
    await until(() => reports.length >= 1);
    const t0 = Date.now();
    await watcher!.stop();
    expect(Date.now() - t0).toBeLessThan(1_000);
    const after = env.server.calls.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(env.server.calls.length).toBe(after);
  });

  it("skips a message whose ingest keeps failing after POISON_MAX_ATTEMPTS cycles", async () => {
    env.deps.config = { ...env.deps.config, FOLDER_POLL_SEC: 0.01 };
    env.server.addMessage("INBOX", { uid: 3, raw: makeEml({ messageId: "p1@abc-gr.example" }), internalDate: d("2026-09-20T09:00:00Z") });
    env.server.addMessage("INBOX", { uid: 4, raw: makeEml({ messageId: "p2@abc-gr.example" }), internalDate: d("2026-09-20T10:00:00Z") });
    env.ingest.failUids.set(3, 1_000);
    start();
    await until(async () => (await folderByPath(env, "INBOX").catch(() => null))?.lastSeenUid === 4);
    const inbox = await folderByPath(env, "INBOX");
    expect(env.ingest.uidsFor(inbox.id).filter((u) => u === 3)).toHaveLength(POISON_MAX_ATTEMPTS);
    expect(env.ingest.uidsFor(inbox.id)).toContain(4);
    expect(reports.some((r) => r.errorKind === "ingest" && !r.fullCycle)).toBe(true);
    await until(() => reports.some((r) => r.ok && r.fullCycle));
  });
});

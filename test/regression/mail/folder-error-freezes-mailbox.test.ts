import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ImapClientLike, ImapConnectOptions } from "../../../src/mail/imap/client.js";
import { isFolderCommandFailure, isFolderLevelError } from "../../../src/mail/imap/errors.js";
import { markCycleOk } from "../../../src/mail/imap/store.js";
import { FOLDER_EXCLUDE_AFTER, syncMailboxOnce } from "../../../src/mail/imap/sync.js";
import { createTestDb, type TestDb } from "../../helpers/db.js";
import { makeEml } from "../../imap/fake-imap.js";
import { folderByPath, mailboxRow, setupEnv, type Env } from "../../imap/helpers.js";

let db: TestDb;
let env: Env;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  env = await setupEnv(db);
});

/** Every EXAMINE of `path` fails with a tagged NO carrying `code` while `broken.on` (persistent, unlike failNext). */
function breakFolder(path: string, code: string) {
  const broken = { on: true };
  const inner = env.server.factory;
  env.deps.imapFactory = (opts: ImapConnectOptions): ImapClientLike => {
    const c = inner(opts);
    const open = c.mailboxOpen.bind(c);
    c.mailboxOpen = async (p, o) => {
      if (p === path && broken.on) {
        throw Object.assign(new Error(`Command failed: ${code}`), { responseStatus: "NO", serverResponseCode: code });
      }
      return open(p, o);
    };
    return c;
  };
  return broken;
}

describe("folder-error-freezes-mailbox", () => {
  it("(b) NO [SERVERBUG] on EXAMINE of a user folder must not stop INBOX from being synced", async () => {
    env.server.addMessage("INBOX", { uid: 1, raw: makeEml({ messageId: "in1@abc-gr.example" }), internalDate: new Date("2026-09-23T09:00:00Z") });
    breakFolder("INBOX.Πελάτες", "SERVERBUG");
    const reports = [];
    for (let i = 0; i < 3; i++) {
      reports.push(await syncMailboxOnce(env.deps, env.mailboxId));
      env.clock.advance(300_000);
    }
    // The session survives the folder error (no connection failure / backoff); the folder is reported incomplete.
    expect(reports.map((r) => r.errorKind)).toEqual(["folder", "folder", "folder"]);
    const inbox = await folderByPath(env, "INBOX");
    expect(env.ingest.uidsFor(inbox.id)).toContain(1);
    const mb = await mailboxRow(env);
    expect(mb.consecutiveFailures).toBe(0);
    expect(mb.nextAttemptAt).toBeNull();
    // The failing folder is recorded (op + code only), with its streak.
    expect(await folderByPath(env, "INBOX.Πελάτες")).toMatchObject({ consecutiveFailures: 3, lastError: "EXAMINE: SERVERBUG" });
    expect((await folderByPath(env, "INBOX.Πελάτες")).failingSince).not.toBeNull();
  });

  it("(a) a folder that always answers NO [NOPERM] must not freeze the full-cycle watermark forever", async () => {
    env.server.addMessage("INBOX", { uid: 1, raw: makeEml({ messageId: "in2@abc-gr.example" }), internalDate: new Date("2026-09-23T09:00:00Z") });
    const broken = breakFolder("INBOX.Πελάτες", "NOPERM");
    const reports = [];
    for (let i = 0; i < 5; i++) {
      reports.push(await syncMailboxOnce(env.deps, env.mailboxId));
      env.clock.advance(300_000);
    }
    const inbox = await folderByPath(env, "INBOX");
    expect(env.ingest.uidsFor(inbox.id)).toContain(1); // INBOX itself is fine…
    // …and after FOLDER_EXCLUDE_AFTER failed cycles the broken folder no longer blocks the settle window.
    expect(reports.map((r) => r.fullCycle)).toEqual([false, false, true, true, true]);
    expect(FOLDER_EXCLUDE_AFTER).toBe(3);
    const mb = await mailboxRow(env);
    expect(mb.lastSyncAt).not.toBeNull();
    // The mailbox error names the folder (no content), so health / the owner can see what is left out.
    expect(mb.lastError).toContain("INBOX.Πελάτες");
    expect(mb.lastError).toContain("NOPERM");

    // The folder is still tried every cycle and recovers on its own.
    broken.on = false;
    const ok = await syncMailboxOnce(env.deps, env.mailboxId);
    expect(ok).toMatchObject({ ok: true, errorKind: null, fullCycle: true });
    expect(await folderByPath(env, "INBOX.Πελάτες")).toMatchObject({ consecutiveFailures: 0, failingSince: null, lastError: null });
    expect((await mailboxRow(env)).lastError).toBeNull();
  });

  it("the watcher's clean INBOX-only cycles keep the full cycle's folder report in last_error", async () => {
    const detail = 'sync incomplete: 1 folder(s); failing for 3+ cycles and left out of the settle check: "INBOX.Πελάτες" (EXAMINE NOPERM)';
    await markCycleOk(env.t.db, env.mailboxId, env.clock.now(), true, 1, detail);
    await markCycleOk(env.t.db, env.mailboxId, env.clock.now(), false, 0, null, true);
    expect((await mailboxRow(env)).lastError).toBe(detail);
    // A clean full cycle clears it.
    await markCycleOk(env.t.db, env.mailboxId, env.clock.now(), true, 0, null);
    expect((await mailboxRow(env)).lastError).toBeNull();
  });

  it("an INBOX failure stays fatal for the cycle", async () => {
    breakFolder("INBOX", "SERVERBUG");
    const r = await syncMailboxOnce(env.deps, env.mailboxId);
    expect(r).toMatchObject({ ok: false, errorKind: "protocol", fullCycle: false });
    expect((await mailboxRow(env)).nextAttemptAt).not.toBeNull();
  });

  it("classifies folder-command failures: tagged NO and imapflow's NotFound, never auth / limits / connection", () => {
    const no = (code: string) => Object.assign(new Error("Command failed"), { responseStatus: "NO", serverResponseCode: code });
    expect(isFolderCommandFailure(no("SERVERBUG"))).toBe(true);
    expect(isFolderCommandFailure(no("NOPERM"))).toBe(true);
    // imapflow STATUS of a vanished folder: { code: 'NotFound', response: <original NO error> }
    const notFound = Object.assign(new Error("Mailbox doesn't exist: X"), { code: "NotFound", response: no("NONEXISTENT") });
    expect(isFolderLevelError(notFound)).toBe(true);
    expect(isFolderCommandFailure(notFound)).toBe(true);
    expect(isFolderCommandFailure(no("LIMIT"))).toBe(false);
    expect(isFolderCommandFailure(Object.assign(new Error("Connection not available"), { code: "NoConnection" }))).toBe(false);
    expect(isFolderCommandFailure(Object.assign(new Error("x"), { responseStatus: "NO", serverResponseCode: "AUTHENTICATIONFAILED" }))).toBe(false);
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "../../src/db/schema.js";
import { createTestDb, seedOrgUserMailbox, type TestDb } from "../helpers/db.js";
import type { MailboxConnectionSettings } from "../../src/domain/types.js";
import { createRecordingProber, ProbeLimiter, probeMailboxWith } from "../../src/mail/imap/probe.js";
import { FakeImapServer, makeEml, READ_ONLY_METHODS } from "./fake-imap.js";
import { FakeClock, NOW } from "./helpers.js";

const settings = (mailboxId = "mb-1"): MailboxConnectionSettings => ({
  mailboxId,
  address: "owner@contoso.example",
  imapHost: "mail.contoso.example",
  imapPort: 993,
  imapUsername: "owner@contoso.example",
  smtpHost: null,
  smtpPort: null,
});

let server: FakeImapServer;
beforeEach(() => {
  server = new FakeImapServer();
  server.addFolder("INBOX", { flags: ["\\HasChildren"] });
  server.addFolder("INBOX.Sent", { flags: ["\\HasNoChildren", "\\Sent"], specialUse: "\\Sent" });
  server.addFolder("INBOX.Απεσταλμένα", { flags: ["\\HasNoChildren"] });
  server.addFolder("Shared", { flags: ["\\Noselect", "\\HasChildren"] });
  server.addMessage("INBOX", { raw: makeEml(), internalDate: new Date() });
  server.addMessage("INBOX", { raw: makeEml(), internalDate: new Date() });
});

describe("probeMailboxWith", () => {
  it("reports capabilities, classified folders with counts, delimiter and quota — read-only", async () => {
    const r = await probeMailboxWith(settings(), "pw", { imapFactory: server.factory, limiter: null });
    expect(r).toMatchObject({ ok: true, errorKind: null, error: null, delimiter: ".", quota: { usedKb: 512, limitKb: 1024 * 1024 } });
    expect(r.capabilities).toContain("IDLE");
    expect(r.folders.map((f) => [f.path, f.role, f.roleSource, f.messages])).toEqual([
      ["INBOX", "inbox", "special_use", 2],
      ["INBOX.Sent", "sent", "special_use", 0],
      ["INBOX.Απεσταλμένα", "sent", "name", 0],
    ]);
    expect(server.callsOf("mailboxOpen")).toHaveLength(0);
    for (const m of server.methodNames()) expect(READ_ONLY_METHODS.has(m), m).toBe(true);
    expect(server.callsOf("logout")).toHaveLength(1);
  });

  it("returns a user-facing error and the kind on failure, and reports the attempt", async () => {
    server.connectError = Object.assign(new Error("Authentication failed"), { authenticationFailed: true, serverResponseCode: "AUTHENTICATIONFAILED" });
    const seen: string[] = [];
    const r = await probeMailboxWith(settings(), "bad", { imapFactory: server.factory, limiter: null, onLoginAttempt: (_id, p, o) => void seen.push(`${p}:${o}`) });
    expect(r).toMatchObject({ ok: false, errorKind: "auth", folders: [], quota: null });
    expect(r.error).toMatch(/password/);
    expect(seen).toEqual(["probe:auth_failed"]);
  });

  it("rate-limits repeated probes and stops after three rejected passwords", async () => {
    let now = 0;
    const limiter = new ProbeLimiter(20_000, 3, 15 * 60_000);
    const opts = { imapFactory: server.factory, limiter, now: () => now };
    expect((await probeMailboxWith(settings(), "pw", opts)).ok).toBe(true);
    now += 5_000;
    expect((await probeMailboxWith(settings(), "pw", opts)).errorKind).toBe("rate_limited");
    expect(server.callsOf("connect")).toHaveLength(1);

    server.connectError = Object.assign(new Error("Authentication failed"), { authenticationFailed: true });
    for (let i = 0; i < 3; i++) {
      now += 30_000;
      expect((await probeMailboxWith(settings(), "bad", opts)).errorKind).toBe("auth");
    }
    now += 30_000;
    const blocked = await probeMailboxWith(settings(), "bad", opts);
    expect(blocked.errorKind).toBe("rate_limited");
    expect(blocked.error).toMatch(/Wait/);
    expect(server.callsOf("connect")).toHaveLength(4);
    // another mailbox is not affected; the window expires
    expect((await probeMailboxWith(settings("mb-2"), "bad", opts)).errorKind).toBe("auth");
    now += 16 * 60_000;
    server.connectError = null;
    expect((await probeMailboxWith(settings(), "pw", opts)).ok).toBe(true);
  });
});

describe("createRecordingProber", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it("records every probe login in mailbox_login_attempts", async () => {
    const { mailbox } = await seedOrgUserMailbox(db.db);
    const probe = createRecordingProber({ db: db.db, clock: new FakeClock(NOW.getTime()) }, { imapFactory: server.factory, limiter: null });
    await probe(settings(mailbox.id), "pw");
    server.connectError = Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" });
    await probe(settings(mailbox.id), "pw");
    await new Promise((r) => setTimeout(r, 20));
    const rows = await db.db.select().from(s.mailboxLoginAttempts).where(eq(s.mailboxLoginAttempts.mailboxId, mailbox.id));
    expect(rows.map((r) => [r.purpose, r.outcome, r.detail])).toEqual([
      ["probe", "ok", null],
      ["probe", "network", "ETIMEDOUT"],
    ]);
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { simpleParser } from "mailparser";
import type { FetchQueryObject } from "imapflow";
import * as s from "../../src/db/schema.js";
import { createTestDb, insertFolder, insertMessage, type TestDb } from "../helpers/db.js";
import { imapFlowOptions } from "../../src/mail/imap/client.js";
import { computeBackoffMs, TOO_MANY_MIN_MS } from "../../src/mail/imap/errors.js";
import { AUTH_FAILED_REASON } from "../../src/mail/imap/store.js";
import { syncMailboxOnce } from "../../src/mail/imap/sync.js";
import { makeEml, READ_ONLY_METHODS } from "./fake-imap.js";
import { folderByPath, loginAttempts, mailboxRow, NOW, setupEnv, type Env } from "./helpers.js";

const d = (iso: string) => new Date(iso);

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

function seedInbox() {
  const { server } = env;
  server.addMessage("INBOX", { uid: 1, raw: makeEml({ messageId: "old@abc-gr.example" }), internalDate: d("2026-07-15T09:00:00Z"), date: d("2026-07-15T09:00:00Z") });
  server.addMessage("INBOX", { uid: 2, raw: makeEml({ messageId: "a@abc-gr.example" }), internalDate: d("2026-08-10T09:00:00Z"), flags: ["\\Seen"] });
  server.addMessage("INBOX", { uid: 3, raw: makeEml({ messageId: "b@abc-gr.example" }), internalDate: d("2026-09-20T09:00:00Z") });
  // Old INTERNALDATE (migrated copy) but a recent Date header: only SENTSINCE finds it.
  server.addMessage("INBOX", { uid: 4, raw: makeEml({ messageId: "c@abc-gr.example" }), internalDate: d("2026-07-01T09:00:00Z"), date: d("2026-08-05T09:00:00Z") });
  server.addMessage("INBOX.Sent", { uid: 10, raw: makeEml({ messageId: "s@contoso.example", from: "owner@contoso.example", to: "client@abc-gr.example" }), internalDate: d("2026-09-21T09:00:00Z") });
  server.addMessage("INBOX.Drafts", { uid: 1, raw: makeEml({ messageId: "draft@contoso.example" }), internalDate: d("2026-09-22T09:00:00Z"), flags: ["\\Draft"] });
  server.addMessage("INBOX.Trash", { uid: 1, raw: makeEml({ messageId: "t@abc-gr.example" }), internalDate: d("2026-09-22T09:00:00Z") });
}

function sourceFetchUids(): number[] {
  return env.server
    .callsOf("fetchAll")
    .filter((c) => (c.args[1] as FetchQueryObject).source)
    .flatMap((c) => String(c.args[0]).split(","))
    .flatMap((r) => {
      const [a, b] = r.split(":").map(Number);
      return b === undefined ? [a!] : Array.from({ length: b - a! + 1 }, (_, i) => a! + i);
    });
}

describe("syncMailboxOnce — first sync", () => {
  it("lists folders, searches SINCE/SENTSINCE from backfillFrom and ingests in UID order", async () => {
    seedInbox();
    const report = await syncMailboxOnce(env.deps, env.mailboxId);
    expect(report).toMatchObject({ ok: true, errorKind: null, fullCycle: true, newMessages: 4, duplicates: 0 });

    // Folder roles and default selection
    const inbox = await folderByPath(env, "INBOX");
    expect(inbox).toMatchObject({ role: "inbox", syncEnabled: true, uidValidity: 1000, uidNext: 5, lastSeenUid: 4, firstSyncDone: true });
    expect(await folderByPath(env, "INBOX.Sent")).toMatchObject({ role: "sent", roleSource: "special_use", syncEnabled: true });
    expect(await folderByPath(env, "INBOX.Drafts")).toMatchObject({ role: "drafts", syncEnabled: false });
    expect(await folderByPath(env, "INBOX.Trash")).toMatchObject({ role: "trash", syncEnabled: false });
    expect(await folderByPath(env, "INBOX.spam")).toMatchObject({ role: "junk", roleSource: "name", syncEnabled: true });
    expect(await folderByPath(env, "INBOX.Πελάτες")).toMatchObject({ role: "other", syncEnabled: true });

    // SEARCH OR SINCE <h> SENTSINCE <h>, h = mailbox.backfillFrom
    const h = d("2026-08-01T00:00:00Z");
    for (const c of env.server.callsOf("search")) {
      expect(c.args[0]).toEqual({ or: [{ since: h }, { sentSince: h }] });
      expect(c.args[1]).toEqual({ uid: true });
    }
    // Only the in-horizon INBOX messages, in UID order; drafts/trash never opened
    expect(env.ingest.uidsFor(inbox.id)).toEqual([2, 3, 4]);
    expect(env.server.callsOf("mailboxOpen").map((c) => c.args[0])).not.toContain("INBOX.Drafts");
    expect(env.server.callsOf("mailboxOpen").map((c) => c.args[0])).not.toContain("INBOX.Trash");
    // INBOX is synced first, then Sent: a broken user folder can never keep INBOX from being synced
    expect(env.server.callsOf("mailboxOpen").map((c) => c.args[0]).slice(0, 2)).toEqual(["INBOX", "INBOX.Sent"]);

    const first = env.ingest.inputs.find((i) => i.location?.uid === 2 && i.location.folderId === inbox.id)!;
    expect(first).toMatchObject({ mailboxId: env.mailboxId, via: "imap", location: { folderRole: "inbox", flags: ["\\Seen"], internalDate: d("2026-08-10T09:00:00Z") } });
    expect(first.source.kind).toBe("mime");

    const mb = await mailboxRow(env);
    expect(mb.lastSyncAt).toEqual(NOW);
    expect(mb.lastLoginAt).toEqual(NOW);
    expect(mb.consecutiveFailures).toBe(0);
    const attempts = await loginAttempts(env);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ purpose: "sync", outcome: "ok" });
    expect(env.server.connectOptions[0]).toMatchObject({ host: "mail.contoso.example", port: 993, user: "owner@contoso.example", pass: "s3cret", mode: "short" });
  });

  it("uses now − BACKFILL_DAYS when backfillFrom is unset", async () => {
    await env.t.db.update(s.mailboxes).set({ backfillFrom: null }).where(eq(s.mailboxes.id, env.mailboxId));
    await syncMailboxOnce(env.deps, env.mailboxId);
    const h = new Date(NOW.getTime() - 21 * 86_400_000);
    expect(env.server.callsOf("search")[0]!.args[0]).toEqual({ or: [{ since: h }, { sentSince: h }] });
  });

  it("an empty first sync still moves lastSeenUid to UIDNEXT−1, so old mail is never fetched later", async () => {
    env.server.addMessage("INBOX", { uid: 7, raw: makeEml(), internalDate: d("2026-06-01T09:00:00Z") });
    await syncMailboxOnce(env.deps, env.mailboxId);
    expect(await folderByPath(env, "INBOX")).toMatchObject({ lastSeenUid: 7, firstSyncDone: true, uidNext: 8 });
    expect(env.ingest.inputs).toHaveLength(0);

    env.server.calls.length = 0;
    const again = await syncMailboxOnce(env.deps, env.mailboxId);
    expect(again.fullCycle).toBe(true);
    // STATUS says nothing changed → no folder is opened, nothing fetched
    expect(env.server.callsOf("mailboxOpen")).toHaveLength(0);
    expect(env.server.callsOf("fetchAll")).toHaveLength(0);
    expect(env.ingest.inputs).toHaveLength(0);
  });

  it("syncs INBOX on a server whose namespace-prefixed LIST leaves INBOX out (Dovecot «INBOX.», common on shared hosting)", async () => {
    seedInbox();
    env.server.inboxHiddenFromListOnly = true;
    await syncMailboxOnce(env.deps, env.mailboxId);
    expect(await folderByPath(env, "INBOX")).toMatchObject({ goneAt: null, firstSyncDone: true, lastSeenUid: 4 });
    expect(env.ingest.inputs.map((i) => i.location?.uid)).toEqual(expect.arrayContaining([3, 4]));
    // And an INBOX already marked gone by the old code comes back.
    await db.db.update(s.mailboxFolders).set({ goneAt: NOW }).where(eq(s.mailboxFolders.path, "INBOX"));
    await syncMailboxOnce(env.deps, env.mailboxId);
    expect((await folderByPath(env, "INBOX"))?.goneAt).toBeNull();
  });

  it("only ever opens folders read-only and never writes", async () => {
    seedInbox();
    await syncMailboxOnce(env.deps, env.mailboxId);
    env.server.deliver("INBOX", { raw: makeEml(), internalDate: d("2026-09-24T07:00:00Z") });
    await syncMailboxOnce(env.deps, env.mailboxId);
    expect(env.server.violations).toEqual([]);
    for (const c of env.server.callsOf("mailboxOpen")) expect(c.args[1]).toEqual({ readOnly: true });
    for (const m of env.server.methodNames()) expect(READ_ONLY_METHODS.has(m), m).toBe(true);
    expect(env.server.callsOf("append")).toHaveLength(0);
  });
});

describe("syncMailboxOnce — incremental", () => {
  it("fetches UID lastSeen+1:* and ignores the N:* quirk that returns the last old message", async () => {
    seedInbox();
    await syncMailboxOnce(env.deps, env.mailboxId);
    const inbox = await folderByPath(env, "INBOX");
    env.ingest.inputs.length = 0;

    env.server.deliver("INBOX", { raw: makeEml({ messageId: "new@abc-gr.example" }), internalDate: d("2026-09-24T07:30:00Z") });
    const r1 = await syncMailboxOnce(env.deps, env.mailboxId);
    expect(r1).toMatchObject({ ok: true, newMessages: 1, fullCycle: true });
    expect(env.ingest.uidsFor(inbox.id)).toEqual([5]);
    expect(env.server.callsOf("fetchAll").some((c) => c.args[0] === "5:*")).toBe(true);
    expect(await folderByPath(env, "INBOX")).toMatchObject({ lastSeenUid: 5, uidNext: 6 });

    // A message arrived and was expunged: UIDNEXT moved, nothing new exists. `6:*` returns UID 5 again.
    env.ingest.inputs.length = 0;
    env.server.folders.get("INBOX")!.uidNext = 7;
    const r2 = await syncMailboxOnce(env.deps, env.mailboxId);
    expect(r2.ok).toBe(true);
    expect(env.ingest.inputs).toHaveLength(0);
    expect(await folderByPath(env, "INBOX")).toMatchObject({ lastSeenUid: 6, uidNext: 7 });
  });

  it("an ingest failure keeps lastSeenUid before the message and the next run resumes there", async () => {
    seedInbox();
    env.ingest.failUids.set(3, 1);
    const r1 = await syncMailboxOnce(env.deps, env.mailboxId);
    expect(r1).toMatchObject({ ok: false, errorKind: "ingest", fullCycle: false });
    const inbox = await folderByPath(env, "INBOX");
    expect(inbox).toMatchObject({ lastSeenUid: 2, firstSyncDone: false });
    expect(env.ingest.uidsFor(inbox.id)).toEqual([2, 3]);
    // the connection itself was fine: no backoff
    expect((await mailboxRow(env)).nextAttemptAt).toBeNull();

    env.ingest.inputs.length = 0;
    const r2 = await syncMailboxOnce(env.deps, env.mailboxId);
    expect(r2).toMatchObject({ ok: true, fullCycle: true });
    expect(env.ingest.uidsFor(inbox.id)).toEqual([3, 4]);
    expect(await folderByPath(env, "INBOX")).toMatchObject({ lastSeenUid: 4, firstSyncDone: true });
  });

  it("\\Draft and \\Deleted copies are ingested with headers and flags only (never read)", async () => {
    env.server.addMessage("INBOX", { uid: 1, raw: makeEml({ messageId: "del@abc-gr.example", body: "SECRET BODY" }), internalDate: d("2026-09-20T09:00:00Z"), flags: ["\\Deleted"] });
    env.server.addMessage("INBOX", { uid: 2, raw: makeEml({ messageId: "dr@abc-gr.example", body: "DRAFT BODY" }), internalDate: d("2026-09-20T09:00:00Z"), flags: ["\\Draft", "\\Seen"] });
    await syncMailboxOnce(env.deps, env.mailboxId);
    expect(env.ingest.inputs).toHaveLength(2);
    for (const i of env.ingest.inputs) {
      const raw = (i.source as { raw: Buffer }).raw.toString("utf8");
      expect(raw).toMatch(/Message-ID/);
      expect(raw).not.toMatch(/BODY/);
    }
    expect(env.ingest.inputs[1]!.location!.flags).toEqual(["\\Draft", "\\Seen"]);
    expect(sourceFetchUids()).toEqual([]);
  });
});

describe("syncMailboxOnce — UIDVALIDITY change", () => {
  it("drops stale locations, restarts the folder and fetches bodies only for unknown Message-IDs", async () => {
    const { server, t } = env;
    server.addMessage("INBOX", { uid: 2, raw: makeEml({ messageId: "a@abc-gr.example", body: "A body" }), internalDate: d("2026-09-10T09:00:00Z") });
    server.addMessage("INBOX", { uid: 3, raw: makeEml({ messageId: "b@abc-gr.example", body: "B body" }), internalDate: d("2026-09-11T09:00:00Z") });
    await syncMailboxOnce(env.deps, env.mailboxId);
    const inbox = await folderByPath(env, "INBOX");

    // What ingest would have stored: the two messages and their locations (plus a copy elsewhere).
    const other = await insertFolder(t.db, env.mailboxId, "Elsewhere", "other");
    const ma = await insertMessage(t.db, { mailboxId: env.mailboxId, messageIdHeader: "a@abc-gr.example" });
    const mb = await insertMessage(t.db, { mailboxId: env.mailboxId, messageIdHeader: "b@abc-gr.example" });
    await t.db.insert(s.messageLocations).values([
      { messageId: ma.id, folderId: inbox.id, uid: 2 },
      { messageId: mb.id, folderId: inbox.id, uid: 3 },
      { messageId: ma.id, folderId: other.id, uid: 99 },
    ]);

    // The server renumbers INBOX: new UIDVALIDITY, same two messages + one unknown.
    const f = server.folders.get("INBOX")!;
    f.messages = [];
    f.uidNext = 1;
    f.uidValidity = 7777;
    server.addMessage("INBOX", { uid: 1, raw: makeEml({ messageId: "a@abc-gr.example", body: "A body" }), internalDate: d("2026-09-10T09:00:00Z") });
    server.addMessage("INBOX", { uid: 2, raw: makeEml({ messageId: "b@abc-gr.example", body: "B body" }), internalDate: d("2026-09-11T09:00:00Z") });
    server.addMessage("INBOX", { uid: 3, raw: makeEml({ messageId: "c@abc-gr.example", body: "C body" }), internalDate: d("2026-09-12T09:00:00Z") });
    env.ingest.inputs.length = 0;
    server.calls.length = 0;

    const r = await syncMailboxOnce(env.deps, env.mailboxId);
    expect(r).toMatchObject({ ok: true, fullCycle: true });

    const locs = await t.db.select().from(s.messageLocations);
    expect(locs.filter((l) => l.folderId === inbox.id)).toEqual([]);
    expect(locs.filter((l) => l.folderId === other.id)).toHaveLength(1);

    expect(env.ingest.uidsFor(inbox.id)).toEqual([1, 2, 3]);
    expect(sourceFetchUids()).toEqual([3]);
    const bodies = env.ingest.inputs.map((i) => (i.source as { raw: Buffer }).raw.toString("utf8"));
    expect(bodies[0]).not.toContain("A body");
    expect(bodies[2]).toContain("C body");
    expect(env.server.callsOf("search")).toHaveLength(1);
    expect(await folderByPath(env, "INBOX")).toMatchObject({ uidValidity: 7777, lastSeenUid: 3, firstSyncDone: true });
  });
});

describe("syncMailboxOnce — folder list", () => {
  it("marks vanished folders gone, revives them, and never overwrites user choices", async () => {
    await syncMailboxOnce(env.deps, env.mailboxId);
    const clients = await folderByPath(env, "INBOX.Πελάτες");
    await env.t.db.update(s.mailboxFolders).set({ role: "archive", roleSource: "user", syncEnabled: false }).where(eq(s.mailboxFolders.id, clients.id));
    const spam = await folderByPath(env, "INBOX.spam");
    await env.t.db.update(s.mailboxFolders).set({ syncEnabled: false }).where(eq(s.mailboxFolders.id, spam.id));

    const sent = env.server.folders.get("INBOX.Sent")!;
    env.server.folders.delete("INBOX.Sent");
    env.server.addFolder("INBOX.Νέος", { flags: ["\\HasNoChildren"] });
    env.server.calls.length = 0;
    await syncMailboxOnce(env.deps, env.mailboxId);

    expect((await folderByPath(env, "INBOX.Sent")).goneAt).toEqual(NOW);
    expect(await folderByPath(env, "INBOX.Πελάτες")).toMatchObject({ role: "archive", roleSource: "user", syncEnabled: false });
    expect(await folderByPath(env, "INBOX.spam")).toMatchObject({ syncEnabled: false });
    expect(await folderByPath(env, "INBOX.Νέος")).toMatchObject({ role: "other", syncEnabled: true, goneAt: null });
    const touched = [...env.server.callsOf("mailboxOpen"), ...env.server.callsOf("status")].map((c) => c.args[0]);
    expect(touched).not.toContain("INBOX.Sent");
    expect(touched).not.toContain("INBOX.Πελάτες");
    expect(touched).not.toContain("INBOX.spam");

    // The folder comes back: revived with its state
    env.server.folders.set("INBOX.Sent", sent);
    await syncMailboxOnce(env.deps, env.mailboxId);
    expect(await folderByPath(env, "INBOX.Sent")).toMatchObject({ goneAt: null, firstSyncDone: true, uidValidity: 2000 });
  });

  it("an empty LIST marks nothing gone", async () => {
    await syncMailboxOnce(env.deps, env.mailboxId);
    env.server.folders.clear();
    const r = await syncMailboxOnce(env.deps, env.mailboxId);
    expect(r).toMatchObject({ ok: false, errorKind: "protocol" });
    const rows = await env.t.db.select().from(s.mailboxFolders).where(eq(s.mailboxFolders.mailboxId, env.mailboxId));
    expect(rows.every((f) => f.goneAt === null)).toBe(true);
  });
});

describe("syncMailboxOnce — large messages", () => {
  it("fetches headers + text parts only and keeps attachment names/types", async () => {
    env.deps.config = { ...env.deps.config, MAX_FETCH_BYTES: 10_000 };
    const header = Buffer.from(
      [
        "From: =?UTF-8?B?zqDOtc67zqzPhM63z4I=?= <client@abc-gr.example>",
        "To: owner@contoso.example",
        "Subject: =?UTF-8?B?zqDPgc6/z4PPhs6/z4HOrA==?=",
        "Date: Mon, 21 Sep 2026 09:00:00 +0000",
        "Message-ID: <big@abc-gr.example>",
        "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="orig"',
        "",
        "",
      ].join("\r\n"),
      "latin1",
    );
    // Greek plain text in ISO-8859-7, quoted-printable; HTML in UTF-8 base64.
    const plainQp = Buffer.from("Σας επισυνάπτω την προσφορά.", "utf8");
    const iso = Buffer.from([...plainQp.toString("utf8")].map((ch) => (ch.charCodeAt(0) < 128 ? ch.charCodeAt(0) : ch.charCodeAt(0) - 0x2d0)));
    const qp = [...iso].map((b) => (b < 128 && b !== 61 ? String.fromCharCode(b) : `=${b.toString(16).toUpperCase().padStart(2, "0")}`)).join("");
    const html = Buffer.from("<p>Σας επισυνάπτω την <b>προσφορά</b>.</p>", "utf8").toString("base64");
    env.server.addMessage("INBOX", {
      uid: 2,
      raw: header,
      size: 48_000_000,
      internalDate: d("2026-09-21T09:00:00Z"),
      bodyStructure: {
        type: "multipart/mixed",
        childNodes: [
          {
            part: "1",
            type: "multipart/alternative",
            childNodes: [
              { part: "1.1", type: "text/plain", parameters: { charset: "iso-8859-7" }, encoding: "quoted-printable", size: qp.length },
              { part: "1.2", type: "text/html", parameters: { charset: "utf-8" }, encoding: "base64", size: html.length },
            ],
          },
          {
            part: "2",
            type: "application/pdf",
            parameters: { name: "Prosfora_ABC.pdf" },
            encoding: "base64",
            size: 47_000_000,
            disposition: "attachment",
            dispositionParameters: { filename: "Prosfora_ABC.pdf" },
          },
          { part: "3", type: "image/png", encoding: "base64", size: 900_000, disposition: "attachment", dispositionParameters: { filename: "Σχέδιο.png" } },
        ],
      },
      parts: { "1.1": Buffer.from(qp, "latin1"), "1.2": Buffer.from(html, "latin1") },
    });

    const r = await syncMailboxOnce(env.deps, env.mailboxId);
    expect(r).toMatchObject({ ok: true, newMessages: 1 });
    expect(sourceFetchUids()).toEqual([]);
    const raw = (env.ingest.inputs[0]!.source as { raw: Buffer }).raw;
    expect(raw.length).toBeLessThan(10_000);

    const parsed = await simpleParser(raw);
    expect(parsed.subject).toBe("Προσφορά");
    expect(parsed.messageId).toBe("<big@abc-gr.example>");
    expect(parsed.text?.trim()).toBe("Σας επισυνάπτω την προσφορά.");
    expect(parsed.html).toContain("<b>προσφορά</b>");
    expect(parsed.attachments.map((a) => [a.filename, a.contentType])).toEqual([
      ["Prosfora_ABC.pdf", "application/pdf"],
      ["Σχέδιο.png", "image/png"],
    ]);
    expect(parsed.headers.get("x-mailme-partial")).toBe("large-message");
    expect(env.server.violations).toEqual([]);
  });
});

describe("syncMailboxOnce — connection failures", () => {
  it("AUTHENTICATIONFAILED sets auth_failed with a reason for the owner and stops all further logins", async () => {
    env.server.connectError = Object.assign(new Error("Authentication failed"), { authenticationFailed: true, serverResponseCode: "AUTHENTICATIONFAILED" });
    const r = await syncMailboxOnce(env.deps, env.mailboxId);
    expect(r).toMatchObject({ ok: false, errorKind: "auth", fullCycle: false });
    const mb = await mailboxRow(env);
    expect(mb).toMatchObject({ status: "auth_failed", statusReason: AUTH_FAILED_REASON, nextAttemptAt: null, consecutiveFailures: 1 });
    expect(mb.statusReason).toMatch(/password/);
    expect((await loginAttempts(env)).map((a) => [a.purpose, a.outcome, a.detail])).toEqual([["sync", "auth_failed", "AUTHENTICATIONFAILED"]]);

    const again = await syncMailboxOnce(env.deps, env.mailboxId);
    expect(again.errorKind).toBe("inactive");
    expect(env.server.callsOf("connect")).toHaveLength(1);
    expect(await loginAttempts(env)).toHaveLength(1);
  });

  it("too many connections backs off at least 15 minutes and keeps the mailbox active", async () => {
    env.server.connectError = Object.assign(new Error("Authentication failed"), {
      authenticationFailed: true,
      serverResponseCode: "UNAVAILABLE",
      response: "Maximum number of connections from user+IP exceeded (mail_max_userip_connections=10)",
    });
    const r = await syncMailboxOnce(env.deps, env.mailboxId);
    expect(r.errorKind).toBe("too_many");
    const mb = await mailboxRow(env);
    expect(mb.status).toBe("active");
    expect(mb.nextAttemptAt!.getTime() - NOW.getTime()).toBeGreaterThanOrEqual(TOO_MANY_MIN_MS);
    expect((await loginAttempts(env))[0]!.outcome).toBe("too_many");

    // Before nextAttemptAt: no login at all.
    env.clock.advance(10 * 60_000);
    expect((await syncMailboxOnce(env.deps, env.mailboxId)).errorKind).toBe("backoff");
    expect(env.server.callsOf("connect")).toHaveLength(1);
  });

  it("network errors back off exponentially and a success resets the streak", async () => {
    env.server.connectError = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    await syncMailboxOnce(env.deps, env.mailboxId);
    let mb = await mailboxRow(env);
    expect(mb).toMatchObject({ status: "active", consecutiveFailures: 1 });
    expect(mb.nextAttemptAt!.getTime() - NOW.getTime()).toBe(computeBackoffMs("network", 1, () => 0.5));
    expect(mb.lastError).toMatch(/^network: /);

    env.clock.advance(60 * 60_000);
    await syncMailboxOnce(env.deps, env.mailboxId);
    mb = await mailboxRow(env);
    expect(mb.consecutiveFailures).toBe(2);
    expect(mb.nextAttemptAt!.getTime() - env.clock.now().getTime()).toBe(computeBackoffMs("network", 2, () => 0.5));

    env.clock.advance(60 * 60_000);
    env.server.connectError = null;
    const ok = await syncMailboxOnce(env.deps, env.mailboxId);
    expect(ok.ok).toBe(true);
    mb = await mailboxRow(env);
    expect(mb).toMatchObject({ consecutiveFailures: 0, nextAttemptAt: null, lastError: null });
    expect((await loginAttempts(env)).map((a) => a.outcome)).toEqual(["network", "network", "ok"]);
  });

  it("a dropped connection mid-cycle is a network failure with backoff", async () => {
    seedInbox();
    env.server.failNext.set("search", Object.assign(new Error("Connection not available"), { code: "NoConnection" }));
    const r = await syncMailboxOnce(env.deps, env.mailboxId);
    expect(r).toMatchObject({ ok: false, errorKind: "network" });
    const mb = await mailboxRow(env);
    expect(mb.consecutiveFailures).toBe(1);
    expect(mb.nextAttemptAt).not.toBeNull();
    expect(env.server.callsOf("logout")).toHaveLength(1);
  });

  it("does not log in for paused mailboxes or when the password is unavailable", async () => {
    await env.t.db.update(s.mailboxes).set({ status: "paused" }).where(eq(s.mailboxes.id, env.mailboxId));
    expect((await syncMailboxOnce(env.deps, env.mailboxId)).errorKind).toBe("inactive");
    await env.t.db.update(s.mailboxes).set({ status: "active" }).where(eq(s.mailboxes.id, env.mailboxId));
    env.deps.getPassword = async () => {
      throw new Error("no private key");
    };
    const r = await syncMailboxOnce(env.deps, env.mailboxId);
    expect(r.errorKind).toBe("credentials");
    expect(env.server.callsOf("connect")).toHaveLength(0);
    expect((await mailboxRow(env)).nextAttemptAt).not.toBeNull();
  });
});

describe("imapflow options", () => {
  it("implicit TLS, verified certificate, no protocol logging", () => {
    const o = imapFlowOptions({ host: "mail.contoso.example", port: 993, user: "u", pass: "p", mode: "short" });
    expect(o).toMatchObject({ host: "mail.contoso.example", port: 993, secure: true, servername: "mail.contoso.example", logger: false, disableAutoIdle: true });
    expect(o.tls).toMatchObject({ rejectUnauthorized: true, servername: "mail.contoso.example" });
    expect(imapFlowOptions({ host: "h", port: 993, user: "u", pass: "p", mode: "watch" }).disableAutoIdle).toBe(false);
    // SNI is never an IP literal (Node rejects it); the certificate is still verified.
    const ip = imapFlowOptions({ host: "9.9.9.9", port: 993, user: "u", pass: "p", mode: "short" });
    expect(ip.servername).toBeUndefined();
    expect(ip.tls).toMatchObject({ rejectUnauthorized: true, servername: undefined });
  });
});

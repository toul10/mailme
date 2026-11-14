import { beforeEach, describe, expect, it } from "vitest";
import type { MailboxConnectionSettings } from "../../src/domain/types.js";
import { createMailTransport, messageIdOf, MailTransportError, smtpConnectionOptions, type SmtpSession, type SmtpSessionOptions, type TransportExtras } from "../../src/mail/transport.js";
import { FakeImapServer, makeEml, READ_ONLY_METHODS } from "./fake-imap.js";

const settings: MailboxConnectionSettings = {
  mailboxId: "mb-1",
  address: "owner@contoso.example",
  imapHost: "mail.contoso.example",
  imapPort: 993,
  imapUsername: "owner@contoso.example",
  smtpHost: "mail.contoso.example",
  smtpPort: 587,
};

type Attempt = [string, string, string, string | undefined];

describe("appendToInbox", () => {
  let server: FakeImapServer;
  let attempts: Attempt[];
  const make = () => {
    const opts: { onLoginAttempt(id: string, p: "append" | "smtp", o: string, d?: string): void } & TransportExtras = {
      onLoginAttempt: (id, p, o, d) => void attempts.push([id, p, o, d]),
      imapFactory: server.factory,
    };
    return createMailTransport(opts);
  };

  beforeEach(() => {
    server = new FakeImapServer();
    server.addFolder("INBOX");
    attempts = [];
  });

  it("appends with no flags when the Message-ID is absent, then finds it on retry", async () => {
    const raw = makeEml({ messageId: "digest.u1.2026-09-24@mailme.local", subject: "Daily report" });
    const first = await make().appendToInbox(settings, "pw", raw, "<digest.u1.2026-09-24@mailme.local>");
    expect(first).toEqual({ alreadyPresent: false, uid: 1, folder: "INBOX" });
    const appends = server.callsOf("append");
    expect(appends).toHaveLength(1);
    expect(appends[0]!.args[0]).toBe("INBOX");
    expect(appends[0]!.args[2]).toEqual([]);

    const second = await make().appendToInbox(settings, "pw", raw, "<digest.u1.2026-09-24@mailme.local>");
    expect(second).toEqual({ alreadyPresent: true, uid: 1, folder: "INBOX" });
    expect(server.callsOf("append")).toHaveLength(1);

    // The search ran under a read-only EXAMINE; nothing but APPEND ever writes.
    for (const c of server.callsOf("mailboxOpen")) expect(c.args[1]).toEqual({ readOnly: true });
    expect(server.callsOf("search")[0]!.args[0]).toEqual({ header: { "message-id": "digest.u1.2026-09-24@mailme.local" } });
    for (const m of server.methodNames()) expect(READ_ONLY_METHODS.has(m) || m === "append", m).toBe(true);
    expect(attempts).toEqual([
      ["mb-1", "append", "ok", undefined],
      ["mb-1", "append", "ok", undefined],
    ]);
    expect(server.callsOf("logout")).toHaveLength(2);
  });

  it("a substring match on another Message-ID is not treated as present", async () => {
    server.addMessage("INBOX", { raw: makeEml({ messageId: "xdigest.u1.2026-09-24@mailme.local" }), internalDate: new Date() });
    const r = await make().appendToInbox(settings, "pw", makeEml({ messageId: "digest.u1.2026-09-24@mailme.local" }), "digest.u1.2026-09-24@mailme.local");
    expect(r.alreadyPresent).toBe(false);
    expect(server.callsOf("append")).toHaveLength(1);
  });

  it("classifies login failures and reports the attempt", async () => {
    server.connectError = Object.assign(new Error("Authentication failed"), { authenticationFailed: true, serverResponseCode: "AUTHENTICATIONFAILED" });
    const err = await make()
      .appendToInbox(settings, "bad", makeEml(), "<x@y>")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MailTransportError);
    expect((err as MailTransportError).kind).toBe("auth");
    expect(attempts).toEqual([["mb-1", "append", "auth_failed", "AUTHENTICATIONFAILED"]]);
    expect(server.callsOf("append")).toHaveLength(0);
  });
});

class FakeSmtp implements SmtpSession {
  static sessions: FakeSmtp[] = [];
  static behavior: (opts: SmtpSessionOptions) => { connect?: unknown; login?: unknown; send?: unknown; insecure?: boolean } = () => ({});
  sent: Array<{ envelope: { from: string; to: string[] }; raw: Buffer }> = [];
  loggedIn: [string, string] | null = null;
  closed = false;
  constructor(readonly opts: SmtpSessionOptions) {
    FakeSmtp.sessions.push(this);
  }
  get secure() {
    return !FakeSmtp.behavior(this.opts).insecure;
  }
  async connect() {
    const b = FakeSmtp.behavior(this.opts);
    if (b.connect) throw b.connect;
  }
  async login(user: string, pass: string) {
    const b = FakeSmtp.behavior(this.opts);
    if (b.login) throw b.login;
    this.loggedIn = [user, pass];
  }
  async send(envelope: { from: string; to: string[] }, raw: Buffer) {
    const b = FakeSmtp.behavior(this.opts);
    if (b.send) throw b.send;
    this.sent.push({ envelope, raw });
    return { accepted: envelope.to, rejected: [] };
  }
  close() {
    this.closed = true;
  }
}

describe("sendSmtp", () => {
  let attempts: Attempt[];
  const make = () => {
    const opts: { onLoginAttempt(id: string, p: "append" | "smtp", o: string, d?: string): void } & TransportExtras = {
      onLoginAttempt: (id, p, o, d) => void attempts.push([id, p, o, d]),
      smtpFactory: (o) => new FakeSmtp(o),
    };
    return createMailTransport(opts);
  };
  const raw = makeEml({ messageId: "digest.u1.2026-09-24@mailme.local" });
  const envelope = { from: "owner@contoso.example", to: ["owner@contoso.example"] };

  beforeEach(() => {
    FakeSmtp.sessions = [];
    FakeSmtp.behavior = () => ({});
    attempts = [];
  });

  it("submits on 587 with STARTTLS required and the mailbox account", async () => {
    const r = await make().sendSmtp(settings, "pw", raw, envelope);
    expect(r).toEqual({ messageId: "digest.u1.2026-09-24@mailme.local" });
    expect(FakeSmtp.sessions.map((s) => [s.opts.port, s.opts.implicitTls])).toEqual([[587, false]]);
    expect(FakeSmtp.sessions[0]!.loggedIn).toEqual(["owner@contoso.example", "pw"]);
    expect(FakeSmtp.sessions[0]!.sent[0]!.envelope).toEqual(envelope);
    expect(FakeSmtp.sessions[0]!.closed).toBe(true);
    expect(attempts).toEqual([["mb-1", "smtp", "ok", undefined]]);
  });

  it("falls back to 465 when 587 cannot be reached", async () => {
    FakeSmtp.behavior = (o) => (o.port === 587 ? { connect: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNECTION", command: "CONN" }) } : {});
    await make().sendSmtp(settings, "pw", raw, envelope);
    expect(FakeSmtp.sessions.map((s) => [s.opts.port, s.opts.implicitTls])).toEqual([
      [587, false],
      [465, true],
    ]);
    expect(FakeSmtp.sessions[1]!.sent).toHaveLength(1);
    expect(attempts.map((a) => a[2])).toEqual(["network", "ok"]);
  });

  it("falls back when 587 offers no STARTTLS, never sends in the clear", async () => {
    FakeSmtp.behavior = (o) => (o.port === 587 ? { insecure: true } : {});
    await make().sendSmtp(settings, "pw", raw, envelope);
    expect(FakeSmtp.sessions[0]!.loggedIn).toBeNull();
    expect(FakeSmtp.sessions[1]!.sent).toHaveLength(1);
  });

  it("never falls back after AUTH or DATA started (no double send)", async () => {
    FakeSmtp.behavior = () => ({ login: Object.assign(new Error("Invalid login: 535"), { code: "EAUTH", responseCode: 535 }) });
    const e1 = await make()
      .sendSmtp(settings, "pw", raw, envelope)
      .catch((e: unknown) => e);
    expect((e1 as MailTransportError).kind).toBe("auth");
    expect(FakeSmtp.sessions).toHaveLength(1);
    expect(attempts.map((a) => a[2])).toEqual(["auth_failed"]);

    FakeSmtp.sessions = [];
    FakeSmtp.behavior = () => ({ send: Object.assign(new Error("Connection closed unexpectedly"), { code: "ECONNECTION", command: "CONN" }) });
    const e2 = await make()
      .sendSmtp(settings, "pw", raw, envelope)
      .catch((e: unknown) => e);
    expect((e2 as MailTransportError).kind).toBe("network");
    expect(FakeSmtp.sessions).toHaveLength(1);
  });

  it("nodemailer options: verified TLS, STARTTLS required, no logging", () => {
    const o = smtpConnectionOptions({ host: "mail.contoso.example", port: 587, implicitTls: false });
    expect(o).toMatchObject({ port: 587, secure: false, requireTLS: true, ignoreTLS: false, logger: false, debug: false });
    expect(o.tls).toMatchObject({ rejectUnauthorized: true, servername: "mail.contoso.example" });
    expect(smtpConnectionOptions({ host: "h", port: 465, implicitTls: true })).toMatchObject({ secure: true, requireTLS: false });
  });

  it("messageIdOf reads the header without brackets", () => {
    expect(messageIdOf(Buffer.from("Subject: x\r\nMessage-ID:\r\n <a.b@c>\r\n\r\nMessage-ID: <no@body>\r\n"))).toBe("a.b@c");
    expect(messageIdOf(Buffer.from("Subject: x\r\n\r\n"))).toBeNull();
  });
});

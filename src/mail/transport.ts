import { isIP } from "node:net";
import SMTPConnection from "nodemailer/lib/smtp-connection";
import type { AppendResult, MailboxConnectionSettings, MailTransport } from "../domain/types.js";
import { createImapFlowClient, safeLogout, stripMessageId, toSequenceSet, type ImapClientFactory } from "./imap/client.js";
import { classifyImapError, errorCode, ImapOperationError, loginOutcomeFor, type ImapErrorKind } from "./imap/errors.js";

type LoginAttemptHook = (mailboxId: string, purpose: "append" | "smtp", outcome: string, detail?: string) => void;

/** One SMTP submission session (connect → STARTTLS/TLS → AUTH → send). */
export interface SmtpSession {
  /** Resolves once the greeting, EHLO and (STARTTLS) handshake are done. */
  connect(): Promise<void>;
  /** True when the channel is TLS-protected (implicit TLS or completed STARTTLS). */
  readonly secure: boolean;
  login(user: string, pass: string): Promise<void>;
  send(envelope: { from: string; to: string[] }, raw: Buffer): Promise<{ accepted: string[]; rejected: string[] }>;
  close(): void;
}

export interface SmtpSessionOptions {
  host: string;
  port: number;
  /** true = implicit TLS (465); false = STARTTLS required (587). */
  implicitTls: boolean;
}

export type SmtpSessionFactory = (opts: SmtpSessionOptions) => SmtpSession;

/** Optional extras (tests inject fakes); pass them on the options object. */
export interface TransportExtras {
  imapFactory?: ImapClientFactory;
  smtpFactory?: SmtpSessionFactory;
}

/** Thrown by the transport; `kind` decides the caller's retry policy. The message never contains mail content. */
export class MailTransportError extends ImapOperationError {
  constructor(kind: ImapErrorKind, message: string, code: string | null = null) {
    super(kind, message, code);
    this.name = "MailTransportError";
  }
}

/** nodemailer SMTPConnection options: verified TLS, no plaintext, no protocol logging. */
export function smtpConnectionOptions(opts: SmtpSessionOptions) {
  const sni = isIP(opts.host) === 0 ? opts.host : undefined;
  return {
    host: opts.host,
    port: opts.port,
    secure: opts.implicitTls,
    requireTLS: !opts.implicitTls,
    ignoreTLS: false,
    opportunisticTLS: false,
    servername: sni,
    tls: { rejectUnauthorized: true, servername: sni, minVersion: "TLSv1.2" as const },
    connectionTimeout: 30_000,
    greetingTimeout: 30_000,
    socketTimeout: 60_000,
    logger: false,
    debug: false,
    transactionLog: false,
  };
}

/** nodemailer's low-level SMTPConnection, so the caller knows exactly which stage failed. */
export const createNodemailerSession: SmtpSessionFactory = (opts) => {
  const conn = new SMTPConnection(smtpConnectionOptions(opts));
  let failure: ((err: Error) => void) | null = null;
  let lastError: Error | null = null;
  conn.on("error", (err: Error) => {
    lastError = err;
    failure?.(err);
  });
  conn.on("end", () => {
    const err = Object.assign(new Error("Connection closed unexpectedly"), { code: "ECONNECTION", command: "CONN" });
    failure?.(err);
  });
  /** Run one callback-style step; an 'error'/'end' event rejects it too. */
  const step = <T>(run: (done: (err: Error | null, v?: T) => void) => void): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (lastError) return reject(lastError);
      let settled = false;
      const finish = (err: Error | null, v?: T) => {
        if (settled) return;
        settled = true;
        failure = null;
        if (err) reject(err);
        else resolve(v as T);
      };
      failure = (err) => finish(err);
      run(finish);
    });
  return {
    connect: () => step<void>((done) => conn.connect(() => done(null))),
    get secure() {
      return conn.secure === true;
    },
    login: (user, pass) => step<void>((done) => conn.login({ user, pass }, (err) => done(err))),
    send: (envelope, raw) =>
      step((done) =>
        conn.send(envelope, raw, (err, info) => done(err, { accepted: info?.accepted ?? [], rejected: info?.rejected ?? [] })),
      ),
    close: () => {
      try {
        conn.quit();
      } catch {
        // ignore
      }
      conn.close();
    },
  };
};

/** Message-ID header of a raw message (without <>), or null. */
export function messageIdOf(raw: Buffer): string | null {
  const head = raw.subarray(0, Math.min(raw.length, 64 * 1024)).toString("latin1").split(/\r?\n\r?\n/, 1)[0] ?? "";
  const m = /^message-id:[ \t]*((?:.*)(?:\r?\n[ \t].*)*)/im.exec(head);
  const id = m ? stripMessageId(m[1]!.replace(/\r?\n[ \t]+/g, " ")) : "";
  return id || null;
}

/** IMAP APPEND (idempotent via Message-ID search) + SMTP submission (587 STARTTLS / 465, verified TLS). */
export function createMailTransport(opts: { onLoginAttempt?(mailboxId: string, purpose: "append" | "smtp", outcome: string, detail?: string): void } = {}): MailTransport {
  const ex = opts as typeof opts & TransportExtras;
  const imapFactory = ex.imapFactory ?? createImapFlowClient;
  const smtpFactory = ex.smtpFactory ?? createNodemailerSession;
  const report: LoginAttemptHook = (mailboxId, purpose, outcome, detail) => {
    try {
      opts.onLoginAttempt?.(mailboxId, purpose, outcome, detail);
    } catch {
      // recording must never break delivery
    }
  };

  return {
    /**
     * Short-lived connection: EXAMINE INBOX → SEARCH HEADER Message-ID (verified against the envelope) →
     * APPEND with no flags (arrives unread) only if absent. A retry therefore never duplicates the digest.
     */
    async appendToInbox(settings: MailboxConnectionSettings, password: string, raw: Buffer, messageIdHeader: string): Promise<AppendResult> {
      const wanted = stripMessageId(messageIdHeader);
      if (!wanted) throw new MailTransportError("other", "messageIdHeader is required for an idempotent APPEND");
      const client = imapFactory({ host: settings.imapHost, port: settings.imapPort, user: settings.imapUsername, pass: password, mode: "short" });
      try {
        await client.connect();
      } catch (err) {
        const c = classifyImapError(err);
        report(settings.mailboxId, "append", loginOutcomeFor(c.kind), errorCode(err) ?? undefined);
        try {
          client.close();
        } catch {
          // not connected
        }
        throw new MailTransportError(c.kind, c.message, errorCode(err));
      }
      report(settings.mailboxId, "append", "ok");
      try {
        const folder = "INBOX";
        await client.mailboxOpen(folder, { readOnly: true });
        const found = await client.search({ header: { "message-id": wanted } }, { uid: true });
        if (Array.isArray(found) && found.length > 0) {
          // SEARCH HEADER is a substring match: confirm the exact id before treating it as ours.
          const metas = await client.fetchAll(toSequenceSet(found), { uid: true, envelope: true }, { uid: true });
          const hit = metas.find((m) => stripMessageId(m.envelope?.messageId).toLowerCase() === wanted.toLowerCase());
          if (hit) return { alreadyPresent: true, uid: hit.uid, folder };
        }
        const res = await client.append(folder, raw, []);
        return { alreadyPresent: false, uid: res && typeof res.uid === "number" ? res.uid : null, folder: res ? res.destination || folder : folder };
      } catch (err) {
        if (err instanceof MailTransportError) throw err;
        const c = classifyImapError(err);
        throw new MailTransportError(c.kind, c.message, errorCode(err));
      } finally {
        await safeLogout(client);
      }
    },

    /**
     * SMTP submission with the mailbox's own account: 587 + STARTTLS (required) with a verified certificate;
     * if 587 cannot be reached or does not offer STARTTLS, 465 with implicit TLS. The fallback happens only when
     * the *connection* failed — never after AUTH or DATA started, so a message is never sent twice.
     */
    async sendSmtp(settings: MailboxConnectionSettings, password: string, raw: Buffer, envelope: { from: string; to: string[] }): Promise<{ messageId: string }> {
      const host = settings.smtpHost || settings.imapHost;
      const port = settings.smtpPort ?? 587;
      const attempts: SmtpSessionOptions[] = [{ host, port, implicitTls: port === 465 }];
      if (port === 587) attempts.push({ host, port: 465, implicitTls: true });

      let lastErr: unknown = null;
      for (let i = 0; i < attempts.length; i++) {
        const target = attempts[i]!;
        const session = smtpFactory(target);
        let stage: "connect" | "auth" | "send" = "connect";
        try {
          await session.connect();
          if (!session.secure) throw Object.assign(new Error("SMTP channel is not encrypted"), { code: "ETLS" });
          stage = "auth";
          await session.login(settings.imapUsername, password);
          report(settings.mailboxId, "smtp", "ok");
          stage = "send";
          const info = await session.send({ from: envelope.from, to: envelope.to }, raw);
          if (info.accepted.length === 0) throw Object.assign(new Error("No recipient accepted"), { code: "EENVELOPE" });
          return { messageId: messageIdOf(raw) ?? "" };
        } catch (err) {
          lastErr = err;
          const c = classifyImapError(err);
          if (stage !== "send") report(settings.mailboxId, "smtp", loginOutcomeFor(c.kind), errorCode(err) ?? undefined);
          const canFallBack = stage === "connect" && (c.kind === "network" || c.kind === "tls") && errorCode(err) !== "EDNS" && i + 1 < attempts.length;
          if (!canFallBack) throw new MailTransportError(c.kind, c.message, errorCode(err));
        } finally {
          session.close();
        }
      }
      const c = classifyImapError(lastErr);
      throw new MailTransportError(c.kind, c.message, errorCode(lastErr));
    },
  };
}

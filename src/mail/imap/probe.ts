import type { Db } from "../../db/client.js";
import type { Clock, Logger, MailboxConnectionSettings } from "../../domain/types.js";
import { createImapFlowClient, safeLogout, type ImapClientFactory } from "./client.js";
import { classifyImapError, errorCode, loginOutcomeFor, type ImapErrorKind } from "./errors.js";
import type { ListedFolder } from "./folders.js";
import { classifyFolder, isSelectableFolder, toListedFolder } from "./folders.js";
import { loginAttemptRecorder } from "./store.js";

export interface ProbeResult {
  ok: boolean;
  errorKind: string | null;
  error: string | null;
  capabilities: string[];
  delimiter: string | null;
  folders: Array<ListedFolder & { role: string; roleSource: string; messages: number | null }>;
  quota: { usedKb: number; limitKb: number } | null;
}

/** User-facing (setup screen). `errorKind` carries the machine code. */
const PROBE_ERRORS: Record<ImapErrorKind | "rate_limited", string> = {
  auth: "Wrong username or password.",
  network: "Couldn't connect to the mail server (a network problem, or the wrong address or port).",
  tls: "The server's TLS certificate couldn't be verified. The connection was stopped for security.",
  too_many: "The server refused the connection: too many connections at once. Try again in 15 minutes.",
  protocol: "The IMAP server replied with an error.",
  other: "Unknown error while connecting over IMAP.",
  rate_limited: "Too many sign-in attempts in a short time. Wait a few minutes before you try again (this keeps the account from being locked).",
};

/**
 * Per-mailbox probe budget (the host bans the IP after ~5 failed logins, which would also cut off the
 * user's Outlook). At most one probe per `minIntervalMs`, and after `maxAuthFailures` rejected passwords within
 * `windowMs` no further probe until the window has passed. In-memory: one API process.
 */
export class ProbeLimiter {
  private readonly last = new Map<string, number>();
  private readonly authFailures = new Map<string, number[]>();

  constructor(
    private readonly minIntervalMs = 20_000,
    private readonly maxAuthFailures = 3,
    private readonly windowMs = 15 * 60_000,
  ) {}

  /** null = allowed. */
  check(key: string, nowMs: number): "rate_limited" | null {
    const last = this.last.get(key);
    if (last !== undefined && nowMs - last < this.minIntervalMs) return "rate_limited";
    const fails = (this.authFailures.get(key) ?? []).filter((t) => nowMs - t < this.windowMs);
    this.authFailures.set(key, fails);
    return fails.length >= this.maxAuthFailures ? "rate_limited" : null;
  }

  record(key: string, kind: ImapErrorKind | "ok", nowMs: number): void {
    this.last.set(key, nowMs);
    if (kind === "auth") this.authFailures.set(key, [...(this.authFailures.get(key) ?? []), nowMs]);
    if (kind === "ok") this.authFailures.delete(key);
  }
}

const defaultLimiter = new ProbeLimiter();

export interface ProbeOptions {
  imapFactory?: ImapClientFactory;
  /** Called once per login attempt (record it in mailbox_login_attempts). */
  onLoginAttempt?(mailboxId: string, purpose: "probe", outcome: string, detail?: string): void;
  /** null disables rate limiting (tests, CLI). Default: a process-wide limiter. */
  limiter?: ProbeLimiter | null;
  now?: () => number;
}

const emptyResult = (errorKind: ImapErrorKind | "rate_limited"): ProbeResult => ({
  ok: false,
  errorKind,
  error: PROBE_ERRORS[errorKind],
  capabilities: [],
  delimiter: null,
  folders: [],
  quota: null,
});

/** One rate-limited login: CAPABILITY, LIST with flags, STATUS counts, GETQUOTAROOT if advertised. Read-only. */
export async function probeMailbox(settings: MailboxConnectionSettings, password: string): Promise<ProbeResult> {
  return probeMailboxWith(settings, password, {});
}

/** probeMailbox with injectable client factory, login-attempt hook and limiter. */
export async function probeMailboxWith(settings: MailboxConnectionSettings, password: string, opts: ProbeOptions): Promise<ProbeResult> {
  const limiter = opts.limiter === undefined ? defaultLimiter : opts.limiter;
  const now = opts.now ?? Date.now;
  const key = `${settings.mailboxId}|${settings.imapHost}|${settings.imapUsername}`;
  if (limiter?.check(key, now())) return emptyResult("rate_limited");

  const factory = opts.imapFactory ?? createImapFlowClient;
  const client = factory({ host: settings.imapHost, port: settings.imapPort, user: settings.imapUsername, pass: password, mode: "short" });
  try {
    await client.connect();
  } catch (err) {
    const c = classifyImapError(err);
    limiter?.record(key, c.kind, now());
    opts.onLoginAttempt?.(settings.mailboxId, "probe", loginOutcomeFor(c.kind), errorCode(err) ?? undefined);
    try {
      client.close();
    } catch {
      // not connected
    }
    return emptyResult(c.kind);
  }
  limiter?.record(key, "ok", now());
  opts.onLoginAttempt?.(settings.mailboxId, "probe", "ok");

  const capabilities = [...client.capabilities.keys()].sort();
  try {
    const entries = await client.list({ statusQuery: { messages: true } });
    const folders = entries
      .map((e) => ({ listed: toListedFolder(e), messages: typeof e.status?.messages === "number" ? e.status.messages : null }))
      .filter((x) => isSelectableFolder(x.listed))
      .map(({ listed, messages }) => {
        const cls = classifyFolder(listed);
        return { ...listed, role: cls.role, roleSource: cls.source, messages };
      });
    const delimiter = client.namespace?.delimiter ?? entries.find((e) => e.delimiter)?.delimiter ?? null;
    let quota: ProbeResult["quota"] = null;
    if (client.capabilities.has("QUOTA")) {
      try {
        const q = await client.getQuota("INBOX");
        if (q && q.storage && typeof q.storage.used === "number" && typeof q.storage.limit === "number") {
          // imapflow reports bytes (IMAP QUOTA STORAGE is in KiB × 1024).
          quota = { usedKb: Math.round(q.storage.used / 1024), limitKb: Math.round(q.storage.limit / 1024) };
        }
      } catch {
        // quota is informational
      }
    }
    return { ok: true, errorKind: null, error: null, capabilities, delimiter, folders, quota };
  } catch (err) {
    const c = classifyImapError(err);
    return { ...emptyResult(c.kind), capabilities };
  } finally {
    await safeLogout(client);
  }
}

/** A `ServerDeps.probe` implementation that records every login attempt in mailbox_login_attempts. */
export function createRecordingProber(deps: { db: Db; clock: Clock; log?: Logger }, opts: Omit<ProbeOptions, "onLoginAttempt"> = {}) {
  const record = loginAttemptRecorder(deps.db, deps.clock, deps.log);
  return (settings: MailboxConnectionSettings, password: string): Promise<ProbeResult> =>
    probeMailboxWith(settings, password, { ...opts, onLoginAttempt: (id, purpose, outcome, detail) => record(id, purpose, outcome, detail) });
}

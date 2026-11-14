export type ImapErrorKind = "auth" | "network" | "tls" | "too_many" | "protocol" | "other";

/** Outcome values of `mailbox_login_attempts.outcome`. */
export type LoginOutcome = "ok" | "auth_failed" | "network" | "tls" | "too_many" | "protocol" | "other";

/** Fields imapflow / Node / nodemailer attach to errors. All optional; read defensively. */
interface ErrorFields {
  code?: unknown;
  message?: unknown;
  authenticationFailed?: unknown;
  tlsFailed?: unknown;
  serverResponseCode?: unknown;
  responseText?: unknown;
  responseStatus?: unknown;
  response?: unknown;
  reason?: unknown;
  command?: unknown;
  responseCode?: unknown;
  cause?: unknown;
  _err?: unknown;
}

const TOO_MANY = /too many (?:connections|simultaneous|concurrent|login|sessions|requests)|connection limit|maximum number of (?:connections|sessions)|max(?:imum)? connections|mail_max_userip_connections|\[LIMIT\]|throttl/i;

const NETWORK_CODES = new Set([
  "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EHOSTUNREACH", "ECONNREFUSED", "ENETUNREACH", "ENETDOWN", "EHOSTDOWN",
  "EPIPE", "EAI_AGAIN", "ECONNABORTED", "EADDRNOTAVAIL",
  // imapflow
  "NoConnection", "EConnectionClosed", "StateLogout", "CONNECT_TIMEOUT", "GREETING_TIMEOUT", "UPGRADE_TIMEOUT", "ETIMEOUT",
  "ClosedAfterConnectTLS", "ClosedAfterConnectText", "ProxyError",
  // nodemailer
  "ECONNECTION", "ESOCKET", "EDNS", "EPROXY",
]);

const TLS_CODES = new Set([
  "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "CERT_REVOKED", "CERT_UNTRUSTED", "CERT_REJECTED", "CERT_SIGNATURE_FAILURE",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "ERR_TLS_CERT_ALTNAME_INVALID", "HOSTNAME_MISMATCH",
  "ERR_TLS_HANDSHAKE_TIMEOUT", "ERR_SSL_WRONG_VERSION_NUMBER", "EPROTO", "STARTTLS_INJECTION", "ETLS", "EREQUIRETLS",
]);

/** Response codes on a failed LOGIN that mean "a person must fix the credentials" (RFC 5530). */
const AUTH_RESPONSE_CODES = new Set(["AUTHENTICATIONFAILED", "AUTHORIZATIONFAILED", "EXPIRED", "CONTACTADMIN", "PRIVACYREQUIRED"]);

const PROTOCOL_CODES = new Set([
  "ParserError", "InvalidResponse", "UnexpectedTag", "ResponseProcessingFailed", "LineTooLarge", "LiteralTooLarge",
  "ResponseTooLarge", "MissingServerExtension", "DownloadOverflow", "EPROTOCOL", "EENVELOPE", "EMESSAGE",
]);

function fieldsOf(err: unknown): ErrorFields {
  return typeof err === "object" && err !== null ? (err as ErrorFields) : {};
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * The error plus its wrapped causes (imapflow `_err`, standard `cause`, and `response` when it holds the original
 * error — imapflow's STATUS NotFound), outermost first.
 */
function chain(err: unknown): ErrorFields[] {
  const out: ErrorFields[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 4 && typeof cur === "object" && cur !== null; i++) {
    const f = fieldsOf(cur);
    out.push(f);
    cur = f._err ?? f.cause ?? (f.response instanceof Error ? f.response : undefined);
  }
  if (out.length === 0) out.push({ message: String(err) });
  return out;
}

/** First line, trimmed and capped: safe to store in `last_error` (never contains message content). */
function shortMessage(err: unknown): string {
  const f = fieldsOf(err);
  const raw = str(f.message) || str(f.responseText) || (typeof err === "string" ? err : "") || "unknown error";
  return raw.split(/\r?\n/)[0]!.trim().slice(0, 200);
}

/** A short machine code for logs/`detail` (never content). */
export function errorCode(err: unknown): string | null {
  for (const f of chain(err)) {
    const c = str(f.serverResponseCode) || str(f.code);
    if (c) return c.slice(0, 64);
  }
  return null;
}

/** Map imapflow / socket errors to a kind that decides retry policy. */
export function classifyImapError(err: unknown): { kind: ImapErrorKind; message: string } {
  const message = shortMessage(err);
  if (err instanceof ImapOperationError) return { kind: err.kind, message };
  const links = chain(err);
  const codes = links.flatMap((f) => [str(f.code), str(f.serverResponseCode).toUpperCase()]).filter(Boolean);
  const text = links
    .map((f) => [str(f.message), str(f.responseText), str(f.response), str(f.reason)].join(" "))
    .join(" ");

  // "Too many connections" first: Dovecot answers `NO [UNAVAILABLE] Maximum number of connections from user+IP
  // exceeded` to LOGIN, which imapflow flags as authenticationFailed. Treating it as auth would disable the mailbox.
  if (codes.includes("ETHROTTLE") || codes.includes("LIMIT") || TOO_MANY.test(text)) return { kind: "too_many", message };

  const authFlag = links.some((f) => f.authenticationFailed === true);
  const authCode = codes.some((c) => AUTH_RESPONSE_CODES.has(c) || c === "EAUTH" || c === "ENOAUTH");
  // [UNAVAILABLE] / [INUSE] on LOGIN = temporary server-side failure (auth backend down), not bad credentials.
  const temporary = codes.includes("UNAVAILABLE") || codes.includes("INUSE") || /temporary (?:authentication )?failure/i.test(text);
  if (authCode || (authFlag && !temporary)) return { kind: "auth", message };
  if (temporary) return { kind: "other", message };

  if (links.some((f) => f.tlsFailed === true) || codes.some((c) => TLS_CODES.has(c) || c.startsWith("ERR_SSL_") || c.startsWith("ERR_TLS_"))) {
    return { kind: "tls", message };
  }
  if (/certificate|self[- ]signed|unable to verify|ssl routines|tls handshake|altnames/i.test(text)) return { kind: "tls", message };

  if (codes.some((c) => NETWORK_CODES.has(c))) return { kind: "network", message };
  if (/socket (?:hang up|timeout|closed)|connection (?:closed|reset|refused|not available|timed out)|timed? ?out|getaddrinfo/i.test(text)) {
    return { kind: "network", message };
  }

  if (codes.some((c) => PROTOCOL_CODES.has(c))) return { kind: "protocol", message };
  if (links.some((f) => f.responseStatus === "NO" || f.responseStatus === "BAD" || str(f.serverResponseCode) !== "")) {
    return { kind: "protocol", message };
  }

  return { kind: "other", message };
}

/** `mailbox_login_attempts.outcome` for an error kind. */
export function loginOutcomeFor(kind: ImapErrorKind): Exclude<LoginOutcome, "ok"> {
  return kind === "auth" ? "auth_failed" : kind;
}

/** An IMAP-command failure that concerns one folder only (missing / not selectable / not permitted), not the connection. */
export function isFolderLevelError(err: unknown): boolean {
  for (const f of chain(err)) {
    if ((f as { mailboxMissing?: unknown }).mailboxMissing === true) return true;
    // imapflow: STATUS of a folder that LIST no longer shows.
    if (str(f.code) === "NotFound") return true;
    const code = str(f.serverResponseCode).toUpperCase();
    if (code === "NONEXISTENT" || code === "NOPERM" || code === "CANNOT") return true;
  }
  return false;
}

/**
 * A failed command on one folder that the rest of the cycle can survive: a folder-level error, or any other tagged
 * NO (e.g. `NO [SERVERBUG]` from a corrupt index) that is not about login, connection limits or the connection.
 * Callers apply this to non-INBOX folders only; an INBOX failure stays fatal for the cycle.
 */
export function isFolderCommandFailure(err: unknown): boolean {
  if (isFolderLevelError(err)) return true;
  if (err instanceof ImapOperationError) return false;
  if (!chain(err).some((f) => f.responseStatus === "NO")) return false;
  const kind = classifyImapError(err).kind;
  return kind === "protocol" || kind === "other";
}

const MINUTE = 60_000;
export const BACKOFF_BASE_MS = 30_000;
export const BACKOFF_MAX_MS = 30 * MINUTE;
export const TOO_MANY_MIN_MS = 15 * MINUTE;

/**
 * Delay before the next connection attempt after `failures` consecutive failures (≥ 1).
 * Exponential with "equal jitter", capped at 30 min; "too many connections" waits at least 15 min.
 * Auth failures never retry automatically — callers must not schedule them.
 */
export function computeBackoffMs(kind: ImapErrorKind, failures: number, random: () => number = Math.random): number {
  const n = Math.max(1, Math.floor(failures));
  const exp = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(n - 1, 20));
  const jittered = exp / 2 + random() * (exp / 2);
  if (kind === "too_many") return Math.min(BACKOFF_MAX_MS, Math.max(TOO_MANY_MIN_MS + random() * 5 * MINUTE, jittered));
  return Math.min(BACKOFF_MAX_MS, Math.max(1_000, jittered));
}

/** Error thrown by the transport / helpers after classification. The message never contains mail content. */
export class ImapOperationError extends Error {
  constructor(
    readonly kind: ImapErrorKind,
    message: string,
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = "ImapOperationError";
  }
}

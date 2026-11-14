import { describe, expect, it } from "vitest";
import { AuthenticationFailure } from "imapflow";
import { BACKOFF_MAX_MS, classifyImapError, computeBackoffMs, isFolderLevelError, loginOutcomeFor, TOO_MANY_MIN_MS } from "../../src/mail/imap/errors.js";

const withProps = (message: string, props: Record<string, unknown>) => Object.assign(new Error(message), props);

describe("classifyImapError", () => {
  it("AUTHENTICATIONFAILED is auth", () => {
    const err = Object.assign(new AuthenticationFailure("Authentication failed"), { serverResponseCode: "AUTHENTICATIONFAILED", response: "Authentication failed." });
    expect(classifyImapError(err).kind).toBe("auth");
    expect(classifyImapError(withProps("Command failed", { authenticationFailed: true })).kind).toBe("auth");
    expect(classifyImapError(withProps("x", { serverResponseCode: "AUTHORIZATIONFAILED" })).kind).toBe("auth");
    expect(classifyImapError(withProps("Invalid login", { code: "EAUTH", responseCode: 535 })).kind).toBe("auth");
  });

  it("Dovecot's per-user+IP connection limit on LOGIN is too_many, never auth", () => {
    const err = withProps("Authentication failed", {
      authenticationFailed: true,
      serverResponseCode: "UNAVAILABLE",
      response: "Maximum number of connections from user+IP exceeded (mail_max_userip_connections=10)",
    });
    expect(classifyImapError(err).kind).toBe("too_many");
    expect(classifyImapError(withProps("Too many connections", {})).kind).toBe("too_many");
    expect(classifyImapError(withProps("Request is throttled", { code: "ETHROTTLE" })).kind).toBe("too_many");
    expect(classifyImapError(withProps("421 too many concurrent SMTP connections", { code: "ECONNECTION" })).kind).toBe("too_many");
  });

  it("a temporary authentication failure is retried, not auth", () => {
    const err = withProps("Authentication failed", { authenticationFailed: true, serverResponseCode: "UNAVAILABLE", response: "Temporary authentication failure. [host:2026-09-24]" });
    expect(classifyImapError(err).kind).toBe("other");
  });

  it("socket errors are network", () => {
    for (const code of ["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EHOSTUNREACH", "ECONNREFUSED", "NoConnection", "CONNECT_TIMEOUT", "ETIMEOUT", "ECONNECTION"]) {
      expect(classifyImapError(withProps("boom", { code })).kind, code).toBe("network");
    }
    expect(classifyImapError(withProps("Connection not available", {})).kind).toBe("network");
    // imapflow wraps the socket error
    expect(classifyImapError(withProps("Failed", { _err: withProps("read ECONNRESET", { code: "ECONNRESET" }) })).kind).toBe("network");
  });

  it("certificate errors are tls", () => {
    for (const code of ["CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "ERR_TLS_CERT_ALTNAME_INVALID", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "SELF_SIGNED_CERT_IN_CHAIN", "ETLS"]) {
      expect(classifyImapError(withProps("x", { code })).kind, code).toBe("tls");
    }
    expect(classifyImapError(withProps("Hostname/IP does not match certificate's altnames", {})).kind).toBe("tls");
    expect(classifyImapError(withProps("upgrade failed", { tlsFailed: true })).kind).toBe("tls");
  });

  it("NO/BAD command responses are protocol; unknown errors other", () => {
    expect(classifyImapError(withProps("Command failed", { responseStatus: "NO", serverResponseCode: "NONEXISTENT" })).kind).toBe("protocol");
    expect(classifyImapError(withProps("bad", { code: "ParserError" })).kind).toBe("protocol");
    expect(classifyImapError(new TypeError("x is undefined")).kind).toBe("other");
    expect(classifyImapError("weird").kind).toBe("other");
  });

  it("messages are single-line and capped", () => {
    const { message } = classifyImapError(new Error(`first line ${"x".repeat(500)}\nsecond line`));
    expect(message).not.toContain("\n");
    expect(message.length).toBeLessThanOrEqual(200);
  });

  it("maps kinds to login outcomes and detects folder-level errors", () => {
    expect(loginOutcomeFor("auth")).toBe("auth_failed");
    expect(loginOutcomeFor("too_many")).toBe("too_many");
    expect(isFolderLevelError(withProps("x", { mailboxMissing: true }))).toBe(true);
    expect(isFolderLevelError(withProps("x", { serverResponseCode: "NONEXISTENT" }))).toBe(true);
    expect(isFolderLevelError(withProps("x", { code: "ECONNRESET" }))).toBe(false);
  });
});

describe("computeBackoffMs", () => {
  it("grows exponentially with jitter and caps at 30 min", () => {
    const hi = () => 1;
    expect(computeBackoffMs("network", 1, hi)).toBe(30_000);
    expect(computeBackoffMs("network", 2, hi)).toBe(60_000);
    expect(computeBackoffMs("network", 3, hi)).toBe(120_000);
    expect(computeBackoffMs("network", 50, hi)).toBe(BACKOFF_MAX_MS);
    // equal jitter: between half and the full exponential delay
    expect(computeBackoffMs("network", 3, () => 0)).toBe(60_000);
  });

  it("too_many waits at least 15 minutes and never more than 30", () => {
    for (const r of [0, 0.5, 1]) {
      for (const n of [1, 3, 20]) {
        const ms = computeBackoffMs("too_many", n, () => r);
        expect(ms).toBeGreaterThanOrEqual(TOO_MANY_MIN_MS);
        expect(ms).toBeLessThanOrEqual(BACKOFF_MAX_MS);
      }
    }
  });
});

import type { MailboxConnectionSettings } from "../domain/types.js";
import { probeMailboxWith, type ProbeOptions, type ProbeResult } from "../mail/imap/probe.js";

/**
 * `ServerDeps.probe` for the API process. It does NOT record login attempts: the credentials route records each
 * real login itself, synchronously, in mailbox_login_attempts — once — so that the host-wide login budget
 * (login-budget.ts) sees it on the very next request. (A recording prober on top would count every login twice and
 * write asynchronously.) Options exist for tests: an IMAP client factory, the in-process limiter and its clock.
 */
export function apiProber(opts: Omit<ProbeOptions, "onLoginAttempt"> = {}) {
  return (settings: MailboxConnectionSettings, password: string): Promise<ProbeResult> => probeMailboxWith(settings, password, { ...opts });
}

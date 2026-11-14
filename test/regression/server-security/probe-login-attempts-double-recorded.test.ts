import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loginBudgetProblem } from "../../../src/cli/commands/mailbox.js";
import * as s from "../../../src/db/schema.js";
import type { ImapClientFactory, ImapClientLike } from "../../../src/mail/imap/client.js";
import { ProbeLimiter } from "../../../src/mail/imap/probe.js";
import type { MailboxSummary } from "../../../src/server/api-types.js";
import { apiProber } from "../../../src/server/probe.js";
import { FakeImapServer } from "../../imap/fake-imap.js";
import { api, makeHarness, sessionFor, type Harness, type Session } from "../../server/helpers.js";

/**
 * Also covers the duplicate finding probe-login-double-recorded (seams): one web probe = one mailbox_login_attempts
 * row. The fix wires a non-recording prober in production (src/server/main.ts → apiProber) and keeps the route's
 * single, synchronous insert; the repros injected createRecordingProber (the pre-fix production wiring), so these
 * tests use apiProber — the wiring main.ts now uses.
 */

/** Fake IMAP server that rejects every LOGIN; counts real login attempts. */
function rejectingServer() {
  const logins: string[] = [];
  const factory: ImapClientFactory = (o) =>
    ({
      capabilities: new Map(),
      namespace: undefined,
      connect: async () => {
        logins.push(o.user);
        throw Object.assign(new Error("[AUTHENTICATIONFAILED] Invalid credentials"), { authenticationFailed: true, serverResponseCode: "AUTHENTICATIONFAILED" });
      },
      close: () => undefined,
      logout: async () => undefined,
    }) as unknown as ImapClientLike;
  return { logins, factory };
}

const settle = () => new Promise((r) => setTimeout(r, 150));

describe("probe-login-attempts-double-recorded", () => {
  let h: Harness;
  let me: Session;
  beforeEach(async () => {
    h = await makeHarness();
    me = await sessionFor(h, h.seed.user.id);
  });
  afterEach(async () => {
    await h.close();
  });

  async function attempts(mailboxId = h.seed.mailbox.id) {
    return h.t.db.select().from(s.mailboxLoginAttempts).where(eq(s.mailboxLoginAttempts.mailboxId, mailboxId));
  }

  it("one mistyped password in the web UI is one login attempt (production wiring)", async () => {
    const server = rejectingServer();
    h.probe.mockImplementation(apiProber({ imapFactory: server.factory, limiter: null }));
    const res = await api(h, me, "POST", `/api/mailboxes/${h.seed.mailbox.id}/credentials`, { password: "typo" });
    expect(res.statusCode).toBe(200);
    await settle();
    expect(server.logins).toHaveLength(1);
    const failed = (await attempts()).filter((a) => a.outcome === "auth_failed");
    expect(failed).toHaveLength(1);
    // …so the CLI still lets the operator probe after a single web typo.
    expect(await loginBudgetProblem(h.t.db, h.seed.mailbox.id, h.clock.now())).toBeNull();
  });

  it("a probe refused by the in-process limiter (no login made) records no login attempt", async () => {
    const server = rejectingServer();
    h.probe.mockImplementation(apiProber({ imapFactory: server.factory, limiter: new ProbeLimiter(), now: () => h.clock.now().getTime() }));
    await api(h, me, "POST", `/api/mailboxes/${h.seed.mailbox.id}/credentials`, { password: "typo" });
    h.clock.advance(5_000);
    const limited = (await api(h, me, "POST", `/api/mailboxes/${h.seed.mailbox.id}/credentials`, { password: "typo2" })).json() as { errorKind: string };
    expect(limited.errorKind).toBe("rate_limited");
    await settle();
    expect(server.logins).toHaveLength(1);
    const bogus = await h.t.db
      .select()
      .from(s.mailboxLoginAttempts)
      .where(and(eq(s.mailboxLoginAttempts.mailboxId, h.seed.mailbox.id), eq(s.mailboxLoginAttempts.outcome, "other")));
    expect(bogus).toHaveLength(0);
    expect((await attempts()).map((a) => a.outcome)).toEqual(["auth_failed"]);
  });

  it("one successful web probe is one login (FakeImapServer)", async () => {
    const server = new FakeImapServer();
    server.addFolder("INBOX");
    h.probe.mockImplementation(apiProber({ imapFactory: server.factory, limiter: null }));
    const m = (await api(h, me, "POST", "/api/mailboxes", { address: "sales@contoso.example", imapHost: "mail.contoso.example" })).json() as MailboxSummary;
    const res = await api(h, me, "POST", `/api/mailboxes/${m.id}/credentials`, { password: "right" });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { ok: boolean }).ok).toBe(true);
    await settle();
    expect((await attempts(m.id)).map((a) => a.outcome)).toEqual(["ok"]);
  });

  it("src/server/main.ts wires the non-recording apiProber", async () => {
    const { readFileSync } = await import("node:fs");
    const main = readFileSync(new URL("../../../src/server/main.ts", import.meta.url), "utf8");
    expect(main).toMatch(/probe:\s*apiProber\(/);
    expect(main).not.toMatch(/createRecordingProber/);
  });
});

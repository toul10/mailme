import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../src/db/schema.js";
import type { ImapClientFactory, ImapClientLike } from "../../../src/mail/imap/client.js";
import { ProbeLimiter } from "../../../src/mail/imap/probe.js";
import type { MailboxSummary, ProbeSummary } from "../../../src/server/api-types.js";
import { apiProber } from "../../../src/server/probe.js";
import { addUser, api, makeHarness, sessionFor, type Harness } from "../../server/helpers.js";

/** Fake shared host: rejects every LOGIN and remembers who tried (host|user). */
function rejectingHost() {
  const failedLogins: string[] = [];
  const factory: ImapClientFactory = (o) =>
    ({
      capabilities: new Map(),
      namespace: undefined,
      connect: async () => {
        failedLogins.push(`${o.host}|${o.user}`);
        throw Object.assign(new Error("[AUTHENTICATIONFAILED] Invalid credentials"), { authenticationFailed: true, serverResponseCode: "AUTHENTICATIONFAILED" });
      },
      close: () => undefined,
      logout: async () => undefined,
    }) as unknown as ImapClientLike;
  return { failedLogins, factory };
}

describe("probe-budget-bypass", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it("a member cannot spend more than the per-account failure budget on someone else's IMAP account via extra mailbox rows", async () => {
    const host = rejectingHost();
    // Production wiring (src/server/main.ts: apiProber — the route records each login), with the process-wide
    // ProbeLimiter tied to the test clock. (The repro injected createRecordingProber, the pre-fix wiring.)
    h.probe.mockImplementation(apiProber({ imapFactory: host.factory, limiter: new ProbeLimiter(), now: () => h.clock.now().getTime() }));

    const member = await sessionFor(h, (await addUser(h, { email: "clerk@contoso.example" })).id);
    const rows: string[] = [];
    for (const address of ["x1@contoso.example", "x2@contoso.example"]) {
      const res = await api(h, member, "POST", "/api/mailboxes", { address, imapHost: "mail.contoso.example", imapUsername: "boss@contoso.example" });
      expect(res.statusCode).toBe(200);
      rows.push((res.json() as MailboxSummary).id);
    }

    for (let i = 0; i < 6; i++) {
      await api(h, member, "POST", `/api/mailboxes/${rows[i % 2]}/credentials`, { password: `guess-${i}` });
      h.clock.advance(21_000);
    }

    const againstBoss = host.failedLogins.filter((k) => k === "mail.contoso.example|boss@contoso.example");
    // The host bans the platform IP after ~5 failures and locks the account after ~15; the CLI stops at
    // 2 per hour. A per-account (host, username) bound must not be multiplied by adding mailbox rows.
    expect(againstBoss.length).toBeLessThanOrEqual(3);
  });

  it("the budget is per host and persistent: failures of any mailbox (sync included) block probes on that host for an hour", async () => {
    const host = rejectingHost();
    h.probe.mockImplementation(apiProber({ imapFactory: host.factory, limiter: null }));
    const me = await sessionFor(h, h.seed.user.id);
    // The worker already hit two auth failures on the seeded mailbox (same host) 10 minutes ago.
    const at = new Date(h.clock.now().getTime() - 10 * 60_000);
    await h.t.db.insert(s.mailboxLoginAttempts).values([
      { mailboxId: h.seed.mailbox.id, at, purpose: "sync", outcome: "auth_failed" },
      { mailboxId: h.seed.mailbox.id, at, purpose: "sync", outcome: "auth_failed" },
    ]);
    const other = (await api(h, me, "POST", "/api/mailboxes", { address: "sales@contoso.example", imapHost: "MAIL.contoso.example" })).json() as MailboxSummary;
    const refused = await api(h, me, "POST", `/api/mailboxes/${other.id}/credentials`, { password: "pw" });
    expect(refused.statusCode).toBe(200);
    const body = refused.json() as ProbeSummary;
    expect(body).toMatchObject({ ok: false, errorKind: "rate_limited" });
    expect(body.error).toMatch(/50 minutes/);
    expect(host.failedLogins).toHaveLength(0);
    // No login was made, so none is recorded.
    expect((await h.t.db.select().from(s.mailboxLoginAttempts)).length).toBe(2);

    // Another host is unaffected; and after the hour the budget is back.
    const elsewhere = (await api(h, me, "POST", "/api/mailboxes", { address: "k@other-gr.example", imapHost: "mail.other-gr.example" })).json() as MailboxSummary;
    await api(h, me, "POST", `/api/mailboxes/${elsewhere.id}/credentials`, { password: "pw" });
    expect(host.failedLogins).toEqual(["mail.other-gr.example|k@other-gr.example"]);
    h.clock.advance(51 * 60_000);
    await api(h, me, "POST", `/api/mailboxes/${other.id}/credentials`, { password: "pw" });
    expect(host.failedLogins).toContain("mail.contoso.example|sales@contoso.example");
  });

  it("a recent 'too many connections' answer blocks probes on that host for 15 minutes", async () => {
    const host = rejectingHost();
    h.probe.mockImplementation(apiProber({ imapFactory: host.factory, limiter: null }));
    const me = await sessionFor(h, h.seed.user.id);
    await h.t.db.insert(s.mailboxLoginAttempts).values({ mailboxId: h.seed.mailbox.id, at: new Date(h.clock.now().getTime() - 5 * 60_000), purpose: "sync", outcome: "too_many" });
    const res = await api(h, me, "POST", `/api/mailboxes/${h.seed.mailbox.id}/credentials`, { password: "pw" });
    expect(res.json()).toMatchObject({ ok: false, errorKind: "rate_limited" });
    expect(host.failedLogins).toHaveLength(0);
    h.clock.advance(11 * 60_000);
    await api(h, me, "POST", `/api/mailboxes/${h.seed.mailbox.id}/credentials`, { password: "pw" });
    expect(host.failedLogins).toHaveLength(1);
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "../../../src/db/schema.js";
import { dispatchDueDigests } from "../../../src/digest/dispatch.js";
import { evaluateHealth } from "../../../src/ops/health.js";
import { AT_0730, FakeTransport, makeDeps, setup, type Fixture } from "../../digest/helpers.js";
import { cliHarness } from "./cli-harness.js";

// State left by `mailbox:add` / POST /api/mailboxes with defaults: live_since = now + 7 days (shadow week),
// users.digest_start_date untouched (null), digest_enabled default true.
let f: Fixture;
beforeEach(async () => {
  f = await setup();
});
afterEach(() => f.t.close());

const healthConfig = { DEFAULT_TIMEZONE: "Europe/Athens", AI_DAILY_CALL_CAP: 150, AI_DAILY_USD_CAP: 10, ALERT_WEBHOOK_URL: undefined };
const digestMissing = async (now: Date) =>
  (await evaluateHealth({ db: f.db, config: healthConfig, alert: async () => true }, now)).results.filter((r) => r.family === "digest_missing");

describe("shadow-week-defaults-uncoupled", () => {
  it("control: after go-live (live_since passed) the report is delivered", async () => {
    await f.db.update(s.mailboxes).set({ liveSince: new Date("2026-09-17T09:00:00Z") }).where(eq(s.mailboxes.id, f.mailboxId));
    const r = await dispatchDueDigests(makeDeps(f, new FakeTransport()), AT_0730);
    expect(r.delivered).toBe(1);
  });

  it("during the shadow week (all mailboxes before live_since) no report goes out (“Week 1, shadow: no report”)", async () => {
    await f.db.update(s.mailboxes).set({ liveSince: new Date("2026-09-28T09:00:00Z") }).where(eq(s.mailboxes.id, f.mailboxId));
    const [u] = await f.db.select({ start: s.users.digestStartDate }).from(s.users).where(eq(s.users.id, f.userId));
    expect(u!.start).toBeNull();
    const r = await dispatchDueDigests(makeDeps(f, new FakeTransport()), AT_0730);
    expect(r.delivered).toBe(0);
    // …and the health check does not call the missing (not yet due) report an incident.
    expect(await digestMissing(new Date("2026-09-24T05:00:00Z"))).toEqual([]);

    // Go-live day (local date of live_since): the first report goes out, and is expected.
    const monday = new Date("2026-09-28T04:30:00Z");
    expect((await dispatchDueDigests(makeDeps(f, new FakeTransport(), monday), monday)).delivered).toBe(1);
    await f.db.delete(s.digests);
    expect((await digestMissing(new Date("2026-09-28T05:00:00Z"))).map((r) => r.ok)).toEqual([false]);
  });

  it("an explicit digest_start_date wins over the shadow week", async () => {
    await f.db.update(s.mailboxes).set({ liveSince: new Date("2026-09-28T09:00:00Z") }).where(eq(s.mailboxes.id, f.mailboxId));
    await f.db.update(s.users).set({ digestStartDate: "2026-09-24" }).where(eq(s.users.id, f.userId));
    expect((await dispatchDueDigests(makeDeps(f, new FakeTransport()), AT_0730)).delivered).toBe(1);
  });

  it("mailbox:add with the default shadow week sets the owner's report start to the go-live date", async () => {
    const now = new Date("2026-09-24T09:00:00Z");
    const h = await cliHarness(f.t, now);
    await f.db.delete(s.mailboxes);
    h.answers.push("pw");
    expect(await h.run("mailbox:add", "--user", "owner@contoso.example", "--address", "owner@contoso.example", "--host", "mail.contoso.example")).toBe(0);
    const [mb] = await f.db.select().from(s.mailboxes);
    expect(mb!.liveSince!.toISOString()).toBe("2026-10-01T09:00:00.000Z");
    const [u] = await f.db.select().from(s.users).where(eq(s.users.id, f.userId));
    expect(u!.digestStartDate).toBe("2026-10-01");
    expect(h.out.join("\n")).toContain("reports start on 2026-10-01");

    // An explicit start date is never overwritten.
    await f.db.update(s.users).set({ digestStartDate: "2026-09-29" }).where(eq(s.users.id, f.userId));
    h.answers.push("pw");
    expect(await h.run("mailbox:add", "--user", "owner@contoso.example", "--address", "owner@contoso.example", "--live-since", "2026-10-05")).toBe(0);
    expect((await f.db.select().from(s.users).where(eq(s.users.id, f.userId)))[0]!.digestStartDate).toBe("2026-09-29");
  });
});

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../../src/db/client.js";
import * as s from "../../../src/db/schema.js";
import type { MailboxConnectionSettings } from "../../../src/domain/types.js";
import { deliverDigestForUser, dispatchDueDigests, SMTP_IN_FLIGHT, SMTP_SENT, SMTP_UNKNOWN } from "../../../src/digest/dispatch.js";
import { evaluateHealth } from "../../../src/ops/health.js";
import { addTask, AT_0730, FakeTransport, makeDeps, setup, TODAY, type Fixture } from "../../digest/helpers.js";

let f: Fixture;
beforeEach(async () => {
  f = await setup();
  await f.db.update(s.users).set({ digestDelivery: "smtp" }).where(eq(s.users.id, f.userId));
});
afterEach(() => f.t.close());

/** Database whose transactions fail (lock timeout / connection blip) once the SMTP server has accepted the report. */
function flakyAfterSend(db: Db) {
  const state = { sent: false, failTransactions: 0 };
  const proxy = new Proxy(db, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target);
      if (prop === "transaction" && state.sent && state.failTransactions > 0) {
        return async () => {
          state.failTransactions--;
          throw Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" });
        };
      }
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as Db;
  const transport = new (class extends FakeTransport {
    override async sendSmtp(settings: MailboxConnectionSettings, password: string, raw: Buffer, envelope: { from: string; to: string[] }) {
      const res = await super.sendSmtp(settings, password, raw, envelope);
      state.sent = true;
      return res;
    }
  })();
  return { db: proxy, transport, state };
}

const smtpCalls = (t: FakeTransport) => t.calls.filter((c) => c.kind === "smtp").length;
const row = async () => (await f.db.select().from(s.digests).where(eq(s.digests.userId, f.userId)))[0]!;

describe("smtp-resend-on-retry", () => {
  it("a transient database error after a successful send is retried as bookkeeping, not as a delivery", async () => {
    const task = await addTask(f, { status: "COMPLETED", closedBy: "ai", closedAt: new Date("2026-09-23T10:00:00Z") });
    await f.db.insert(s.digests).values({ userId: f.userId, localDate: "2026-09-23", status: "delivered" }); // not the go-live report
    const { db, transport, state } = flakyAfterSend(f.db);
    state.failTransactions = 1;

    const first = await dispatchDueDigests({ ...makeDeps(f, transport, AT_0730), db }, AT_0730);
    expect(smtpCalls(transport)).toBe(1);
    expect(first).toMatchObject({ delivered: 1, failed: 0 });
    expect(await row().then((r) => r.status)).toBe("delivered");
    expect((await f.db.select().from(s.tasks).where(eq(s.tasks.id, task.id)))[0]!.autoClosedReportedAt).toEqual(AT_0730);

    const later = new Date(AT_0730.getTime() + 3 * 60_000);
    await dispatchDueDigests({ ...makeDeps(f, transport, later), db }, later);
    // Exactly once per (user, date).
    expect(smtpCalls(transport)).toBe(1);
  });

  it("when the bookkeeping keeps failing, the next dispatch finishes it without sending again", async () => {
    await addTask(f, { dueDate: TODAY });
    const { db, transport, state } = flakyAfterSend(f.db);
    state.failTransactions = 100;

    await dispatchDueDigests({ ...makeDeps(f, transport, AT_0730), db }, AT_0730);
    expect(smtpCalls(transport)).toBe(1); // precondition: SMTP accepted the report
    const stuck = await row();
    expect(stuck.status).not.toBe("failed"); // never down the failure path (a retry would resend)
    expect(stuck.status).not.toBe("delivered"); // precondition: the bookkeeping really failed

    state.failTransactions = 0; // the database recovers
    for (const m of [1, 3, 20]) {
      const at = new Date(AT_0730.getTime() + m * 60_000);
      await dispatchDueDigests({ ...makeDeps(f, transport, at), db }, at);
    }
    expect(smtpCalls(transport)).toBe(1);
    const done = await row();
    expect(done).toMatchObject({ status: "delivered", deliveredVia: "smtp", lastError: null });
    expect(done.sections?.today).toHaveLength(1);
  });

  it("past the catch-up deadline an interrupted SMTP delivery is still finished or marked, and nothing is sent", async () => {
    const task = await addTask(f, { status: "COMPLETED", closedBy: "ai", closedAt: new Date("2026-09-23T10:00:00Z") });
    await f.db.insert(s.digests).values({ userId: f.userId, localDate: "2026-09-23", status: "delivered" });
    // Sent at 10:59 but its bookkeeping failed; the next tick is after 11:00.
    await f.db.insert(s.digests).values({ userId: f.userId, localDate: TODAY, status: "rendered", attempts: 1, lastError: SMTP_SENT, html: "<p>x</p>", subject: "x", sections: { autoClosed: [task.id] }, renderedAt: new Date("2026-09-24T07:59:00Z") });
    const transport = new FakeTransport();
    const at = new Date("2026-09-24T08:02:00Z"); // 11:02 local
    expect(await dispatchDueDigests(makeDeps(f, transport, at), at)).toMatchObject({ delivered: 1, skipped: 0 });
    expect(await row().then((r) => r.status)).toBe("delivered");
    expect((await f.db.select().from(s.tasks).where(eq(s.tasks.id, task.id)))[0]!.autoClosedReportedAt).toEqual(at);
    // A plain failed row past the deadline stays as it is (no late delivery).
    const other = await setup({ shared: f.t });
    await f.db.insert(s.digests).values({ userId: other.userId, localDate: TODAY, status: "failed", attempts: 3, lastError: "Error:ETIMEDOUT" });
    await dispatchDueDigests(makeDeps(f, transport, at), at);
    expect((await f.db.select().from(s.digests).where(eq(s.digests.userId, other.userId)))[0]!.status).toBe("failed");
    expect(transport.calls).toHaveLength(0);
  });

  it("a delivery interrupted around the SMTP submission (crash) is never resent automatically", async () => {
    await addTask(f, { dueDate: TODAY });
    // What a worker killed right after SMTP accepted the report leaves behind (its lease has expired or is gone).
    await f.db.insert(s.digests).values({ userId: f.userId, localDate: TODAY, status: "rendered", attempts: 1, lastError: SMTP_IN_FLIGHT, html: "<p>x</p>", sections: { today: [] } });
    const transport = new FakeTransport();
    const at = new Date(AT_0730.getTime() + 15 * 60_000);
    const deps = makeDeps(f, transport, at);

    expect(await dispatchDueDigests(deps, at)).toMatchObject({ delivered: 0, failed: 1 });
    expect(await row()).toMatchObject({ status: "failed", lastError: SMTP_UNKNOWN });
    expect(deps.log.entries.some((e) => e.level === "error")).toBe(true); // alert-worthy
    // Later ticks and a plain `digest:send-now` leave it alone.
    const later = new Date(at.getTime() + 30 * 60_000);
    expect(await dispatchDueDigests(makeDeps(f, transport, later), later)).toMatchObject({ delivered: 0, failed: 0 });
    expect((await deliverDigestForUser(makeDeps(f, transport, later), f.userId, TODAY)).status).toBe(SMTP_UNKNOWN);
    expect(smtpCalls(transport)).toBe(0);
    // The operator is told why (the digest_missing alert names the code and the way out).
    const config = { DEFAULT_TIMEZONE: "Europe/Athens", AI_DAILY_CALL_CAP: 150, AI_DAILY_USD_CAP: 10, ALERT_WEBHOOK_URL: undefined };
    const health = await evaluateHealth({ db: f.db, config, alert: async () => true }, later);
    const missing = health.results.find((r) => r.family === "digest_missing")!;
    expect(missing.ok).toBe(false);
    expect(missing.body).toContain(SMTP_UNKNOWN);
    expect(missing.body).toContain("--retry");
  });
});

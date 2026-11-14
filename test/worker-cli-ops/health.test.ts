import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "../../src/db/schema.js";
import type { Alert } from "../../src/ops/alerts.js";
import { evaluateHealth, runHealthChecks, type HealthDeps } from "../../src/ops/health.js";
import { createTestDb, insertMessage, seedOrgUserMailbox, type TestDb } from "../helpers/db.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
// Thursday 2026-09-24 10:00 Europe/Athens (UTC+3)
const T0 = new Date("2026-09-24T07:00:00Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

interface Sink {
  alerts: Alert[];
  fail: boolean;
  fn(a: Alert): Promise<boolean>;
}
function sink(): Sink {
  const s: Sink = {
    alerts: [],
    fail: false,
    async fn(a) {
      if (s.fail) return false;
      s.alerts.push(a);
      return true;
    },
  };
  return s;
}

const baseConfig = { DEFAULT_TIMEZONE: "Europe/Athens", AI_DAILY_CALL_CAP: 150, AI_DAILY_USD_CAP: 10, ALERT_WEBHOOK_URL: undefined };

describe("health checks", () => {
  let t: TestDb;
  let alerts: Sink;
  let deps: HealthDeps;
  let ids: Awaited<ReturnType<typeof seedOrgUserMailbox>>;

  beforeEach(async () => {
    t = await createTestDb();
    alerts = sink();
    deps = { db: t.db, config: baseConfig, alert: (a) => alerts.fn(a) };
    ids = await seedOrgUserMailbox(t.db);
    // Healthy baseline: synced just now, no digest expected (disabled), created long ago.
    await t.db.update(s.mailboxes).set({ lastSyncAt: T0, createdAt: at(-30 * 24 * HOUR) }).where(eq(s.mailboxes.id, ids.mailbox.id));
    await t.db.update(s.users).set({ digestEnabled: false }).where(eq(s.users.id, ids.user.id));
  });
  afterEach(async () => {
    await t.close();
  });

  const setSync = (d: Date | null) => t.db.update(s.mailboxes).set({ lastSyncAt: d }).where(eq(s.mailboxes.id, ids.mailbox.id));

  it("is quiet when everything is healthy", async () => {
    const r = await runHealthChecks(deps, T0);
    expect(r.results.every((x) => x.ok)).toBe(true);
    expect(alerts.alerts).toEqual([]);
  });

  it("alerts once, reminds every 6 h, and resolves when sync recovers", async () => {
    await setSync(at(-45 * MIN));
    let r = await runHealthChecks(deps, T0);
    expect(r.alerted).toEqual([`sync_stale:${ids.mailbox.id}`]);
    expect(alerts.alerts).toHaveLength(1);
    expect(alerts.alerts[0]!.title).toContain("sync is stale");
    expect(alerts.alerts[0]!.body).toContain("45 min");

    for (const ms of [5 * MIN, 2 * HOUR, 5 * HOUR + 59 * MIN]) {
      r = await runHealthChecks(deps, at(ms));
      expect(r.alerted).toEqual([]);
      expect(r.reminded).toEqual([]);
    }
    expect(alerts.alerts).toHaveLength(1);

    r = await runHealthChecks(deps, at(6 * HOUR));
    expect(r.reminded).toEqual([`sync_stale:${ids.mailbox.id}`]);
    expect(alerts.alerts[1]!.title).toMatch(/still, 6 h/);
    r = await runHealthChecks(deps, at(6 * HOUR + 5 * MIN));
    expect(r.reminded).toEqual([]);

    await setSync(at(6 * HOUR + 9 * MIN));
    r = await runHealthChecks(deps, at(6 * HOUR + 10 * MIN));
    expect(r.resolved).toEqual([`sync_stale:${ids.mailbox.id}`]);
    expect(alerts.alerts[2]!.severity).toBe("info");
    expect(alerts.alerts[2]!.title).toContain("resolved");
    r = await runHealthChecks(deps, at(6 * HOUR + 15 * MIN));
    expect(alerts.alerts).toHaveLength(3);

    const [state] = await t.db.select().from(s.healthState).where(eq(s.healthState.key, `sync_stale:${ids.mailbox.id}`));
    expect(state!.status).toBe("ok");
  });

  it("retries an alert whose delivery failed", async () => {
    await setSync(at(-2 * HOUR));
    alerts.fail = true;
    let r = await runHealthChecks(deps, T0);
    expect(r.alerted).toEqual([]);
    alerts.fail = false;
    r = await runHealthChecks(deps, at(5 * MIN));
    expect(r.reminded).toEqual([`sync_stale:${ids.mailbox.id}`]);
    expect(alerts.alerts).toHaveLength(1);
  });

  it("alerts on auth_failed and resolves a mailbox that is no longer checked", async () => {
    await t.db.update(s.mailboxes).set({ status: "auth_failed" }).where(eq(s.mailboxes.id, ids.mailbox.id));
    let r = await runHealthChecks(deps, T0);
    expect(r.alerted).toEqual([`mailbox_status:${ids.mailbox.id}`]);
    expect(alerts.alerts[0]!.severity).toBe("critical");
    expect(alerts.alerts[0]!.body).toContain("mailbox:add");
    await t.db.update(s.mailboxes).set({ status: "disabled" }).where(eq(s.mailboxes.id, ids.mailbox.id));
    r = await runHealthChecks(deps, at(5 * MIN));
    expect(r.resolved).toEqual([`mailbox_status:${ids.mailbox.id}`]);
  });

  it("alerts when the oldest live pending message waits over 60 min, not during a progressing backfill", async () => {
    const m = await insertMessage(t.db, { mailboxId: ids.mailbox.id, sortTs: at(-2 * HOUR), state: "pending" });
    let r = await runHealthChecks(deps, T0);
    expect(r.alerted).toEqual([`queue_stale:${ids.mailbox.id}`]);

    // Backfill in progress with a recent AI call: fine.
    await t.db.update(s.messages).set({ backfill: true }).where(eq(s.messages.id, m.id));
    await t.db.insert(s.extractions).values({ messageId: m.id, mailboxId: ids.mailbox.id, pipelineVersion: "v", status: "ok", createdAt: at(-10 * MIN) });
    r = await runHealthChecks(deps, at(1 * MIN));
    expect(r.resolved).toEqual([`queue_stale:${ids.mailbox.id}`]);
    // Backfill stalled (no AI call for > 60 min): alert again.
    await setSync(at(2 * HOUR));
    r = await runHealthChecks(deps, at(2 * HOUR));
    expect(r.alerted).toEqual([`queue_stale:${ids.mailbox.id}`]);
  });

  it("checks extraction failure rate and daily AI spend", async () => {
    const m = await insertMessage(t.db, { mailboxId: ids.mailbox.id, sortTs: at(-3 * HOUR), state: "applied" });
    const rows = Array.from({ length: 10 }, (_, i) => ({
      messageId: m.id,
      mailboxId: ids.mailbox.id,
      pipelineVersion: "v",
      attempt: i + 1,
      status: (i < 2 ? "error" : "ok") as "error" | "ok",
      costUsd: 1.2,
      createdAt: at(-HOUR + i * MIN),
    }));
    await t.db.insert(s.extractions).values(rows);
    // Yesterday's (Athens) calls do not count.
    await t.db.insert(s.extractions).values({ messageId: m.id, mailboxId: ids.mailbox.id, pipelineVersion: "v", attempt: 99, status: "error", costUsd: 50, createdAt: new Date("2026-09-23T20:00:00Z") });
    const r = await runHealthChecks(deps, T0);
    expect(r.alerted.sort()).toEqual([`ai_spend:${ids.mailbox.id}`, `extraction_failures:${ids.mailbox.id}`].sort());
    const spend = r.results.find((x) => x.family === "ai_spend")!;
    expect(spend.detail).toMatchObject({ calls: 10, usdCap: 10 });
    expect(spend.detail.usd).toBeCloseTo(12);
    const fail = r.results.find((x) => x.family === "extraction_failures")!;
    expect(fail.body).toContain("2 of 10");
  });

  it("alerts on the global AI pause and on a per-mailbox AI pause", async () => {
    await t.db.insert(s.appState).values({ key: "ai_global_pause", value: { reason: "extractor", at: T0.toISOString() } });
    await t.db.update(s.mailboxes).set({ aiPaused: true, aiPausedReason: "budget:usd" }).where(eq(s.mailboxes.id, ids.mailbox.id));
    let r = await runHealthChecks(deps, T0);
    expect(r.alerted.sort()).toEqual(["ai_global_pause:global", `ai_paused:${ids.mailbox.id}`].sort());
    expect(alerts.alerts.find((a) => a.title.includes("ALL"))!.body).toContain("Reason code: extractor");
    await t.db.update(s.appState).set({ value: { paused: false } });
    r = await runHealthChecks(deps, at(5 * MIN));
    expect(r.resolved).toEqual(["ai_global_pause:global"]);
  });

  it("alerts when the digest is not delivered 15 min after digest_time on a business day", async () => {
    await t.db.update(s.users).set({ digestEnabled: true, digestTime: "07:30" }).where(eq(s.users.id, ids.user.id));
    // 07:40 Athens: not yet due.
    let r = await runHealthChecks(deps, new Date("2026-09-24T04:40:00Z"));
    expect(r.results.some((x) => x.family === "digest_missing")).toBe(false);
    // 07:46 Athens: no digest row → alert.
    r = await runHealthChecks(deps, new Date("2026-09-24T04:46:00Z"));
    expect(r.alerted).toEqual([`digest_missing:${ids.user.id}`]);
    expect(alerts.alerts[0]!.body).toContain('"none"');
    // Delivered (late) → resolved.
    await t.db.insert(s.digests).values({ userId: ids.user.id, localDate: "2026-09-24", status: "delivered", late: true });
    r = await runHealthChecks(deps, new Date("2026-09-24T05:00:00Z"));
    expect(r.resolved).toEqual([`digest_missing:${ids.user.id}`]);
    // Saturday: nothing expected.
    r = await runHealthChecks(deps, new Date("2026-09-26T06:00:00Z"));
    expect(r.results.some((x) => x.family === "digest_missing")).toBe(false);
    // Holiday (28 Oct, Wednesday) and before digest_start_date: nothing expected.
    r = await runHealthChecks(deps, new Date("2026-10-28T06:00:00Z"));
    expect(r.results.some((x) => x.family === "digest_missing")).toBe(false);
    await t.db.update(s.users).set({ digestStartDate: "2026-10-05" }).where(eq(s.users.id, ids.user.id));
    r = await runHealthChecks(deps, new Date("2026-09-29T06:00:00Z"));
    expect(r.results.some((x) => x.family === "digest_missing")).toBe(false);
  });

  it("checks disk, backup marker and mailbox quota; a failing check keeps its previous state", async () => {
    await t.db.update(s.mailboxes).set({ probe: { quota: { usedKb: 900_000, limitKb: 1_000_000 } } }).where(eq(s.mailboxes.id, ids.mailbox.id));
    let used = 0.85;
    let statfsThrows = false;
    let marker: Date | null = null;
    deps = {
      ...deps,
      dataDir: "/data",
      backupMarkerFile: "/data/backup.ok",
      statfs: async () => {
        if (statfsThrows) throw new Error("EACCES");
        return { blocks: 1000, bavail: Math.round(1000 * (1 - used)) };
      },
      fileMtime: async () => marker,
    };
    let r = await runHealthChecks(deps, T0);
    expect(r.alerted.sort()).toEqual(["backup:global", "disk:global", `quota:${ids.mailbox.id}`].sort());
    expect(alerts.alerts.find((a) => a.title.includes("backup"))!.body).toContain("No backup marker");

    marker = at(-2 * HOUR);
    statfsThrows = true;
    r = await runHealthChecks(deps, at(5 * MIN));
    expect(r.failedFamilies).toEqual(["disk"]);
    expect(r.resolved).toEqual(["backup:global"]);
    expect(r.alerted).toEqual(["check_error:disk"]);
    const [disk] = await t.db.select().from(s.healthState).where(eq(s.healthState.key, "disk:global"));
    expect(disk!.status).toBe("alerting");

    statfsThrows = false;
    used = 0.5;
    r = await runHealthChecks(deps, at(10 * MIN));
    expect(r.resolved.sort()).toEqual(["check_error:disk", "disk:global"].sort());
    marker = at(-27 * HOUR);
    r = await runHealthChecks(deps, at(15 * MIN));
    expect(r.alerted).toEqual(["backup:global"]);
  });

  it("never puts message content into alerts", async () => {
    await insertMessage(t.db, { mailboxId: ids.mailbox.id, sortTs: at(-3 * HOUR), state: "pending", subject: "Μυστικό θέμα ABC", from: "secret.client@abc-gr.example" });
    await t.db.update(s.mailboxes).set({ status: "auth_failed", lastError: "AUTHENTICATIONFAILED owner@contoso.example", lastSyncAt: at(-2 * HOUR) }).where(eq(s.mailboxes.id, ids.mailbox.id));
    await t.db.update(s.users).set({ digestEnabled: true }).where(eq(s.users.id, ids.user.id));
    const { results } = await evaluateHealth(deps, T0);
    await runHealthChecks(deps, T0);
    const texts = [...results.map((r) => r.title + " " + r.body), ...alerts.alerts.map((a) => a.title + " " + a.body)].join("\n");
    expect(alerts.alerts.length).toBeGreaterThan(0);
    for (const secret of ["Μυστικό", "secret.client", "abc-gr.example", "owner@contoso.example", "Owner Person", "contoso"]) {
      expect(texts).not.toContain(secret);
    }
  });
});

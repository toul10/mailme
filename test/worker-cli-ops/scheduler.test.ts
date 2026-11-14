import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createScheduler, nextDelayMs } from "../../src/worker/scheduler.js";

describe("nextDelayMs", () => {
  it("keeps interval jitter within ±jitter", () => {
    const s = { kind: "interval" as const, everyMs: 60_000, jitterMs: 5_000 };
    const now = new Date();
    expect(nextDelayMs(s, now, () => 0)).toBe(55_000);
    expect(nextDelayMs(s, now, () => 0.5)).toBe(60_000);
    expect(nextDelayMs(s, now, () => 0.999999)).toBeLessThanOrEqual(65_000);
    for (let i = 0; i < 200; i++) {
      const d = nextDelayMs(s, now);
      expect(d).toBeGreaterThanOrEqual(55_000);
      expect(d).toBeLessThanOrEqual(65_000);
    }
    expect(nextDelayMs({ kind: "interval", everyMs: 1_000, jitterMs: 5_000 }, now, () => 0)).toBe(0);
  });

  it("computes the next local daily time (Europe/Athens), including across DST", () => {
    const s = { kind: "daily" as const, at: "03:30", zone: "Europe/Athens" };
    // 2026-09-24 10:00 Athens (UTC+3) → next 03:30 local is 2026-09-25 00:30Z.
    expect(nextDelayMs(s, new Date("2026-09-24T07:00:00Z"))).toBe(new Date("2026-09-25T00:30:00Z").getTime() - new Date("2026-09-24T07:00:00Z").getTime());
    // 02:00 local → same day 03:30.
    expect(nextDelayMs(s, new Date("2026-09-23T23:00:00Z"))).toBe(90 * 60_000);
    // Exactly 03:30 → tomorrow.
    expect(nextDelayMs(s, new Date("2026-09-24T00:30:00Z"))).toBe(24 * 3_600_000);
    // DST ends 2026-10-25 (04:00 EEST → 03:00 EET), so 03:30 happens twice: the first one (EEST, 00:30Z) is used.
    expect(nextDelayMs(s, new Date("2026-10-24T09:00:00Z"))).toBe(new Date("2026-10-25T00:30:00Z").getTime() - new Date("2026-10-24T09:00:00Z").getTime());
    // DST starts 2027-03-28 (03:00 EET → 04:00 EEST): 03:30 does not exist and is shifted forward an hour (01:30Z).
    expect(nextDelayMs(s, new Date("2027-03-27T10:00:00Z"))).toBe(new Date("2027-03-28T01:30:00Z").getTime() - new Date("2027-03-27T10:00:00Z").getTime());
    expect(() => createScheduler().add({ name: "x", schedule: { kind: "daily", at: "25:00", zone: "UTC" }, run: async () => {} })).toThrow();
  });
});

describe("scheduler", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("never overlaps runs of one job, even when a run outlasts the interval", async () => {
    let active = 0;
    let maxActive = 0;
    let runs = 0;
    const sched = createScheduler({ random: () => 0.5 });
    sched.add({
      name: "slow",
      schedule: { kind: "interval", everyMs: 1_000, initialDelayMs: 0 },
      run: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        runs++;
        await new Promise((r) => setTimeout(r, 3_500));
        active--;
      },
    });
    sched.start();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(maxActive).toBe(1);
    // each cycle = 3.5 s run + 1 s gap → 20 s gives 5 starts
    expect(runs).toBe(5);
    // trigger during a run coalesces into one extra run right after
    expect(sched.isRunning("slow")).toBe(true);
    expect(sched.trigger("slow")).toBe(true);
    expect(sched.trigger("slow")).toBe(true);
    await vi.advanceTimersByTimeAsync(3_500);
    expect(maxActive).toBe(1);
    const left = sched.stop(60_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await left).toEqual([]);
    const after = runs;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(runs).toBe(after);
  });

  it("keeps scheduling after a failing run and spaces runs by interval ± jitter", async () => {
    const starts: number[] = [];
    let n = 0;
    const sched = createScheduler({ random: () => 0 });
    sched.add({
      name: "flaky",
      schedule: { kind: "interval", everyMs: 10_000, jitterMs: 2_000, initialDelayMs: 0 },
      run: async () => {
        starts.push(Date.now());
        if (n++ % 2 === 0) throw new Error("boom");
      },
    });
    sched.start();
    await vi.advanceTimersByTimeAsync(39_000);
    expect(starts.length).toBe(5);
    for (let i = 1; i < starts.length; i++) expect(starts[i]! - starts[i - 1]!).toBe(8_000);
    expect(sched.runCount("flaky")).toBe(5);
    await sched.stop();
  });

  it("stop() returns the jobs still running at the deadline", async () => {
    const sched = createScheduler();
    sched.add({ name: "stuck", schedule: { kind: "interval", everyMs: 1_000, initialDelayMs: 0 }, run: () => new Promise(() => {}) });
    sched.add({ name: "idle", schedule: { kind: "interval", everyMs: 60_000, initialDelayMs: 30_000 }, run: async () => {} });
    sched.start();
    await vi.advanceTimersByTimeAsync(10);
    const p = sched.stop(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await p).toEqual(["stuck"]);
    expect(sched.trigger("idle")).toBe(false);
  });
});

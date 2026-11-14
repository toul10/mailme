import { afterEach, describe, expect, it, vi } from "vitest";
import type { HealthSummary } from "../../src/server/api-types.js";
import { SYNC_NOW_COOLDOWN_MS } from "../../src/server/routes/sync-now.js";
import type { SyncNowTrigger } from "../../src/server/sync-now.js";
import { api, FakeClock, makeHarness, sessionFor, type Harness } from "./helpers.js";

describe("“Check now” (POST /api/sync-now)", () => {
  let h: Harness;
  afterEach(async () => {
    await h?.close();
  });

  const harnessWith = async (start: SyncNowTrigger["start"] | null, clock = new FakeClock()) => {
    h = await makeHarness({ clock, syncNow: start ? { start } : null });
    return { sess: await sessionFor(h, h.seed.user.id), clock };
  };

  it("is not there where an always-on worker runs (no TICK_JOB): 404, and health hides the button", async () => {
    const { sess } = await harnessWith(null);
    expect((await api(h, sess, "POST", "/api/sync-now")).statusCode).toBe(404);
    expect(((await api(h, sess, "GET", "/api/health")).json() as HealthSummary).canSyncNow).toBe(false);
  });

  it("needs a signed-in session and the CSRF token", async () => {
    const start = vi.fn(async () => {});
    const { sess } = await harnessWith(start);
    expect((await api(h, null, "POST", "/api/sync-now")).statusCode).toBe(401);
    const noCsrf = await h.app.inject({ method: "POST", url: "/api/sync-now", cookies: sess.cookies, payload: {} });
    expect(noCsrf.statusCode).toBe(403);
    expect(start).not.toHaveBeenCalled();
    expect(((await api(h, sess, "GET", "/api/health")).json() as HealthSummary).canSyncNow).toBe(true);
  });

  it("starts the tick job once, and answers only after Cloud Run accepted it (CPU stops after the response)", async () => {
    let accept!: () => void;
    const start = vi.fn(() => new Promise<void>((resolve) => (accept = resolve)));
    const { sess } = await harnessWith(start);

    let answered = false;
    const pending = api(h, sess, "POST", "/api/sync-now").then((res) => ((answered = true), res));
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 30));
    expect(answered).toBe(false);

    accept();
    const res = await pending;
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ started: true });
  });

  it("allows one start per minute: 429 with Retry-After in between", async () => {
    const start = vi.fn(async () => {});
    const { sess, clock } = await harnessWith(start);
    expect((await api(h, sess, "POST", "/api/sync-now")).statusCode).toBe(202);

    clock.advance(20_000);
    const again = await api(h, sess, "POST", "/api/sync-now");
    expect(again.statusCode).toBe(429);
    expect(again.headers["retry-after"]).toBe("40");
    expect(start).toHaveBeenCalledTimes(1);

    clock.advance(SYNC_NOW_COOLDOWN_MS - 20_000);
    expect((await api(h, sess, "POST", "/api/sync-now")).statusCode).toBe(202);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("a start Cloud Run refused answers 502 and does not hold back the next try", async () => {
    const start = vi.fn().mockRejectedValueOnce(new Error("run job: HTTP 403")).mockResolvedValue(undefined);
    const { sess } = await harnessWith(start);
    const failed = await api(h, sess, "POST", "/api/sync-now");
    expect(failed.statusCode).toBe(502);
    expect(failed.json()).toMatchObject({ code: "internal" });
    expect((await api(h, sess, "POST", "/api/sync-now")).statusCode).toBe(202);
  });
});

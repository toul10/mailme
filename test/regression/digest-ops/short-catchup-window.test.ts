import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../src/db/schema.js";
import { decideDue, dispatchDueDigests, MIN_CATCHUP_MINUTES } from "../../../src/digest/dispatch.js";
import { holidayCalendar } from "../../../src/digest/calendar.js";
import { WORKER_SCHEDULE } from "../../../src/worker/worker.js";
import { addTask, FakeTransport, makeDeps, setup, type Fixture } from "../../digest/helpers.js";

let f: Fixture;
beforeEach(async () => {
  f = await setup();
  await f.db.update(s.users).set({ digestTime: "10:59" }).where(eq(s.users.id, f.userId));
});
afterEach(() => f.t.close());

describe("short-catchup-window", () => {
  it("a 10:59 digest time is not skipped when two dispatcher ticks are 62 s apart", async () => {
    await addTask(f, { dueDate: "2026-09-24" });
    const transport = new FakeTransport();
    // Dispatcher ticks every 60 s ± 2 s jitter (plus run time): 10:58:59 and 11:00:01 local are one legal gap.
    expect(WORKER_SCHEDULE.digestMs).toBe(60_000);
    const t1 = new Date("2026-09-24T07:58:59Z");
    const t2 = new Date("2026-09-24T08:00:01Z");
    expect(t2.getTime() - t1.getTime()).toBeLessThanOrEqual(62_000);

    await dispatchDueDigests(makeDeps(f, transport, t1), t1);
    const r = await dispatchDueDigests(makeDeps(f, transport, t2), t2);
    const [row] = await f.db.select().from(s.digests).where(eq(s.digests.userId, f.userId));
    // 11:00 gets a 210-minute window; 10:59 no longer gets 60 seconds but at least MIN_CATCHUP_MINUTES (until 12:29).
    expect(decideDue(new Date("2026-09-24T11:00:00Z"), "Europe/Athens", "11:00", null, holidayCalendar()).kind).toBe("send"); // 14:00 local
    expect(decideDue(t2, "Europe/Athens", "10:59", null, holidayCalendar()).kind).toBe("send");
    expect(MIN_CATCHUP_MINUTES).toBe(90);
    expect(decideDue(new Date("2026-09-24T09:28:59Z"), "Europe/Athens", "10:59", null, holidayCalendar()).kind).toBe("send"); // 12:28:59
    expect(decideDue(new Date("2026-09-24T09:29:00Z"), "Europe/Athens", "10:59", null, holidayCalendar()).kind).toBe("too_late"); // 12:29
    // An early digest time keeps the 11:00 catch-up.
    expect(decideDue(new Date("2026-09-24T07:59:00Z"), "Europe/Athens", "07:30", null, holidayCalendar()).kind).toBe("send");
    expect(decideDue(new Date("2026-09-24T08:00:00Z"), "Europe/Athens", "07:30", null, holidayCalendar()).kind).toBe("too_late");
    expect(r.skipped).toBe(0);
    expect(row?.status).toBe("delivered");
  });
});

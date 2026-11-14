import { and, eq, isNotNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../src/db/schema.js";
import { runAging } from "../../../src/digest/aging.js";
import { SECTION_CAPS } from "../../../src/digest/build.js";
import { dispatchDueDigests } from "../../../src/digest/dispatch.js";
import { addTask, FakeTransport, makeDeps, setup, type Fixture } from "../../digest/helpers.js";

const ZONE = "Europe/Athens";
// Business days from Thu 24/09 up to Mon 05/10 (EEST, UTC+3; no Greek holidays in between).
const DAYS = ["2026-09-24", "2026-09-25", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-05"];

let f: Fixture;
beforeEach(async () => {
  f = await setup();
});
afterEach(() => f.t.close());

describe("aging-dormant-unshown", () => {
  it("never puts a task to sleep (dormant) unless “Still valid?” was shown in a delivered report", async () => {
    expect(SECTION_CAPS.stillValid).toBe(3);
    const N = 22; // 7 reports × cap 3 = 21 < 22
    for (let i = 0; i < N; i++) await addTask(f, { lastActivityAt: new Date("2026-09-01T07:00:00Z"), createdAt: new Date("2026-09-01T07:00:00Z") });
    const transport = new FakeTransport();

    for (const day of DAYS) {
      await runAging(f.db, new Date(`${day}T01:00:00Z`), ZONE); // 04:00 local
      const at = new Date(`${day}T04:30:00Z`); // 07:30 local
      if (day !== DAYS.at(-1)) {
        const r = await dispatchDueDigests(makeDeps(f, transport, at), at);
        expect(r.delivered).toBe(1); // precondition: a report really went out every business day
      }
    }

    const delivered = await f.db.select({ sections: s.digests.sections }).from(s.digests).where(eq(s.digests.status, "delivered"));
    expect(delivered).toHaveLength(7);
    const everShown = new Set(delivered.flatMap((d) => Object.values(d.sections ?? {}).flat()));
    const dormant = await f.db.select({ id: s.tasks.id }).from(s.tasks).where(and(eq(s.tasks.userId, f.userId), isNotNull(s.tasks.dormantAt)));
    expect(dormant.length).toBeGreaterThan(0); // precondition: aging did run to the dormant step
    const dormantNeverShown = dormant.filter((t) => !everShown.has(t.id));
    // "Still valid?" once in the report → dormant only with no answer after another 7 days.
    expect(dormantNeverShown).toEqual([]);
  }, 60_000);
});

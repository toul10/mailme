import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../src/db/schema.js";
import { buildDigestModel } from "../../../src/digest/build.js";
import type { DigestModel } from "../../../src/digest/model.js";
import { addTask, AT_0730, setup, TODAY, type Fixture } from "../../digest/helpers.js";

let f: Fixture;
beforeEach(async () => {
  f = await setup();
});
afterEach(() => f.t.close());

const sectionsOf = (m: DigestModel, id: string) => (Object.keys(m.sections) as Array<keyof DigestModel["sections"]>).filter((k) => m.sections[k].items.some((i) => i.taskId === id));

/** Backfill task idle for 3 weeks with an overdue due date: one-time "Earlier" triage, not the reports. */
const staleBackfill = () => addTask(f, { origin: "backfill", dueDate: "2026-09-04", lastActivityAt: new Date("2026-09-03T08:00:00Z"), createdAt: new Date("2026-09-18T08:00:00Z") });

describe("apo-prin-triage-missing", () => {
  it("control: the first report leaves the stale backfill task out", async () => {
    const t = await staleBackfill();
    const m = await buildDigestModel(f.db, f.userId, TODAY, AT_0730);
    expect(sectionsOf(m, t.id)).toEqual([]);
  });

  it("the second report still leaves it out (it belongs to the untriaged “Earlier” list, which does not exist)", async () => {
    await f.db.insert(s.digests).values({ userId: f.userId, localDate: "2026-09-23", status: "delivered", createdAt: new Date("2026-09-23T04:30:00Z"), deliveredAt: new Date("2026-09-23T04:31:00Z") });
    const t = await staleBackfill();
    const m = await buildDigestModel(f.db, f.userId, TODAY, AT_0730);
    expect(sectionsOf(m, t.id)).toEqual([]);
  });
});

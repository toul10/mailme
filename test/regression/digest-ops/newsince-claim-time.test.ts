import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../src/db/schema.js";
import { buildDigestModel } from "../../../src/digest/build.js";
import { dispatchDueDigests } from "../../../src/digest/dispatch.js";
import { MailTransportError } from "../../../src/mail/transport.js";
import { addTask, AT_0730, FakeTransport, makeDeps, setup, TODAY, type Fixture } from "../../digest/helpers.js";

let f: Fixture;
beforeEach(async () => {
  f = await setup();
});
afterEach(() => f.t.close());

describe("newsince-claim-time", () => {
  it("a task listed under “New” in yesterday's (retried) report is not “New” again today", async () => {
    const transport = new FakeTransport();
    transport.failures.push(new MailTransportError("network", "ETIMEDOUT", "ETIMEDOUT"));
    const y0730 = new Date("2026-09-23T04:30:00Z"); // Wed 23 Sep 07:30 local
    await dispatchDueDigests(makeDeps(f, transport, y0730), y0730);
    const [first] = await f.db.select().from(s.digests).where(eq(s.digests.userId, f.userId));
    expect(first!.status).toBe("failed"); // precondition: first attempt failed, row created at 07:30
    // created_at is the database's now() at the first claim; pin it to the simulated wall clock.
    await f.db.update(s.digests).set({ createdAt: y0730 }).where(eq(s.digests.id, first!.id));

    const created = new Date("2026-09-23T05:00:00Z"); // 08:00 local
    const task = await addTask(f, { origin: "ai", createdAt: created, lastActivityAt: created });

    const y0805 = new Date("2026-09-23T05:05:00Z");
    expect((await dispatchDueDigests(makeDeps(f, transport, y0805), y0805)).delivered).toBe(1);
    const [yesterday] = await f.db.select().from(s.digests).where(eq(s.digests.userId, f.userId));
    expect(yesterday!.sections?.new).toEqual([task.id]); // precondition: shown as new yesterday

    const today = await buildDigestModel(f.db, f.userId, TODAY, AT_0730);
    expect(today.sections.new.items.map((i) => i.taskId)).not.toContain(task.id);
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "../../../src/db/schema.js";
import { runAging } from "../../../src/digest/aging.js";
import { isSnoozed } from "../../../src/digest/build.js";
import { snoozeTask } from "../../../src/engine/user-actions.js";
import { TaskActionSchema } from "../../../src/server/validation.js";
import { createTestDb, insertTask, seedOrgUserMailbox, type TestDb } from "../../helpers/db.js";

let t: TestDb;
let ctx: Awaited<ReturnType<typeof seedOrgUserMailbox>>;
beforeEach(async () => {
  t = await createTestDb();
  ctx = await seedOrgUserMailbox(t.db);
});
afterEach(() => t.close());

describe("until-reply-fallback-date-mismatch", () => {
  it("control: the API accepts until_reply with a fallback date and snoozeTask stores it", async () => {
    expect(TaskActionSchema.safeParse({ action: "snooze", mode: "until_reply", until: "2026-10-01" }).success).toBe(true);
    const task = await insertTask(t.db, { orgId: ctx.org.id, userId: ctx.user.id, mailboxId: ctx.mailbox.id, status: "WAITING_FOR_OTHER" });
    await snoozeTask({ db: t.db, clock: { now: () => new Date("2026-09-24T09:00:00Z") }, userId: ctx.user.id, via: "web" }, task.id, "until_reply", "2026-10-01");
    const [row] = await t.db.select().from(s.tasks).where(eq(s.tasks.id, task.id));
    expect(row).toMatchObject({ snoozeMode: "until_reply", snoozedUntil: "2026-10-01" });
  });

  it("after the fallback date the report agrees with the web tabs (task no longer snoozed)", () => {
    // src/server/queries.ts snoozedSql: until_reply with a date is snoozed only while date > today.
    expect(isSnoozed({ snoozeMode: "until_reply", snoozedUntil: "2026-10-01" }, "2026-10-05")).toBe(false);
  });

  it("aging clears an until_reply snooze whose fallback date has passed", async () => {
    const task = await insertTask(t.db, { orgId: ctx.org.id, userId: ctx.user.id, mailboxId: ctx.mailbox.id, status: "WAITING_FOR_OTHER" });
    await snoozeTask({ db: t.db, clock: { now: () => new Date("2026-09-24T09:00:00Z") }, userId: ctx.user.id, via: "web" }, task.id, "until_reply", "2026-10-01");
    await runAging(t.db, new Date("2026-10-05T09:00:00Z"), "Europe/Athens");
    const [row] = await t.db.select().from(s.tasks).where(eq(s.tasks.id, task.id));
    expect(row!.snoozeMode).toBeNull();
  });
});

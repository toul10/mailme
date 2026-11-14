import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import * as s from "../../../src/db/schema.js";
import type { AppendResult, MailboxConnectionSettings } from "../../../src/domain/types.js";
import { buildDigestModel } from "../../../src/digest/build.js";
import { dispatchDueDigests } from "../../../src/digest/dispatch.js";
import { addTask, AT_0730, FakeTransport, makeDeps, setup, TODAY, type Fixture } from "../../digest/helpers.js";

/** APPEND reaches the server, but the tagged OK is lost (connection drop): the caller sees an error. */
class LostOkTransport extends FakeTransport {
  loseNextOk = true;
  appended: Buffer[] = [];
  override async appendToInbox(settings: MailboxConnectionSettings, password: string, raw: Buffer, messageIdHeader: string): Promise<AppendResult> {
    const res = await super.appendToInbox(settings, password, raw, messageIdHeader);
    if (!res.alreadyPresent) this.appended.push(raw);
    if (this.loseNextOk) {
      this.loseNextOk = false;
      throw Object.assign(new Error("Connection closed"), { code: "ECONNRESET" });
    }
    return res;
  }
}

let f: Fixture;
beforeEach(async () => {
  f = await setup();
  // Not the go-live digest (that one bulk-marks AI closures as reported for the "Earlier" triage).
  await f.db.insert(s.digests).values({ userId: f.userId, localDate: "2026-09-23", status: "delivered", attempts: 1, deliveredVia: "append" });
});
afterEach(() => f.t.close());

const plusMin = (d: Date, n: number) => new Date(d.getTime() + n * 60_000);

describe("append-alreadypresent-ignored", () => {
  it("a retry that finds the earlier APPEND must not mark tasks that were not in the delivered copy as reported", async () => {
    const transport = new LostOkTransport();
    const deps = makeDeps(f, transport);
    await dispatchDueDigests(deps, AT_0730); // attempt 1: appended (without T), OK lost → failed
    const [d1] = await f.db.select().from(s.digests).where(and(eq(s.digests.userId, f.userId), eq(s.digests.localDate, TODAY)));
    expect(d1!.status).toBe("failed");
    expect(transport.appended).toHaveLength(1);

    // Between attempts the AI closes task T.
    const t = await addTask(f, { status: "COMPLETED", closedBy: "ai", closedAt: plusMin(AT_0730, 1) });

    await dispatchDueDigests(makeDeps(f, transport, plusMin(AT_0730, 5)), plusMin(AT_0730, 5)); // attempt 2: alreadyPresent
    const [d2] = await f.db.select().from(s.digests).where(and(eq(s.digests.userId, f.userId), eq(s.digests.localDate, TODAY)));
    expect(d2!.status).toBe("delivered");
    expect(transport.appended).toHaveLength(1); // the inbox still holds attempt 1's copy only

    const inInbox = transport.appended[0]!.toString("latin1");
    const [task] = await f.db.select().from(s.tasks).where(eq(s.tasks.id, t.id));
    // T was never shown to the user: the delivered row records the copy that is in the inbox (attempt 1), not the re-render…
    expect(inInbox).not.toContain(t.id);
    expect((d2!.sections as { autoClosed?: string[] }).autoClosed ?? []).not.toContain(t.id);
    expect(d2!.html).toBe(d1!.html);
    expect(d2!.renderedAt).toEqual(d1!.renderedAt);
    // …so its AI closure must still be pending for a report (every AI-closed task appears once).
    expect(task!.autoClosedReportedAt).toBeNull();
    const friday = await buildDigestModel(f.db, f.userId, "2026-09-25", new Date("2026-09-25T04:30:00Z"));
    expect(friday.sections.autoClosed.items.map((i) => i.taskId)).toContain(t.id);
  });
});

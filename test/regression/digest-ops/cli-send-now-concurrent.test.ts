import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../../src/db/client.js";
import * as s from "../../../src/db/schema.js";
import type { MailboxConnectionSettings } from "../../../src/domain/types.js";
import { deliverDigestForUser, dispatchDueDigests } from "../../../src/digest/dispatch.js";
import { addTask, AT_0730, FakeTransport, makeDeps, setup, type Fixture } from "../../digest/helpers.js";

let f: Fixture;
beforeEach(async () => {
  f = await setup();
  await f.db.update(s.users).set({ digestDelivery: "smtp" }).where(eq(s.users.id, f.userId));
});
afterEach(() => f.t.close());

/** A second handle on the same database, as a separate process (`pnpm cli`) would have: its own in-process state. */
function otherProcessDb(db: Db): Db {
  return new Proxy(db, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as Db;
}

/** SMTP whose first submission hangs until released (slow server while the worker delivers). */
class SlowFirstSmtp extends FakeTransport {
  release!: () => void;
  private gate = new Promise<void>((r) => (this.release = r));
  private first = true;
  override async sendSmtp(settings: MailboxConnectionSettings, password: string, raw: Buffer, envelope: { from: string; to: string[] }) {
    const res = super.sendSmtp(settings, password, raw, envelope);
    if (this.first) {
      this.first = false;
      await this.gate;
    }
    return res;
  }
}

describe("cli-send-now-concurrent", () => {
  it("digest:send-now in another process does not deliver a second copy of a report the worker is delivering", async () => {
    await addTask(f, { dueDate: "2026-09-24" });
    const transport = new SlowFirstSmtp();
    const now = new Date(AT_0730.getTime() + 60_000);

    // Worker: claims the row and is inside the SMTP submission.
    const worker = dispatchDueDigests(makeDeps(f, transport, now), now);
    for (let i = 0; i < 200 && transport.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(transport.calls).toHaveLength(1); // precondition: the worker's send is in flight
    const [row] = await f.db.select().from(s.digests).where(eq(s.digests.userId, f.userId));
    expect(["pending", "rendered"]).toContain(row!.status);

    // Operator: `pnpm cli digest:send-now --user …` (no --retry) from a separate process.
    const cli = await deliverDigestForUser({ ...makeDeps(f, transport, now), db: otherProcessDb(f.db) }, f.userId, "2026-09-24", {});

    transport.release();
    await worker;
    expect(cli.status).not.toBe("delivered");
    expect(transport.calls.filter((c) => c.kind === "smtp")).toHaveLength(1);
  });
});

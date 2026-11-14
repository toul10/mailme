import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../src/db/schema.js";
import { dispatchDueDigests } from "../../../src/digest/dispatch.js";
import { classifyImapError } from "../../../src/mail/imap/errors.js";
import { MailTransportError } from "../../../src/mail/transport.js";
import { addTask, AT_0730, FakeTransport, makeDeps, setup, type Fixture } from "../../digest/helpers.js";

let f: Fixture;
beforeEach(async () => {
  f = await setup();
});
afterEach(() => f.t.close());

describe("too-many-backoff", () => {
  it("waits at least 15 minutes before logging in again after 'too many connections'", async () => {
    await addTask(f, { dueDate: "2026-09-24" });
    const transport = new FakeTransport();
    const err = new MailTransportError("too_many", "Maximum number of connections from user+IP exceeded", "LIMIT");
    expect(classifyImapError(err).kind).toBe("too_many"); // precondition
    transport.failures.push(err);

    await dispatchDueDigests(makeDeps(f, transport, AT_0730), AT_0730);
    expect(transport.calls).toHaveLength(1);
    const [row] = await f.db.select().from(s.digests).where(eq(s.digests.userId, f.userId));
    expect(row!.status).toBe("failed"); // precondition

    // The per-minute dispatcher keeps ticking for the next 14 minutes.
    for (let m = 1; m < 15; m++) {
      const at = new Date(AT_0730.getTime() + m * 60_000);
      await dispatchDueDigests(makeDeps(f, transport, at), at);
    }
    expect(transport.calls).toHaveLength(1);
    // The wait is a persisted retry timer (lease), so a worker restart in between does not shorten it; after 15 min it retries.
    const at15 = new Date(AT_0730.getTime() + 15 * 60_000);
    expect((await dispatchDueDigests(makeDeps(f, transport, at15), at15)).delivered).toBe(1);
    expect(transport.calls).toHaveLength(2);
  });
});

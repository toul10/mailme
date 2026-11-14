import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../src/db/schema.js";
import type { MailboxSummary } from "../../../src/server/api-types.js";
import { addUser, api, makeHarness, sessionFor, type Harness } from "../../server/helpers.js";

/**
 * API part of shadow-week-defaults-uncoupled: POST /api/mailboxes defaults live_since to now + 7 days (shadow week,
 * “Week 1, shadow: no report”), so it must also set users.digest_start_date when the user has none —
 * otherwise reports go out during the shadow week and spend the first-report handling before go-live.
 * (The CLI/dispatch parts are covered by the owner of src/cli and src/digest.)
 */
describe("shadow-week-defaults-uncoupled (API)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness(); // clock: 2026-09-15T07:00Z = 10:00 Europe/Athens
  });
  afterEach(async () => {
    await h.close();
  });

  const startDateOf = async (userId: string) =>
    (await h.t.db.select({ start: s.users.digestStartDate }).from(s.users).where(eq(s.users.id, userId)))[0]!.start;

  it("a new user's first mailbox (default shadow week) sets the report start to the local date of go-live", async () => {
    const u = await addUser(h, { email: "clerk@contoso.example" });
    const res = await api(h, await sessionFor(h, u.id), "POST", "/api/mailboxes", { address: "clerk@contoso.example", imapHost: "mail.contoso.example" });
    expect(res.statusCode).toBe(200);
    const [row] = await h.t.db.select().from(s.mailboxes).where(eq(s.mailboxes.id, (res.json() as MailboxSummary).id));
    expect(row!.liveSince!.toISOString()).toBe("2026-09-22T07:00:00.000Z");
    expect(await startDateOf(u.id)).toBe("2026-09-22");
  });

  it("the start date is the go-live date in the org's zone (late-evening UTC is the next local day)", async () => {
    h.clock.t = new Date("2026-09-15T22:30:00Z"); // 01:30 local on 09-16
    const u = await addUser(h, { email: "late@contoso.example" });
    await api(h, await sessionFor(h, u.id), "POST", "/api/mailboxes", { address: "late@contoso.example", imapHost: "mail.contoso.example" });
    expect(await startDateOf(u.id)).toBe("2026-09-23");
  });

  it("an explicit start date is kept", async () => {
    const u = await addUser(h, { email: "set@contoso.example" });
    await h.t.db.update(s.users).set({ digestStartDate: "2026-10-01" }).where(eq(s.users.id, u.id));
    await api(h, await sessionFor(h, u.id), "POST", "/api/mailboxes", { address: "set@contoso.example", imapHost: "mail.contoso.example" });
    expect(await startDateOf(u.id)).toBe("2026-10-01");
  });

  it("a second mailbox of a user whose reports already run does not silence them", async () => {
    // The seeded user has a live mailbox (live_since 2026-09-01) and no start date.
    const res = await api(h, await sessionFor(h, h.seed.user.id), "POST", "/api/mailboxes", { address: "sales@contoso.example", imapHost: "mail.contoso.example" });
    expect(res.statusCode).toBe(200);
    expect(await startDateOf(h.seed.user.id)).toBeNull();
  });
});

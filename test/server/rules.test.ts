import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as s from "../../src/db/schema.js";
import type { MailRulesView } from "../../src/server/api-types.js";
import { api, makeHarness, sessionFor, type Harness, type Session } from "./helpers.js";

/** "Rules": GET /api/rules and PATCH /api/rules/:id (on/off); the list itself comes from rules:import. */
describe("/api/rules", () => {
  let h: Harness;
  let me: Session;
  beforeEach(async () => {
    h = await makeHarness();
    me = await sessionFor(h, h.seed.user.id);
  });
  afterEach(async () => {
    await h.close();
  });

  const stored = [
    { id: "webinars", kind: "ignore", enabled: true, text: "Webinar: ignore", topics: ["webinar"] },
    { id: "broken", kind: "forward", text: "no target", topics: ["x"] },
  ];

  it("lists usable rules and names the unusable ones", async () => {
    expect((await api(h, me, "GET", "/api/rules")).json()).toEqual({ rules: [], skipped: [] } satisfies MailRulesView);
    await h.t.db.update(s.users).set({ mailRules: stored as never }).where(eq(s.users.id, h.seed.user.id));
    const res = await api(h, me, "GET", "/api/rules");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ rules: [stored[0]], skipped: [{ id: "broken", error: "forward needs a target address" }] });
  });

  it("switches one rule off and on, keeping the stored list (unusable rules included) as imported", async () => {
    await h.t.db.update(s.users).set({ mailRules: stored as never }).where(eq(s.users.id, h.seed.user.id));
    const off = await api(h, me, "PATCH", "/api/rules/webinars", { enabled: false });
    expect(off.statusCode).toBe(200);
    expect((off.json() as MailRulesView).rules[0]!.enabled).toBe(false);
    const [u] = await h.t.db.select().from(s.users).where(eq(s.users.id, h.seed.user.id));
    expect(u!.mailRules).toEqual([{ ...stored[0], enabled: false }, stored[1]]);
    expect((await api(h, me, "PATCH", "/api/rules/webinars", { enabled: true })).json()).toMatchObject({ rules: [{ id: "webinars", enabled: true }] });
    expect((await api(h, me, "PATCH", "/api/rules/broken", { enabled: false })).statusCode).toBe(404);
    expect((await api(h, me, "PATCH", "/api/rules/nope", { enabled: false })).statusCode).toBe(404);
    expect((await api(h, me, "PATCH", "/api/rules/webinars", { enabled: "yes" })).statusCode).toBe(400);
  });
});

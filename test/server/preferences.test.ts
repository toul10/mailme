import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as s from "../../src/db/schema.js";
import type { Preferences, TodayResponse } from "../../src/server/api-types.js";
import { insertTask } from "../helpers/db.js";
import { addUser, api, makeHarness, sessionFor, type Harness, type Session } from "./helpers.js";

/** "What matters to me": GET/PUT /api/preferences, one-click mute, and ★ on the lists. */
describe("/api/preferences", () => {
  let h: Harness;
  let me: Session;
  beforeEach(async () => {
    h = await makeHarness();
    me = await sessionFor(h, h.seed.user.id);
  });
  afterEach(async () => {
    await h.close();
  });

  const put = (body: unknown) => api(h, me, "PUT", "/api/preferences", body);
  const base = { important: [] as string[], muted: [] as string[], ccPolicy: "ask" as const, profile: null as string | null };

  it("starts empty, with “ask” for Cc and the user's own addresses and domains", async () => {
    const res = await api(h, me, "GET", "/api/preferences");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      important: [],
      muted: [],
      ccPolicy: "ask",
      profile: null,
      own: { internalDomains: ["contoso.example"], addresses: ["owner@contoso.example"] },
    } satisfies Preferences);
  });

  it("saves normalized lists, the Cc rule and the profile", async () => {
    const res = await put({ important: ["ABC Audio", "delta-events-gr.example", "abc audio"], muted: ["Offers@supplier-gr.example"], ccPolicy: "ignore", profile: "  Πωλήσεις ήχου. Όχι service.  " });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ important: ["ABC Audio", "@delta-events-gr.example"], muted: ["offers@supplier-gr.example"], ccPolicy: "ignore", profile: "Πωλήσεις ήχου. Όχι service." });
    const [u] = await h.t.db.select().from(s.users).where(eq(s.users.id, h.seed.user.id));
    expect(u).toMatchObject({ importantSenders: ["ABC Audio", "@delta-events-gr.example"], mutedSenders: ["offers@supplier-gr.example"], ccPolicy: "ignore", profileNote: "Πωλήσεις ήχου. Όχι service." });
  });

  it("explains a bad entry and refuses to mute the company's own domain or the user's address", async () => {
    const company = await put({ ...base, muted: ["ABC Audio"] });
    expect(company.statusCode).toBe(400);
    expect(company.json().error).toContain("ABC Audio");
    expect((await put({ ...base, muted: ["@contoso.example"] })).statusCode).toBe(400);
    expect((await put({ ...base, muted: ["owner@contoso.example"] })).statusCode).toBe(400);
    expect((await put({ ...base, ccPolicy: "always" })).statusCode).toBe(400);
    expect((await put({ ...base, profile: "x".repeat(601) })).statusCode).toBe(400);
    const [u] = await h.t.db.select().from(s.users).where(eq(s.users.id, h.seed.user.id));
    expect(u!.mutedSenders).toEqual([]);
  });

  it("adds one muted sender from a dismissal, idempotently, keeping the rest", async () => {
    await put({ ...base, important: ["ABC Audio"], ccPolicy: "create" });
    const first = await api(h, me, "POST", "/api/preferences/muted", { entry: "News@Promo.example" });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ important: ["ABC Audio"], muted: ["news@promo.example"], ccPolicy: "create" });
    const again = await api(h, me, "POST", "/api/preferences/muted", { entry: "news@promo.example" });
    expect((again.json() as Preferences).muted).toEqual(["news@promo.example"]);
    expect((await api(h, me, "POST", "/api/preferences/muted", { entry: "colleague@contoso.example" })).statusCode).toBe(400);
  });

  it("is per user and needs a full session", async () => {
    const other = await addUser(h, { email: "maria@contoso.example" });
    const maria = await sessionFor(h, other.id);
    await put({ ...base, important: ["ABC Audio"] });
    expect(((await api(h, maria, "GET", "/api/preferences")).json() as Preferences).important).toEqual([]);
    expect((await api(h, null, "GET", "/api/preferences")).statusCode).toBe(401);
    const halfway = await sessionFor(h, h.seed.user.id, false);
    expect((await api(h, halfway, "GET", "/api/preferences")).statusCode).toBe(401);
  });

  it("marks important tasks with ★ and puts them first in their section of Today", async () => {
    const seed = { orgId: h.seed.org.id, userId: h.seed.user.id, mailboxId: h.seed.mailbox.id };
    const plain = await insertTask(h.t.db, { ...seed, title: "Plain", company: "Zeta", counterparty: "a@zeta.example" });
    const vip = await insertTask(h.t.db, { ...seed, title: "VIP", company: "Δέλτα Events", counterparty: "g@delta-gr.example" });
    await h.t.db.update(s.tasks).set({ lastActivityAt: new Date("2026-09-01T08:00:00Z") }).where(eq(s.tasks.id, vip.id));

    const before = (await api(h, me, "GET", "/api/today")).json() as TodayResponse;
    expect(before.doNow.every((t) => t.important === false)).toBe(true);

    await put({ ...base, important: ["δελτα events"] });
    const after = (await api(h, me, "GET", "/api/today")).json() as TodayResponse;
    expect(after.doNow.map((t) => [t.id, t.important])).toEqual([
      [vip.id, true],
      [plain.id, false],
    ]);
    const list = (await api(h, me, "GET", "/api/tasks?tab=all")).json() as { items: Array<{ id: string; important: boolean }> };
    expect(list.items.find((t) => t.id === vip.id)?.important).toBe(true);
  });
});

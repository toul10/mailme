import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { newChatStats, type ChatStats } from "../../src/chat/engine.js";
import { createMockChatModel } from "../../src/chat/mock.js";
import { chatUsageToday, recordChat } from "../../src/chat/usage.js";
import * as s from "../../src/db/schema.js";
import { audit } from "../../src/server/audit.js";
import { sharedTestDb } from "../engine-db/fixtures.js";
import { seedOrgUserMailbox, type TestDb } from "../helpers/db.js";

const ZONE = "Europe/Athens";
const NOW = new Date("2026-11-20T10:00:00Z");

let t: TestDb;
let seed: Awaited<ReturnType<typeof seedOrgUserMailbox>>;
const shared = sharedTestDb();
beforeEach(async () => {
  t = shared();
  seed = await seedOrgUserMailbox(t.db);
});

const stats = (over: Partial<ChatStats> = {}): ChatStats => ({ ...newChatStats(createMockChatModel()), calls: 3, rounds: 2, lookups: 4, inputTokens: 21_000, outputTokens: 900, cachedTokens: 12_000, costUsd: 0.0421, sources: 2, outcome: "answer", ...over });

async function record(userId: string, at: string, over: Partial<ChatStats> = {}) {
  await recordChat(t.db, { orgId: seed.org.id, userId, ip: "203.0.113.9", stats: stats(over), ms: 8123.6 });
  const rows = await t.db.select().from(s.securityAudit);
  const last = rows.reduce((a, b) => (a.id > b.id ? a : b));
  await t.db.update(s.securityAudit).set({ createdAt: new Date(at) }).where(eq(s.securityAudit.id, last.id));
}

describe("the record of a question", () => {
  it("is one audit row with counts and codes, and nothing of what was asked or read", async () => {
    await recordChat(t.db, { orgId: seed.org.id, userId: seed.user.id, ip: "203.0.113.9", stats: stats(), ms: 8123.6 });
    const rows = await t.db.select().from(s.securityAudit);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event: "chat.ask", orgId: seed.org.id, userId: seed.user.id, ip: "203.0.113.9" });
    expect(rows[0]!.detail).toEqual({ outcome: "answer", model: "mock", calls: 3, rounds: 2, lookups: 4, sources: 2, inputTokens: 21_000, outputTokens: 900, cachedTokens: 12_000, costUsd: 0.0421, ms: 8124 });
  });
});

describe("today's use", () => {
  it("counts the user's questions since their midnight, and what everyone's questions cost", async () => {
    const other = await seedOrgUserMailbox(t.db, { address: "boss@contoso.example" });
    expect(await chatUsageToday(t.db, seed.user.id, ZONE, NOW)).toEqual({ questions: 0, usdAll: 0 });

    await record(seed.user.id, "2026-11-20T08:00:00Z", { costUsd: 0.04 });
    await record(seed.user.id, "2026-11-19T22:30:00Z", { costUsd: 0.01, outcome: "error:unavailable" }); // 00:30 on the 20th in Athens
    await record(seed.user.id, "2026-11-19T21:30:00Z", { costUsd: 5 }); // still the 19th there
    await record(other.user.id, "2026-11-20T09:00:00Z", { costUsd: 0.2, outcome: "aborted" });
    await audit(t.db, { orgId: seed.org.id, userId: seed.user.id, event: "auth.login_ok", detail: { costUsd: 99 } });

    const mine = await chatUsageToday(t.db, seed.user.id, ZONE, NOW);
    expect(mine.questions).toBe(2);
    expect(mine.usdAll).toBeCloseTo(0.25, 10);
    const theirs = await chatUsageToday(t.db, other.user.id, ZONE, NOW);
    expect(theirs.questions).toBe(1);
    expect(theirs.usdAll).toBeCloseTo(0.25, 10);
    // Another zone has another midnight: in UTC the 22:30 question belongs to yesterday.
    expect((await chatUsageToday(t.db, seed.user.id, "UTC", NOW)).questions).toBe(1);
    // The next day starts from nothing.
    expect(await chatUsageToday(t.db, seed.user.id, ZONE, new Date("2026-11-21T06:00:00Z"))).toEqual({ questions: 0, usdAll: 0 });
  });

  it("a row without a cost counts as a question and adds nothing", async () => {
    await audit(t.db, { orgId: seed.org.id, userId: seed.user.id, event: "chat.ask", detail: { outcome: "aborted" } });
    await audit(t.db, { orgId: seed.org.id, userId: seed.user.id, event: "chat.ask", detail: null });
    expect(await chatUsageToday(t.db, seed.user.id, ZONE, new Date(Date.now() + 60_000))).toEqual({ questions: 2, usdAll: 0 });
  });
});

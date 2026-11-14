import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import * as s from "../../src/db/schema.js";
import { assessFreshness, computeFreshness, isPausedValue, type FreshnessInput, type MailboxHealth } from "../../src/digest/freshness.js";
import { addMessage, AT_0730, setup, type Fixture } from "./helpers.js";

const NOW = AT_0730; // Thu 24 Sep 07:30 local
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000);

function mb(o: Partial<MailboxHealth> = {}): MailboxHealth {
  return { id: "m1", address: "owner@contoso.example", provider: "imap", status: "active", lastSyncAt: minutesAgo(5), aiPaused: false, aiPausedReason: null, ...o };
}

function input(o: Partial<FreshnessInput> = {}): FreshnessInput {
  return { now: NOW, zone: "Europe/Athens", mailboxes: [mb()], pendingCount: 0, oldestPendingAt: null, failedCount: 0, globalPaused: false, ...o };
}

describe("assessFreshness", () => {
  it("no banner when everything is fresh", () => {
    const { freshness, problems } = assessFreshness(input({ pendingCount: 2, oldestPendingAt: minutesAgo(10) }));
    expect(freshness).toEqual({ lastSyncAt: minutesAgo(5), staleMinutes: 5, pendingCount: 2, oldestPendingMinutes: 10, failedCount: 0, paused: false, banner: null });
    expect(problems).toEqual([]);
  });

  it("stale sync (> 60 min) → “Analysis incomplete since HH:MM”", () => {
    expect(assessFreshness(input({ mailboxes: [mb({ lastSyncAt: minutesAgo(60) })] })).freshness.banner).toBeNull();
    const r = assessFreshness(input({ mailboxes: [mb({ lastSyncAt: minutesAgo(70) })] }));
    expect(r.freshness.banner).toBe("Analysis incomplete since 06:20");
    expect(r.freshness.staleMinutes).toBe(70);
    expect(r.problems.map((p) => p.kind)).toEqual(["stale"]);
  });

  it("uses the day when the last sync was on another day", () => {
    const r = assessFreshness(input({ mailboxes: [mb({ lastSyncAt: new Date("2026-09-23T15:05:00Z") })] }));
    expect(r.freshness.banner).toBe("Analysis incomplete since Wed 23 Sep 18:05");
  });

  it("the oldest stale mailbox decides the time", () => {
    const r = assessFreshness(input({ mailboxes: [mb(), mb({ id: "m2", address: "sales@contoso.example", lastSyncAt: minutesAgo(125) })] }));
    expect(r.freshness.banner).toBe("Analysis incomplete since 05:25");
    expect(r.freshness.lastSyncAt).toEqual(minutesAgo(125));
  });

  it("failed messages → “N messages not analysed”", () => {
    expect(assessFreshness(input({ failedCount: 3 })).freshness.banner).toBe("3 messages not analysed");
    expect(assessFreshness(input({ failedCount: 1 })).freshness.banner).toBe("1 message not analysed");
  });

  it("auth_failed mailbox → “Your email password is needed again”", () => {
    const r = assessFreshness(input({ mailboxes: [mb({ status: "auth_failed", lastSyncAt: minutesAgo(200) })] }));
    expect(r.freshness.banner).toBe("Analysis incomplete since 04:10 · Your email password is needed again");
    expect(r.problems[0]).toEqual({ kind: "auth_failed", text: "The password for owner@contoso.example is not accepted. Enter it again in the MailMe settings." });
  });

  it("AI paused (mailbox budget or global) → banner and paused flag", () => {
    const perMailbox = assessFreshness(input({ mailboxes: [mb({ aiPaused: true, aiPausedReason: "daily budget" })] }));
    expect(perMailbox.freshness.paused).toBe(true);
    expect(perMailbox.freshness.banner).toBe("Analysis incomplete · AI analysis is paused");
    expect(perMailbox.problems[0]!.text).toContain("(daily limit)");
    const global = assessFreshness(input({ globalPaused: true, pendingCount: 4, oldestPendingAt: minutesAgo(90) }));
    expect(global.freshness.paused).toBe(true);
    expect(global.freshness.banner).toBe("Analysis incomplete since 06:00 · AI analysis is paused");
  });

  it("a pending queue older than 60 min makes the analysis incomplete", () => {
    const r = assessFreshness(input({ pendingCount: 12, oldestPendingAt: minutesAgo(95) }));
    expect(r.freshness.oldestPendingMinutes).toBe(95);
    expect(r.freshness.banner).toBe("Analysis incomplete since 05:55");
  });

  it("a mailbox that never synced is incomplete without a time", () => {
    const r = assessFreshness(input({ mailboxes: [mb({ lastSyncAt: null })] }));
    expect(r.freshness.banner).toBe("Analysis incomplete · No sync has finished yet");
    expect(r.freshness.lastSyncAt).toBeNull();
  });

  it("ignores mailboxes the user paused/disabled and ingest-only mailboxes for staleness", () => {
    const r = assessFreshness(
      input({
        mailboxes: [
          mb(),
          mb({ id: "m2", status: "paused", lastSyncAt: minutesAgo(900) }),
          mb({ id: "m3", status: "disabled", lastSyncAt: null }),
          mb({ id: "m4", status: "setup", lastSyncAt: null }),
          mb({ id: "m5", provider: "ingest", lastSyncAt: null }),
        ],
      }),
    );
    expect(r.freshness.banner).toBeNull();
  });

  it("combines several reasons in one banner", () => {
    const r = assessFreshness(input({ mailboxes: [mb({ status: "auth_failed", lastSyncAt: minutesAgo(70) })], failedCount: 2, globalPaused: true }));
    expect(r.freshness.banner).toBe("Analysis incomplete since 06:20 · Your email password is needed again · AI analysis is paused · 2 messages not analysed");
  });
});

describe("isPausedValue", () => {
  it("reads the usual encodings of a pause flag", () => {
    expect(isPausedValue(true)).toBe(true);
    expect(isPausedValue(false)).toBe(false);
    expect(isPausedValue(null)).toBe(false);
    expect(isPausedValue("true")).toBe(true);
    expect(isPausedValue({ paused: false, reason: "x" })).toBe(false);
    expect(isPausedValue({ paused: true })).toBe(true);
    expect(isPausedValue({ reason: "billing", at: "2026-09-24T04:00:00Z" })).toBe(true);
  });
});

describe("computeFreshness (DB)", () => {
  let f: Fixture;
  afterEach(() => f.t.close());

  it("counts pending/failed messages of the user's mailboxes and honours the global pause", async () => {
    f = await setup({ lastSyncAt: minutesAgo(3) });
    await addMessage(f, { state: "pending", firstSeenAt: minutesAgo(20) });
    await addMessage(f, { state: "extracted", firstSeenAt: minutesAgo(8) });
    await addMessage(f, { state: "failed" });
    await addMessage(f, { state: "applied" });
    let fr = await computeFreshness(f.db, f.userId, NOW);
    expect(fr).toMatchObject({ staleMinutes: 3, pendingCount: 2, oldestPendingMinutes: 20, failedCount: 1, paused: false, banner: "1 message not analysed" });

    await f.db.insert(s.appState).values({ key: "ai_global_pause", value: { reason: "billing" } });
    fr = await computeFreshness(f.db, f.userId, NOW);
    expect(fr.paused).toBe(true);
    expect(fr.banner).toContain("AI analysis is paused");

    await f.db.update(s.appState).set({ value: false }).where(eq(s.appState.key, "ai_global_pause"));
    await f.db.update(s.mailboxes).set({ status: "auth_failed" }).where(eq(s.mailboxes.id, f.mailboxId));
    fr = await computeFreshness(f.db, f.userId, NOW);
    expect(fr.paused).toBe(false);
    expect(fr.banner).toBe("Analysis incomplete since 07:27 · Your email password is needed again · 1 message not analysed");
  });
});

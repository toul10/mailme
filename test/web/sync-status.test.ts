import { describe, expect, it } from "vitest";
import type { HealthSummary, MailboxActivity } from "../../src/server/api-types.js";
import { describeSync, etaMinutes, isWorking, mailboxActivityLine, mailboxActivityState, resumeLabel } from "../../web/src/sync-status.js";

const NOW = new Date("2026-11-27T08:20:00Z"); // 10:20 Athens
const ctx = { now: NOW, zone: "Europe/Athens", names: new Map([["mb-p", "purchasing"], ["mb-m", "main"]]) };

function mailbox(over: Partial<MailboxActivity> = {}): MailboxActivity {
  return {
    id: "mb-m",
    address: "owner@contoso.example",
    provider: "imap",
    status: "active",
    lastSyncAt: "2026-11-27T08:11:00Z",
    analysing: false,
    queued: 0,
    done: 0,
    doneToday: 12,
    lastAnalysedAt: "2026-11-27T08:11:30Z",
    paused: null,
    resumesAt: null,
    ...over,
  };
}

function health(mailboxes: MailboxActivity[], over: Partial<HealthSummary["activity"]> = {}, failedCount = 0): HealthSummary {
  return {
    lastSyncAt: "2026-11-27T08:11:00Z",
    staleMinutes: 9,
    pendingCount: mailboxes.reduce((n, m) => n + m.queued, 0),
    oldestPendingMinutes: null,
    failedCount,
    paused: mailboxes.some((m) => m.paused !== null),
    banner: null,
    canSyncNow: true,
    activity: { running: false, runningSince: null, globalPaused: false, mailboxes, ...over },
  };
}

describe("describeSync", () => {
  it("nothing loaded yet", () => {
    expect(describeSync(null, ctx)).toEqual({ tone: "idle", title: "Sync", detail: null, progress: null });
  });

  it("up to date: when it last checked", () => {
    expect(describeSync(health([mailbox()]), ctx)).toEqual({ tone: "ok", title: "All up to date", detail: "Last check 9 minutes ago", progress: null });
  });

  it("a pass checking for new mail: a bar with nothing to count", () => {
    expect(describeSync(health([mailbox()], { running: true, runningSince: "2026-11-27T08:19:50Z" }), ctx)).toEqual({
      tone: "live",
      title: "Checking for new email…",
      detail: null,
      progress: "busy",
    });
  });

  it("a pass reading a mailbox: how many of how many, where, and how long at this pace", () => {
    const reading = mailbox({ id: "mb-p", address: "purchasing@contoso.example", analysing: true, done: 45, queued: 47 });
    const v = describeSync(health([reading, mailbox()], { running: true, runningSince: "2026-11-27T08:10:00Z" }), ctx);
    // 45 in 10 minutes: 47 more take about 11.
    expect(v).toEqual({ tone: "live", title: "Analysing email: 45 of 92", detail: "purchasing · about 11 minutes left", progress: 45 / 92 });
  });

  it("a long-running worker reading a mailbox: the same progress without a pass, and no time left to guess", () => {
    // `pnpm start:worker` never holds the tick's lock, so `running` stays false while its drains show.
    const reading = mailbox({ id: "mb-p", address: "purchasing@contoso.example", analysing: true, done: 5, queued: 15 });
    expect(describeSync(health([reading, mailbox()]), ctx)).toEqual({ tone: "live", title: "Analysing email: 5 of 20", detail: "purchasing", progress: 0.25 });
    expect(describeSync(health([mailbox({ analysing: true })]), ctx)).toMatchObject({ tone: "live", title: "Analysing new email…", progress: "busy" });
  });

  it("a daily-budget pause: which mailbox, how many wait, when it goes on", () => {
    const paused = mailbox({ id: "mb-p", address: "purchasing@contoso.example", paused: "budget:usd", queued: 39, resumesAt: "2026-11-27T22:00:00Z" });
    expect(describeSync(health([paused, mailbox()]), ctx)).toEqual({
      tone: "warn",
      title: "Analysis paused: daily limit",
      detail: "purchasing · 39 emails waiting · resumes at midnight",
      progress: null,
    });
  });

  it("a password the server refuses comes before everything else, even a running pass", () => {
    const v = describeSync(health([mailbox({ status: "auth_failed" })], { running: true }), ctx);
    expect(v).toMatchObject({ tone: "error", title: "Sync: problem", detail: "main: the password is not accepted" });
  });

  it("the global AI pause", () => {
    expect(describeSync(health([mailbox()], { globalPaused: true }), ctx)).toMatchObject({ tone: "error", title: "AI analysis stopped" });
  });

  it("the global AI pause is not hidden by a running pass or a drain", () => {
    const v = describeSync(health([mailbox({ analysing: true, queued: 4, done: 3 })], { running: true, runningSince: "2026-11-27T08:10:00Z", globalPaused: true }), ctx);
    expect(v).toMatchObject({ tone: "error", title: "AI analysis stopped", progress: null });
  });

  it("a mailbox not checked for over half an hour is late", () => {
    const v = describeSync(health([mailbox({ lastSyncAt: "2026-11-27T07:40:00Z" }), mailbox({ id: "mb-p", address: "purchasing@contoso.example" })]), ctx);
    expect(v).toEqual({ tone: "warn", title: "Sync is late", detail: "main: last check 40 minutes ago", progress: null });
  });

  it("mail that has waited over an hour is late analysis, never \"all up to date\"", () => {
    const h = { ...health([mailbox({ queued: 7 })]), oldestPendingMinutes: 125 };
    expect(describeSync(h, ctx)).toEqual({ tone: "warn", title: "Analysis is late", detail: "7 emails waiting · the oldest arrived 2 hours ago", progress: null });
    // A running pass still shows its progress, and a pause says why the mail waits.
    expect(describeSync({ ...h, activity: { ...h.activity, running: true, runningSince: "2026-11-27T08:19:50Z" } }, ctx).tone).toBe("live");
    const paused = { ...health([mailbox({ queued: 7, paused: "budget:calls", resumesAt: "2026-11-27T22:00:00Z" })]), oldestPendingMinutes: 125 };
    expect(describeSync(paused, ctx).title).toBe("Analysis paused: daily limit");
    expect(describeSync({ ...h, oldestPendingMinutes: 60 }, ctx).title).toBe("7 new emails queued");
  });

  it("mail waiting for the next pass, and messages that could not be analysed", () => {
    expect(describeSync(health([mailbox({ queued: 3 })]), ctx)).toMatchObject({ tone: "ok", title: "3 new emails queued", detail: "Analysed in the next pass · last check 9 minutes ago" });
    expect(describeSync(health([mailbox({ queued: 1 })]), ctx).title).toBe("1 new email queued");
    expect(describeSync(health([mailbox()], {}, 2), ctx)).toMatchObject({ tone: "warn", title: "2 emails not analysed" });
  });

  it("ignores mailboxes the user switched off, and the sync age of pushed (ingest) ones", () => {
    const v = describeSync(health([mailbox(), mailbox({ id: "x", status: "paused", lastSyncAt: null }), mailbox({ id: "y", provider: "ingest", lastSyncAt: null })]), ctx);
    expect(v.title).toBe("All up to date");
  });
});

describe("helpers", () => {
  it("etaMinutes needs a few messages and half a minute of pace", () => {
    expect(etaMinutes({ done: 2, queued: 10 }, "2026-11-27T08:10:00Z", NOW)).toBeNull();
    expect(etaMinutes({ done: 10, queued: 10 }, "2026-11-27T08:19:50Z", NOW)).toBeNull();
    expect(etaMinutes({ done: 10, queued: 0 }, "2026-11-27T08:10:00Z", NOW)).toBeNull();
    expect(etaMinutes({ done: 10, queued: 5 }, "2026-11-27T08:10:00Z", NOW)).toBe(5);
    expect(etaMinutes({ done: 10, queued: 5 }, null, NOW)).toBeNull();
  });

  it("resumeLabel", () => {
    expect(resumeLabel("2026-11-27T22:00:00Z", "Europe/Athens")).toBe("at midnight");
    expect(resumeLabel("2026-11-27T12:05:00Z", "Europe/Athens")).toBe("at 14:05");
  });

  it("isWorking: a pass, or a drain without one; the shell then reads /api/health every 5 seconds", () => {
    expect(isWorking(null)).toBe(false);
    expect(isWorking(health([mailbox()]))).toBe(false);
    expect(isWorking(health([mailbox()], { running: null }))).toBe(false);
    expect(isWorking(health([mailbox()], { running: true }))).toBe(true);
    expect(isWorking(health([mailbox({ analysing: true })]))).toBe(true);
  });

  it("the mailbox line and chip of \"System status\"", () => {
    const m = mailbox({ queued: 39, paused: "budget:calls", resumesAt: "2026-11-27T22:00:00Z" });
    expect(mailboxActivityLine(m, ctx)).toBe("synced 9 minutes ago · 12 analysed today · 39 waiting · resumes at midnight");
    expect(mailboxActivityLine(mailbox({ provider: "ingest" }), ctx)).toBe("12 analysed today");
    expect(mailboxActivityState(m)).toEqual({ label: "Paused: daily limit", tone: "warn" });
    expect(mailboxActivityState(mailbox({ analysing: true }))).toEqual({ label: "Analysing now", tone: "live" });
    expect(mailboxActivityState(mailbox({ status: "auth_failed" }))).toEqual({ label: "Sign-in failed", tone: "error" });
    expect(mailboxActivityState(mailbox())).toEqual({ label: "OK", tone: "ok" });
  });
});

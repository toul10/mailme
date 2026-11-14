import { describe, expect, it } from "vitest";
import {
  addDays,
  agoLabel,
  counterpartyLabel,
  daysBetween,
  deadlineChip,
  formatDateLong,
  formatDateShort,
  formatDateTime,
  formatDayMonth,
  formatKb,
  groupSecret,
  isIsoDate,
  nextMonday,
  nextWeekday,
  normalizeTotpCode,
  snoozeLabel,
  suggestionsLabel,
  todayIn,
  waitingLabel,
  weekdayOf,
} from "../../web/src/format.js";

const TODAY = "2026-09-24"; // Thursday

describe("calendar arithmetic", () => {
  it("adds days across month and year ends", () => {
    expect(addDays("2026-09-30", 1)).toBe("2026-10-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(daysBetween("2026-09-24", "2026-09-22")).toBe(-2);
    expect(daysBetween("2026-03-28", "2026-03-30")).toBe(2); // DST weekend in Europe
  });

  it("knows weekdays without the browser's timezone", () => {
    expect(weekdayOf(TODAY)).toBe(4);
    expect(nextWeekday("2026-09-25")).toBe("2026-09-28"); // Fri → Mon
    expect(nextWeekday(TODAY)).toBe("2026-09-25");
    expect(nextMonday(TODAY)).toBe("2026-09-28");
    expect(nextMonday("2026-09-28")).toBe("2026-10-05");
    expect(nextMonday("2026-09-27")).toBe("2026-09-28"); // Sunday
  });

  it("validates ISO dates strictly", () => {
    expect(isIsoDate("2026-09-24")).toBe(true);
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(isIsoDate("24/09/2026")).toBe(false);
  });
});

describe("date labels", () => {
  it("formats day and month (en-GB order) with an English weekday", () => {
    expect(formatDayMonth("2026-09-04")).toBe("4 Sep");
    expect(formatDayMonth("2025-12-31", TODAY)).toBe("31 Dec 2025");
    expect(formatDateShort(TODAY)).toBe("Thu 24 Sep");
    expect(formatDateShort("2026-09-27")).toBe("Sun 27 Sep");
    expect(formatDateLong("2026-09-26")).toBe("Saturday 26 Sep");
  });

  it("computes today in the user's zone, not the machine's", () => {
    // 22:30 UTC on the 24th is already the 25th in Athens (UTC+3 in September).
    const late = new Date("2026-09-24T22:30:00Z");
    expect(todayIn("Europe/Athens", late)).toBe("2026-09-25");
    expect(todayIn("UTC", late)).toBe("2026-09-24");
  });

  it("formats instants relative to today", () => {
    expect(formatDateTime("2026-09-24T07:02:00Z", "Europe/Athens", TODAY)).toBe("Today 10:02");
    expect(formatDateTime("2026-09-23T15:40:00Z", "Europe/Athens", TODAY)).toBe("Yesterday 18:40");
    expect(formatDateTime("2026-09-22T06:15:00Z", "Europe/Athens", TODAY)).toBe("Tue 22 Sep 09:15");
    expect(formatDateTime("not a date", "Europe/Athens", TODAY)).toBe("");
  });

  it("describes elapsed time", () => {
    expect(agoLabel(0.2)).toBe("just now");
    expect(agoLabel(1)).toBe("1 minute ago");
    expect(agoLabel(45)).toBe("45 minutes ago");
    expect(agoLabel(125)).toBe("2 hours ago");
    expect(agoLabel(60 * 72)).toBe("3 days ago");
    expect(agoLabel(null)).toBeNull();
  });
});

describe("deadline chip", () => {
  const base = { status: "ACTION_REQUIRED" as const, dueDate: null, duePhrase: null, overdue: false, expectReplyBy: null };

  it("marks overdue red and today orange", () => {
    expect(deadlineChip({ ...base, dueDate: "2026-09-22", overdue: true }, TODAY)).toMatchObject({ tone: "overdue", text: "Overdue · Tue 22 Sep" });
    expect(deadlineChip({ ...base, dueDate: "2026-09-22" }, TODAY)?.tone).toBe("overdue");
    expect(deadlineChip({ ...base, dueDate: TODAY }, TODAY)).toMatchObject({ tone: "today", text: "Today" });
    expect(deadlineChip({ ...base, dueDate: "2026-09-25" }, TODAY)).toMatchObject({ tone: "soon", text: "Tomorrow" });
    expect(deadlineChip({ ...base, dueDate: "2026-09-30" }, TODAY)).toMatchObject({ tone: "normal", text: "Due Wed 30 Sep" });
  });

  it("phrases promises and vague deadlines", () => {
    expect(deadlineChip({ ...base, status: "WAITING_FOR_ME", dueDate: "2026-09-30" }, TODAY)?.text).toBe("Promised for Wed 30 Sep");
    expect(deadlineChip({ ...base, status: "WAITING_FOR_ME", dueDate: TODAY }, TODAY)?.text).toBe("Promised for today");
    expect(deadlineChip({ ...base, duePhrase: "αρχές Οκτωβρίου" }, TODAY)).toMatchObject({ text: "αρχές Οκτωβρίου", tone: "normal" });
  });

  it("uses the reply-by date for waiting tasks and mutes closed ones", () => {
    expect(deadlineChip({ ...base, status: "WAITING_FOR_OTHER", expectReplyBy: "2026-09-28" }, TODAY)?.text).toBe("Reply by Mon 28 Sep");
    expect(deadlineChip({ ...base, status: "WAITING_FOR_OTHER", expectReplyBy: "2026-09-21" }, TODAY)).toMatchObject({ tone: "today", text: "Follow up · since Mon 21 Sep" });
    expect(deadlineChip({ ...base, status: "COMPLETED", dueDate: "2026-09-01", overdue: true }, TODAY)?.tone).toBe("muted");
    expect(deadlineChip(base, TODAY)).toBeNull();
  });
});

describe("counters and small labels", () => {
  it("counts waiting business days", () => {
    expect(waitingLabel("WAITING_FOR_OTHER", 4)).toBe("waiting 4 business days");
    expect(waitingLabel("WAITING_FOR_OTHER", 1)).toBe("waiting 1 business day");
    expect(waitingLabel("WAITING_FOR_OTHER", 0)).toBe("waiting since today");
    expect(waitingLabel("WAITING_FOR_ME", 2)).toBe("you promised 2 business days ago");
    expect(waitingLabel("ACTION_REQUIRED", 3)).toBeNull();
    expect(waitingLabel("WAITING_FOR_OTHER", null)).toBeNull();
  });

  it("labels suggestions, snoozes and counterparties", () => {
    expect(suggestionsLabel(0)).toBeNull();
    expect(suggestionsLabel(1)).toBe("1 suggestion");
    expect(suggestionsLabel(3)).toBe("3 suggestions");
    expect(snoozeLabel({ snoozeMode: "until_reply", snoozedUntil: null }, TODAY)).toBe("Snoozed until they reply");
    expect(snoozeLabel({ snoozeMode: "until_date", snoozedUntil: "2026-09-30" }, TODAY)).toBe("Snoozed until Wed 30 Sep");
    expect(snoozeLabel({ snoozeMode: null, snoozedUntil: null }, TODAY)).toBeNull();
    expect(counterpartyLabel({ counterpartyName: "Γ. Παπαδόπουλος", counterpartyAddress: "gp@abc-gr.example" })).toBe("Γ. Παπαδόπουλος <gp@abc-gr.example>");
    expect(counterpartyLabel({ counterpartyName: " ", counterpartyAddress: "gp@abc-gr.example" })).toBe("gp@abc-gr.example");
    expect(counterpartyLabel({ counterpartyName: null, counterpartyAddress: null })).toBeNull();
  });

  it("formats sizes, TOTP secrets and codes", () => {
    expect(formatKb(512)).toBe("512 KB");
    expect(formatKb(1536)).toBe("1.5 MB");
    expect(formatKb(5 * 1024 * 1024)).toBe("5.0 GB");
    expect(groupSecret("JBSWY3DPEHPK3PXP")).toBe("JBSW Y3DP EHPK 3PXP");
    expect(normalizeTotpCode(" 123 456 ")).toBe("123456");
    expect(normalizeTotpCode("12-34-56")).toBe("123456");
  });
});

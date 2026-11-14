import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import type { DueKind, DueSpec, Weekday } from "../../src/ai/schema.js";
import { addBusinessDays, isBusinessDate, resolveDue } from "../../src/engine/due.js";

const ZONE = "Europe/Athens";

/** Local Athens wall-clock time → instant. */
const at = (local: string): Date => DateTime.fromISO(local, { zone: ZONE }).toJSDate();

function spec(kind: DueKind, phrase: string, extra: Partial<DueSpec> = {}): DueSpec {
  return { phrase, kind, absolute_date: null, weekday: null, amount: null, segment_id: null, model_date: null, ...extra };
}

interface Row {
  name: string;
  anchor: string;
  spec: DueSpec;
  expected: string | null;
  holySpirit?: boolean;
  reason?: string;
}

const wd = (w: Weekday) => ({ weekday: w });
const n = (amount: number) => ({ amount });

// Weekdays (checked with luxon): 2026-09-21 Mon … 2026-09-27 Sun; 2026-10-25 Sun (DST ends); 2026-10-28 Wed (holiday);
// 2027-03-28 Sun (DST starts); 2027-04-30 Fri (Good Friday); 2027-05-03 Mon (Easter Monday); 2027-06-21 Mon (Holy Spirit).
const rows: Row[] = [
  // WEEKDAY
  { name: "«την Παρασκευή» on a Wednesday → this Friday", anchor: "2026-09-23T10:00", spec: spec("WEEKDAY", "την Παρασκευή", wd("FRI")), expected: "2026-09-25" },
  { name: "«την Παρασκευή» on a Friday → next Friday", anchor: "2026-09-25T10:00", spec: spec("WEEKDAY", "την Παρασκευή", wd("FRI")), expected: "2026-10-02" },
  { name: "«σήμερα Παρασκευή» on a Friday → today", anchor: "2026-09-25T10:00", spec: spec("WEEKDAY", "σήμερα Παρασκευή", wd("FRI")), expected: "2026-09-25" },
  { name: "«Δευτέρα» said on a Monday → next Monday", anchor: "2026-09-21T09:00", spec: spec("WEEKDAY", "τη Δευτέρα", wd("MON")), expected: "2026-09-28" },
  { name: "Friday said on a Saturday → next Friday", anchor: "2026-09-26T12:00", spec: spec("WEEKDAY", "την Παρασκευή", wd("FRI")), expected: "2026-10-02" },
  { name: "Monday said on a Sunday → tomorrow", anchor: "2026-09-27T20:00", spec: spec("WEEKDAY", "Δευτέρα", wd("MON")), expected: "2026-09-28" },
  { name: "Tuesday said on a Thursday → next week's Tuesday", anchor: "2026-09-24T11:00", spec: spec("WEEKDAY", "την Τρίτη", wd("TUE")), expected: "2026-09-29" },
  { name: "weekday from phrase when the model left it null", anchor: "2026-09-21T09:00", spec: spec("WEEKDAY", "μέχρι την Πέμπτη"), expected: "2026-09-24", reason: "weekday_from_phrase" },
  { name: "English weekday from phrase", anchor: "2026-09-21T09:00", spec: spec("WEEKDAY", "by Friday"), expected: "2026-09-25" },
  { name: "two weekdays in the phrase → ambiguous", anchor: "2026-09-21T09:00", spec: spec("WEEKDAY", "Δευτέρα ή Τρίτη"), expected: null, reason: "ambiguous_weekday" },
  { name: "no weekday anywhere → null", anchor: "2026-09-21T09:00", spec: spec("WEEKDAY", "σύντομα"), expected: null, reason: "missing_weekday" },
  { name: "DST end: Sunday 01:30 EEST, «την Τρίτη»", anchor: "2026-10-25T01:30", spec: spec("WEEKDAY", "την Τρίτη", wd("TUE")), expected: "2026-10-27" },

  // NEXT_WEEKDAY
  { name: "«την επόμενη Τρίτη» on a Wednesday → Tuesday of next week", anchor: "2026-09-23T10:00", spec: spec("NEXT_WEEKDAY", "την επόμενη Τρίτη", wd("TUE")), expected: "2026-09-29" },
  { name: "«την επόμενη Παρασκευή» on a Monday → Friday of next week", anchor: "2026-09-21T10:00", spec: spec("NEXT_WEEKDAY", "την επόμενη Παρασκευή", wd("FRI")), expected: "2026-10-02" },
  { name: "«την επόμενη Δευτέρα» on a Sunday → the Monday of the following ISO week", anchor: "2026-09-27T18:00", spec: spec("NEXT_WEEKDAY", "την επόμενη Δευτέρα", wd("MON")), expected: "2026-09-28" },
  { name: "«next Friday» on a Friday → +7", anchor: "2026-09-25T16:00", spec: spec("NEXT_WEEKDAY", "next Friday", wd("FRI")), expected: "2026-10-02" },
  { name: "Saturday 23:30 before DST start, «την άλλη Τετάρτη»", anchor: "2027-03-27T23:30", spec: spec("NEXT_WEEKDAY", "την άλλη Τετάρτη", wd("WED")), expected: "2027-03-31" },

  // RELATIVE_DAYS
  { name: "«αύριο» at 00:40 local in summer (UTC+3) → next local day", anchor: "2026-09-25T00:40", spec: spec("RELATIVE_DAYS", "αύριο", n(1)), expected: "2026-09-26" },
  { name: "«αύριο» at 00:40 local in winter (UTC+2) → next local day", anchor: "2026-12-16T00:40", spec: spec("RELATIVE_DAYS", "αύριο", n(1)), expected: "2026-12-17" },
  { name: "«σήμερα» → the anchor day", anchor: "2026-09-23T18:00", spec: spec("RELATIVE_DAYS", "σήμερα", n(0)), expected: "2026-09-23" },
  { name: "«σε 3 μέρες» crosses a weekend (calendar days)", anchor: "2026-09-24T10:00", spec: spec("RELATIVE_DAYS", "σε 3 μέρες", n(3)), expected: "2026-09-27" },
  { name: "«μεθαύριο» with no amount → +2 from phrase", anchor: "2026-09-23T10:00", spec: spec("RELATIVE_DAYS", "μεθαύριο"), expected: "2026-09-25", reason: "amount_from_phrase" },
  { name: "«αύριο το πρωί» with no amount → +1 from phrase", anchor: "2026-09-23T10:00", spec: spec("RELATIVE_DAYS", "αύριο το πρωί"), expected: "2026-09-24" },
  { name: "negative amount → null", anchor: "2026-09-23T10:00", spec: spec("RELATIVE_DAYS", "χθες", n(-1)), expected: null, reason: "invalid_amount" },
  { name: "DST start night: «αύριο» at 00:30 on 28 Mar 2027", anchor: "2027-03-28T00:30", spec: spec("RELATIVE_DAYS", "αύριο", n(1)), expected: "2027-03-29" },
  { name: "DST end night: «αύριο» at 00:30 on 25 Oct 2026", anchor: "2026-10-25T00:30", spec: spec("RELATIVE_DAYS", "αύριο", n(1)), expected: "2026-10-26" },
  { name: "+366 days is the horizon (allowed)", anchor: "2026-09-23T10:00", spec: spec("RELATIVE_DAYS", "σε ένα χρόνο", n(366)), expected: "2027-09-24" },
  { name: "+400 days → beyond horizon", anchor: "2026-09-23T10:00", spec: spec("RELATIVE_DAYS", "σε 400 μέρες", n(400)), expected: null, reason: "beyond_horizon" },

  // BUSINESS_DAYS
  { name: "«σε 2 εργάσιμες» from a Friday → Tuesday", anchor: "2026-09-25T10:00", spec: spec("BUSINESS_DAYS", "σε 2 εργάσιμες", n(2)), expected: "2026-09-29" },
  { name: "skips 28 October", anchor: "2026-10-27T10:00", spec: spec("BUSINESS_DAYS", "σε μία εργάσιμη", n(1)), expected: "2026-10-29" },
  { name: "skips Good Friday and Easter Monday 2027", anchor: "2027-04-29T10:00", spec: spec("BUSINESS_DAYS", "την επόμενη εργάσιμη", n(1)), expected: "2027-05-04" },
  { name: "Holy Spirit Monday is a business day by default", anchor: "2027-06-18T10:00", spec: spec("BUSINESS_DAYS", "την επόμενη εργάσιμη", n(1)), expected: "2027-06-21" },
  { name: "Holy Spirit Monday skipped with the option", anchor: "2027-06-18T10:00", spec: spec("BUSINESS_DAYS", "την επόμενη εργάσιμη", n(1)), expected: "2027-06-22", holySpirit: true },
  { name: "weekend anchor: +1 business day from Saturday → Monday", anchor: "2026-09-26T10:00", spec: spec("BUSINESS_DAYS", "σε μία εργάσιμη", n(1)), expected: "2026-09-28" },
  { name: "0 business days on a Saturday → next Monday", anchor: "2026-09-26T10:00", spec: spec("BUSINESS_DAYS", "εντός της ημέρας", n(0)), expected: "2026-09-28" },
  { name: "0 business days on a Wednesday → same day", anchor: "2026-09-23T10:00", spec: spec("BUSINESS_DAYS", "εντός της ημέρας", n(0)), expected: "2026-09-23" },
  { name: "Christmas Eve +1 → Monday 28 Dec", anchor: "2026-12-24T10:00", spec: spec("BUSINESS_DAYS", "σε μία εργάσιμη", n(1)), expected: "2026-12-28" },
  { name: "New Year's Eve +1 → Monday 4 Jan", anchor: "2026-12-31T10:00", spec: spec("BUSINESS_DAYS", "σε μία εργάσιμη", n(1)), expected: "2027-01-04" },
  { name: "missing amount → null", anchor: "2026-09-23T10:00", spec: spec("BUSINESS_DAYS", "σε λίγες εργάσιμες"), expected: null, reason: "missing_amount" },

  // END_OF_WEEK
  { name: "end of week on a Wednesday → Friday", anchor: "2026-09-23T10:00", spec: spec("END_OF_WEEK", "μέχρι το τέλος της εβδομάδας"), expected: "2026-09-25" },
  { name: "end of week on a Friday → today", anchor: "2026-09-25T10:00", spec: spec("END_OF_WEEK", "μέσα στην εβδομάδα"), expected: "2026-09-25" },
  { name: "end of week on a Saturday → next Friday", anchor: "2026-09-26T10:00", spec: spec("END_OF_WEEK", "μέχρι το τέλος της εβδομάδας"), expected: "2026-10-02" },
  { name: "end of week on a Sunday → next Friday", anchor: "2026-09-27T10:00", spec: spec("END_OF_WEEK", "within the week"), expected: "2026-10-02" },
  { name: "end of week in Holy Week → Friday (holidays ignored for END_OF_WEEK)", anchor: "2027-04-28T10:00", spec: spec("END_OF_WEEK", "μέχρι το τέλος της εβδομάδας"), expected: "2027-04-30" },

  // END_OF_MONTH
  { name: "end of September 2026 → Wednesday 30th", anchor: "2026-09-23T10:00", spec: spec("END_OF_MONTH", "μέχρι το τέλος του μήνα"), expected: "2026-09-30" },
  { name: "October 2026 ends on Saturday → Friday 30th", anchor: "2026-10-26T10:00", spec: spec("END_OF_MONTH", "τέλος του μήνα"), expected: "2026-10-30" },
  { name: "anchor on the last (Saturday) day → that day", anchor: "2026-10-31T10:00", spec: spec("END_OF_MONTH", "τέλος του μήνα"), expected: "2026-10-31", reason: "no_business_day_left_in_month" },
  { name: "April 2027 ends on Good Friday → Thursday 29th", anchor: "2027-04-15T10:00", spec: spec("END_OF_MONTH", "έως το τέλος Απριλίου"), expected: "2027-04-29" },
  { name: "February 2027 ends on Sunday → Friday 26th", anchor: "2027-02-10T10:00", spec: spec("END_OF_MONTH", "τέλος του μήνα"), expected: "2027-02-26" },
  { name: "end of December 2026 → Thursday 31st", anchor: "2026-12-16T10:00", spec: spec("END_OF_MONTH", "end of month"), expected: "2026-12-31" },

  // ABSOLUTE
  { name: "«έως 15/10» → 15 Oct", anchor: "2026-09-23T10:00", spec: spec("ABSOLUTE", "έως 15/10", { absolute_date: "2026-10-15" }), expected: "2026-10-15" },
  { name: "«έως 15/1» written in December with last year's date → rolled forward", anchor: "2026-12-16T10:00", spec: spec("ABSOLUTE", "έως 15/1", { absolute_date: "2026-01-15" }), expected: "2027-01-15", reason: "year_rolled_forward" },
  { name: "phrase with a year is never rolled → past → null", anchor: "2026-12-16T10:00", spec: spec("ABSOLUTE", "έως 15/01/2026", { absolute_date: "2026-01-15" }), expected: null, reason: "before_anchor" },
  { name: "2-digit year counts as a year", anchor: "2026-12-16T10:00", spec: spec("ABSOLUTE", "15.1.26", { absolute_date: "2026-01-15" }), expected: null, reason: "before_anchor" },
  { name: "recent past (< 2 months) is not rolled → null", anchor: "2026-09-23T10:00", spec: spec("ABSOLUTE", "έως 10/9", { absolute_date: "2026-09-10" }), expected: null, reason: "before_anchor" },
  { name: "holiday dates stay as given (28 Οκτωβρίου)", anchor: "2026-09-23T10:00", spec: spec("ABSOLUTE", "28 Οκτωβρίου", { absolute_date: "2026-10-28" }), expected: "2026-10-28" },
  { name: "impossible date → null", anchor: "2026-09-23T10:00", spec: spec("ABSOLUTE", "30 Φεβρουαρίου", { absolute_date: "2027-02-30" }), expected: null, reason: "invalid_absolute_date" },
  { name: "non-ISO format → null", anchor: "2026-09-23T10:00", spec: spec("ABSOLUTE", "15/10/2026", { absolute_date: "15/10/2026" }), expected: null, reason: "invalid_absolute_date" },
  { name: "missing absolute_date → null", anchor: "2026-09-23T10:00", spec: spec("ABSOLUTE", "15 Οκτωβρίου"), expected: null, reason: "invalid_absolute_date" },
  { name: "more than 366 days ahead → null", anchor: "2026-09-23T10:00", spec: spec("ABSOLUTE", "15/1/2028", { absolute_date: "2028-01-15" }), expected: null, reason: "beyond_horizon" },
  { name: "ABSOLUTE equal to the anchor day is fine", anchor: "2026-09-23T23:50", spec: spec("ABSOLUTE", "σήμερα 23/9", { absolute_date: "2026-09-23" }), expected: "2026-09-23" },

  // VAGUE
  { name: "«αρχές Οκτωβρίου» → no date", anchor: "2026-09-23T10:00", spec: spec("VAGUE", "αρχές Οκτωβρίου"), expected: null, reason: "vague" },
  { name: "«ASAP» → no date", anchor: "2026-09-23T10:00", spec: spec("VAGUE", "ASAP"), expected: null, reason: "vague" },
];

describe("resolveDue — table", () => {
  it("has at least 40 rows", () => expect(rows.length).toBeGreaterThanOrEqual(40));

  it.each(rows)("$name", (row) => {
    const res = resolveDue(row.spec, at(row.anchor), ZONE, { holySpirit: row.holySpirit ?? false });
    expect(res.date).toBe(row.expected);
    if (row.reason) expect(res.reasons).toContain(row.reason);
    expect(res.agrees).toBeNull();
  });
});

describe("resolveDue — model date cross-check", () => {
  const anchor = at("2026-09-23T10:00");

  it("agrees when the model's date matches", () => {
    const res = resolveDue(spec("WEEKDAY", "την Παρασκευή", { weekday: "FRI", model_date: "2026-09-25" }), anchor, ZONE);
    expect(res).toMatchObject({ date: "2026-09-25", agrees: true });
  });

  it("disagrees when the model picked another day", () => {
    const res = resolveDue(spec("WEEKDAY", "την Παρασκευή", { weekday: "FRI", model_date: "2026-10-02" }), anchor, ZONE);
    expect(res).toMatchObject({ date: "2026-09-25", agrees: false });
    expect(res.reasons).toContain("model_date_disagrees");
  });

  it("a malformed model date is a disagreement", () => {
    const res = resolveDue(spec("RELATIVE_DAYS", "αύριο", { amount: 1, model_date: "24/9" }), anchor, ZONE);
    expect(res).toMatchObject({ date: "2026-09-24", agrees: false });
    expect(res.reasons).toContain("model_date_invalid");
  });

  it("a date for a VAGUE phrase disagrees with null", () => {
    const res = resolveDue(spec("VAGUE", "αρχές Οκτωβρίου", { model_date: "2026-10-01" }), anchor, ZONE);
    expect(res).toMatchObject({ date: null, agrees: false });
  });

  it("a rolled-forward ABSOLUTE agrees with the model's next-year date", () => {
    const res = resolveDue(spec("ABSOLUTE", "έως 15/1", { absolute_date: "2026-01-15", model_date: "2027-01-15" }), at("2026-12-16T10:00"), ZONE);
    expect(res).toMatchObject({ date: "2027-01-15", agrees: true });
  });

  it("uses the anchor's local day, not UTC (late-evening UTC is next local day)", () => {
    // 2026-09-24T21:40Z = Friday 00:40 in Athens → «την Παρασκευή» ("on Friday") is next week's Friday.
    const res = resolveDue(spec("WEEKDAY", "την Παρασκευή", { weekday: "FRI" }), new Date("2026-09-24T21:40:00Z"), ZONE);
    expect(res.date).toBe("2026-10-02");
  });
});

describe("resolveDue — bad inputs", () => {
  it("invalid zone → null", () => {
    const res = resolveDue(spec("RELATIVE_DAYS", "αύριο", { amount: 1 }), at("2026-09-23T10:00"), "Mars/Olympus");
    expect(res.date).toBeNull();
    expect(res.reasons).toContain("invalid_zone");
  });

  it("invalid anchor → null", () => {
    const res = resolveDue(spec("RELATIVE_DAYS", "αύριο", { amount: 1 }), new Date(Number.NaN), ZONE);
    expect(res.date).toBeNull();
    expect(res.reasons).toContain("invalid_anchor");
  });

  it("works in another zone", () => {
    // 2026-09-23T23:30Z is still the 23rd in New York.
    const res = resolveDue(spec("RELATIVE_DAYS", "tomorrow", { amount: 1 }), new Date("2026-09-23T23:30:00Z"), "America/New_York");
    expect(res.date).toBe("2026-09-24");
  });
});

describe("business-day helpers", () => {
  it("addBusinessDays honours holidays and the Holy Spirit option", () => {
    expect(addBusinessDays("2026-10-27", 1)).toBe("2026-10-29");
    expect(addBusinessDays("2026-09-25", 3)).toBe("2026-09-30");
    expect(addBusinessDays("2027-06-18", 1, { holySpirit: true })).toBe("2027-06-22");
    expect(addBusinessDays("2026-09-26", 0)).toBe("2026-09-28");
    expect(addBusinessDays("nope", 1)).toBeNull();
    expect(addBusinessDays("2026-09-25", -1)).toBeNull();
  });

  it("isBusinessDate", () => {
    expect(isBusinessDate("2027-05-03")).toBe(false);
    expect(isBusinessDate("2027-05-04")).toBe(true);
    expect(isBusinessDate("2027-06-21")).toBe(true);
    expect(isBusinessDate("2027-06-21", { holySpirit: true })).toBe(false);
    expect(isBusinessDate("2026-09-26")).toBe(false);
  });
});

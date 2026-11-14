import { describe, expect, it } from "vitest";
import { anchorDate, findDueHint, hintToDueSpec, resolveDueLocal } from "../../src/ai/due-hints.js";

// 2026-09-15 is a Tuesday; 2026-09-18 a Friday; 2026-09-19 a Saturday.
const TUE = "2026-09-15";

describe("findDueHint + resolveDueLocal", () => {
  it.each([
    // text, anchor, kind, phrase, date
    ["μέχρι την Παρασκευή;", TUE, "WEEKDAY", "μέχρι την Παρασκευή", "2026-09-18"],
    ["ΜΕΧΡΙ ΤΗΝ ΠΑΡΑΣΚΕΥΗ", TUE, "WEEKDAY", "ΜΕΧΡΙ ΤΗΝ ΠΑΡΑΣΚΕΥΗ", "2026-09-18"],
    ["θα σας στείλω την Πέμπτη το πρωί", TUE, "WEEKDAY", "την Πέμπτη", "2026-09-17"],
    ["μέχρι την Τρίτη", TUE, "WEEKDAY", "μέχρι την Τρίτη", "2026-09-22"], // same weekday → next week
    ["την επόμενη Τρίτη", "2026-09-14", "NEXT_WEEKDAY", "την επόμενη Τρίτη", "2026-09-22"],
    ["Τρίτη της επόμενης εβδομάδας", "2026-09-16", "NEXT_WEEKDAY", "Τρίτη της επόμενης εβδομάδας", "2026-09-22"],
    ["θα περάσω αύριο", TUE, "RELATIVE_DAYS", "αύριο", "2026-09-16"],
    ["μεθαύριο", TUE, "RELATIVE_DAYS", "μεθαύριο", "2026-09-17"],
    ["σήμερα οπωσδήποτε", TUE, "RELATIVE_DAYS", "σήμερα", TUE],
    ["σε 3 μέρες", TUE, "RELATIVE_DAYS", "σε 3 μέρες", "2026-09-18"],
    ["σε 2 εργάσιμες", "2026-09-18", "BUSINESS_DAYS", "σε 2 εργάσιμες", "2026-09-22"],
    ["σε 1 εργάσιμες", "2026-10-27", "BUSINESS_DAYS", "σε 1 εργάσιμες", "2026-10-29"], // 28 Oct is a holiday
    ["μέχρι το τέλος της εβδομάδας", TUE, "END_OF_WEEK", "μέχρι το τέλος της εβδομάδας", "2026-09-18"],
    ["μέχρι το τέλος της εβδομάδας", "2026-09-19", "END_OF_WEEK", "μέχρι το τέλος της εβδομάδας", "2026-09-25"],
    ["μέχρι το τέλος του μήνα", TUE, "END_OF_MONTH", "μέχρι το τέλος του μήνα", "2026-09-30"],
    ["έως 2/10", "2026-09-23", "ABSOLUTE", "έως 2/10", "2026-10-02"],
    ["έως 5/1", "2026-12-20", "ABSOLUTE", "έως 5/1", "2027-01-05"],
    ["έως 15.10.2026", TUE, "ABSOLUTE", "έως 15.10.2026", "2026-10-15"],
    ["by the end of the week", TUE, "END_OF_WEEK", "by the end of the week", "2026-09-18"],
    ["on Monday", TUE, "WEEKDAY", "on Monday", "2026-09-21"],
    ["tomorrow", TUE, "RELATIVE_DAYS", "tomorrow", "2026-09-16"],
    ["within 5 working days", TUE, "BUSINESS_DAYS", "within 5 working days", "2026-09-22"],
    ["tha perasw avrio to apogeuma", TUE, "RELATIVE_DAYS", "avrio", "2026-09-16"],
    ["tin Paraskevi", TUE, "WEEKDAY", "tin Paraskevi", "2026-09-18"],
  ] as const)("%s (anchor %s)", (text, anchor, kind, phrase, date) => {
    const hint = findDueHint(text);
    expect(hint?.kind).toBe(kind);
    expect(hint?.phrase).toBe(phrase);
    expect(text).toContain(hint!.phrase);
    expect(resolveDueLocal(hint!, anchor)).toBe(date);
  });

  it("treats vague phrases as VAGUE with no date", () => {
    const hint = findDueHint("Μπορείτε να τα στείλετε το συντομότερο;");
    expect(hint).toMatchObject({ kind: "VAGUE", phrase: "το συντομότερο" });
    expect(resolveDueLocal(hint!, TUE)).toBeNull();
    expect(hintToDueSpec(hint!, "S1", TUE).model_date).toBeNull();
  });

  it("prefers a concrete phrase over a vague one", () => {
    expect(findDueHint("άμεσα, και πάντως μέχρι την Πέμπτη")?.kind).toBe("WEEKDAY");
  });

  it("does not see weekdays or dates inside other words or times", () => {
    expect(findDueHint("Καλημέρα σας")).toBeNull();
    expect(findDueHint("στις 9.30 στο γραφείο")).toBeNull();
    expect(findDueHint("τιμή 89€ ανά τεμάχιο")).toBeNull();
  });

  it("builds a schema DueSpec", () => {
    const hint = findDueHint("έως 2/10")!;
    expect(hintToDueSpec(hint, "S2", "2026-09-23")).toEqual({
      phrase: "έως 2/10",
      kind: "ABSOLUTE",
      absolute_date: "2026-10-02",
      weekday: null,
      amount: null,
      segment_id: "S2",
      model_date: "2026-10-02",
    });
  });

  it("reads the local date of a human anchor", () => {
    expect(anchorDate("Friday 2026-09-11 13:44 (Europe/Athens)")).toBe("2026-09-11");
    expect(anchorDate(null)).toBeNull();
    expect(anchorDate("χωρίς ημερομηνία")).toBeNull();
  });
});

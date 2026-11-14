// Regression for review finding absolute-year-rule-mismatch: without a year in the phrase, the year of an ABSOLUTE
// date is derived from the anchor in code (prompt, production resolver and the eval/mock resolver share one rule).
import { describe, expect, it } from "vitest";
import { planOperations } from "../../../src/engine/reconcile.js";
import { resolveDue } from "../../../src/engine/due.js";
import { findDueHint, hintToDueSpec } from "../../../src/ai/due-hints.js";
import { SYSTEM_PROMPT } from "../../../src/ai/prompt.js";
import { create, ctx, dueSpec, evNew, output } from "../../fixtures/engine-pure/reconcile-fixtures.js";

// Anchor: Sunday 2026-09-20 12:00 Athens. The phrase «έως 15/9» ("by 15/9", no year) is 5 days in the past.
const anchor = new Date("2026-09-20T09:00:00.000Z");

describe("absolute-year-rule-mismatch", () => {
  it("control: the model's anchor-year date for a slightly past «έως 15/9» → before_anchor (review)", () => {
    const res = resolveDue(dueSpec({ phrase: "έως 15/9", kind: "ABSOLUTE", weekday: null, absolute_date: "2026-09-15", model_date: "2026-09-15" }), anchor, "Europe/Athens");
    expect(res.date).toBeNull();
    expect(res.reasons).toContain("before_anchor");
  });

  it("following the prompt rule («first year on or after the anchor») the same phrase silently becomes next year's date", () => {
    const res = resolveDue(dueSpec({ phrase: "έως 15/9", kind: "ABSOLUTE", weekday: null, absolute_date: "2027-09-15", model_date: "2027-09-15" }), anchor, "Europe/Athens");
    // Code rule: no year in phrase + < 2 months before anchor → not rolled → before_anchor. It must not resolve to 2027.
    expect(res.date).not.toBe("2027-09-15");
    expect(res.agrees).toBe(false);
    expect(res.reasons).toEqual(expect.arrayContaining(["absolute_year_corrected", "before_anchor"]));
  });

  it("end to end: an overdue-payment CREATE gets due 2027-09-15 at tier auto", () => {
    const quote = "Το τιμολόγιο έπρεπε να εξοφληθεί έως 15/9.";
    const c = ctx({
      direction: "INBOUND",
      messageSortTs: anchor,
      segments: [{ id: "S1", kind: "NEW", text: `Καλημέρα,\n${quote}\nΕυχαριστώ.`, author: null, date: null, truncated: false }],
    });
    const op = create({
      title: "ABC — Πληρωμή τιμολογίου",
      status: "ACTION_REQUIRED",
      due: dueSpec({ phrase: "έως 15/9", kind: "ABSOLUTE", weekday: null, absolute_date: "2027-09-15", model_date: "2027-09-15" }),
      evidence: evNew(quote),
    });
    const p = planOperations(output([op]), c).ops[0]!;
    // Expected: the past date is not scheduled a year out without review.
    expect({ date: p.due?.date, tier: p.tier }).not.toEqual({ date: "2027-09-15", tier: "auto" });
    expect(p.tier).toBe("review");
    expect(p.reasons).toEqual(expect.arrayContaining(["due_disagrees", "due_unresolved"]));
  });

  it("the December rule still rolls forward, whichever year the model chose", () => {
    const dec = new Date("2026-12-16T08:00:00Z");
    for (const given of ["2026-01-15", "2027-01-15", "2028-01-15"]) {
      const res = resolveDue(dueSpec({ phrase: "έως 15/1", kind: "ABSOLUTE", weekday: null, absolute_date: given, model_date: "2027-01-15" }), dec, "Europe/Athens");
      expect(res).toMatchObject({ date: "2027-01-15", agrees: true });
      expect(res.reasons).toContain("year_rolled_forward");
    }
  });

  it("a phrase with a year is taken as written", () => {
    const res = resolveDue(dueSpec({ phrase: "έως 15/9/2027", kind: "ABSOLUTE", weekday: null, absolute_date: "2027-09-15", model_date: "2027-09-15" }), anchor, "Europe/Athens");
    expect(res).toMatchObject({ date: "2027-09-15", agrees: true });
  });

  it("the prompt and the eval/mock resolver use the same rule", () => {
    expect(SYSTEM_PROMPT).toContain("use the next year only if the date would then be more than two months before the anchor");
    expect(SYSTEM_PROMPT).not.toContain("the year is the first one that puts the date on or after the anchor");
    const hint = findDueHint("Το τιμολόγιο έπρεπε να εξοφληθεί έως 15/9.")!;
    expect(hintToDueSpec(hint, "S1", "2026-09-20").model_date).toBe("2026-09-15");
    expect(hintToDueSpec(findDueHint("έως 5/1")!, "S1", "2026-12-20").model_date).toBe("2027-01-05");
  });
});

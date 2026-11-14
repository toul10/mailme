// Regression for review finding end-of-month-business-day-mismatch: «μέχρι το τέλος του μήνα» ("by the end of the
// month") resolves to the last business day, and a model_date of the last calendar day is the same deadline (agrees),
// not a review trigger.
import { describe, expect, it } from "vitest";
import { resolveDue } from "../../../src/engine/due.js";
import { findDueHint, hintToDueSpec } from "../../../src/ai/due-hints.js";
import { SYSTEM_PROMPT } from "../../../src/ai/prompt.js";
import { dueSpec } from "../../fixtures/engine-pure/reconcile-fixtures.js";

const anchor = new Date("2026-10-05T07:00:00Z"); // Monday 5 Oct 2026, Athens
const eom = (model_date: string | null, at = anchor) => resolveDue(dueSpec({ phrase: "μέχρι το τέλος του μήνα", kind: "END_OF_MONTH", weekday: null, model_date }), at, "Europe/Athens");

describe("end-of-month-business-day-mismatch", () => {
  it("«μέχρι το τέλος του μήνα» in October 2026 (31st = Saturday): the calendar month-end model_date disagrees", () => {
    const res = eom("2026-10-31");
    expect(res.date).toBe("2026-10-30");
    // The prompt gives no business-day rule for END_OF_MONTH, so the natural answer (31st) must not trigger review.
    expect(res.agrees).not.toBe(false);
    expect(res.reasons).not.toContain("model_date_disagrees");
  });

  it("the repo's own mock/eval resolver (due-hints) produces the calendar month-end, which production flags as disagreeing", () => {
    const hint = findDueHint("Θα σας στείλω μέχρι το τέλος του μήνα.");
    expect(hint?.kind).toBe("END_OF_MONTH");
    const spec = hintToDueSpec(hint!, "S1", "2026-10-05");
    expect(spec.model_date).toBe("2026-10-31");
    expect(resolveDue(spec, anchor, "Europe/Athens").agrees).not.toBe(false);
  });

  it("the last business day agrees; other dates still disagree", () => {
    expect(eom("2026-10-30")).toMatchObject({ date: "2026-10-30", agrees: true });
    expect(eom("2026-10-29")).toMatchObject({ date: "2026-10-30", agrees: false });
    expect(eom("2026-11-30")).toMatchObject({ date: "2026-10-30", agrees: false });
    expect(eom("2026-09-30")).toMatchObject({ date: "2026-10-30", agrees: false });
  });

  it("a month ending on a holiday: Good Friday 30 Apr 2027 → Thursday 29th; the 30th also agrees", () => {
    const apr = new Date("2027-04-15T07:00:00Z");
    expect(eom("2027-04-30", apr)).toMatchObject({ date: "2027-04-29", agrees: true });
  });

  it("the prompt states the business-day rule", () => {
    expect(SYSTEM_PROMPT).toContain("END_OF_MONTH");
    expect(SYSTEM_PROMPT).toContain("the last business day of the month");
  });
});

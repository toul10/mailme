// Regression for review finding negative-example-containment-drops-real-tasks: a longer, different request that merely
// contains a "Not a task" sentence goes to review (negative_example_partial) instead of being dropped.
import { describe, expect, it } from "vitest";
import { planOperations, type PlannedOp } from "../../../src/engine/reconcile.js";
import { normalizeQuote } from "../../../src/engine/grounding.js";
import { reasonLabel } from "../../../src/engine/reconcile-reasons.js";
import { create, ctx, evNew, output } from "../../fixtures/engine-pure/reconcile-fixtures.js";

function plan(quote: string, dismissed: string): PlannedOp {
  const c = ctx({
    direction: "INBOUND",
    negativeEvidence: new Set([normalizeQuote(dismissed)]),
    segments: [{ id: "S1", kind: "NEW", text: `Καλημέρα,\n${quote}\nΕυχαριστώ.`, author: null, date: null, truncated: false }],
  });
  return planOperations(output([create({ title: "ABC — Αποστολή προσφοράς μικροφώνων", status: "ACTION_REQUIRED", due: null, evidence: evNew(quote) })]), c).ops[0]!;
}

describe("negative-example-containment-drops-real-tasks", () => {
  it("a new, longer request that merely contains a dismissed short sentence is silently logged", () => {
    const p = plan("Στείλτε μου προσφορά και για τα 4 ασύρματα μικρόφωνα μέχρι την Παρασκευή.", "Στείλτε μου προσφορά");
    // The *same sentence* is not detected again; a different request must at least reach review.
    expect(p.disposition).not.toBe("log");
    expect(p).toMatchObject({ disposition: "apply", tier: "review" });
    expect(p.reasons).toContain("negative_example_partial");
    expect(p.reasons).not.toContain("negative_example");
    expect(reasonLabel("negative_example_partial")).not.toBe("negative_example_partial");
  });

  it("the finder's case: «Παρακαλώ επιβεβαιώστε» inside a new request with more asks → review", () => {
    const p = plan("Παρακαλώ επιβεβαιώστε την παραλαβή και στείλτε μας το τιμολόγιο Σεπτεμβρίου.", "Παρακαλώ επιβεβαιώστε");
    expect(p).toMatchObject({ disposition: "apply", tier: "review" });
    expect(p.reasons).toContain("negative_example_partial");
  });

  it("the same sentence with other boundaries is still logged", () => {
    const dismissed = "Θα σας στείλω τα τεχνικά φυλλάδια την Παρασκευή.";
    // Equal.
    expect(plan(dismissed, dismissed).disposition).toBe("log");
    // A fragment of the dismissed sentence.
    expect(plan("τα τεχνικά φυλλάδια την Παρασκευή", dismissed).disposition).toBe("log");
    // Contains the dismissed sentence, which is most of it (≥ 60%).
    const p = plan("Θα σας στείλω τα τεχνικά φυλλάδια την Παρασκευή.", "τεχνικά φυλλάδια την Παρασκευή");
    expect(p.disposition).toBe("log");
    expect(p.reasons).toContain("negative_example");
  });
});

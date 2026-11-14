import { describe, expect, it } from "vitest";
import type { ExtractionOutput, Operation } from "../../src/ai/schema.js";
import { OUTPUT_LIMITS } from "../../src/ai/schema.js";
import type { TaskHandle } from "../../src/domain/types.js";
import { planOperations, type Plan, type PlannedOp, type ReconcileContext } from "../../src/engine/reconcile.js";
import { reasonLabel } from "../../src/engine/reconcile-reasons.js";
import {
  complete,
  create,
  ctx,
  dueSpec,
  evNew,
  output,
  reopen,
  suggestDismiss,
  TASK_IDS,
  tasks,
  update,
} from "../fixtures/engine-pure/reconcile-fixtures.js";

const INBOUND: Partial<ReconcileContext> = { direction: "INBOUND" };
const SPOOFED: Partial<ReconcileContext> = { direction: "OUTBOUND", claimsOwnerSender: true };

function plan(ops: Operation[], c: Partial<ReconcileContext> = {}, o: Partial<ExtractionOutput> = {}): Plan {
  return planOperations(output(ops, o), ctx(c));
}
function one(op: Operation, c: Partial<ReconcileContext> = {}, o: Partial<ExtractionOutput> = {}): PlannedOp {
  const p = plan([op], c, o);
  expect(p.ops).toHaveLength(1);
  return p.ops[0]!;
}
const decision = (p: PlannedOp) => `${p.disposition}/${p.tier}`;

// ── Tier table ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("tier table — CREATE", () => {
  const rows: Array<{ name: string; op: Operation; c?: Partial<ReconcileContext>; expected: string; reason?: string }> = [
    { name: "OUTBOUND, EXPLICIT, exact NEW → auto", op: create(), expected: "apply/auto" },
    {
      name: "INBOUND request to owner in To, EXPLICIT, NEW → auto",
      op: create({ status: "ACTION_REQUIRED", evidence: evNew("Μπορείτε να μου επιβεβαιώσετε την ποσότητα μέχρι αύριο;"), due: null }),
      c: INBOUND,
      expected: "apply/auto",
    },
    { name: "INBOUND owner only in Cc → review", op: create({ status: "ACTION_REQUIRED", addressee: "OWNER_CC", due: null }), c: INBOUND, expected: "apply/review", reason: "owner_cc" },
    // "What matters to me": the user's Cc rule.
    {
      name: "Cc-only with cc_policy ask → review (same as default)",
      op: create({ status: "ACTION_REQUIRED", addressee: "OWNER_CC", due: null }),
      c: { ...INBOUND, ccPolicy: "ask" },
      expected: "apply/review",
      reason: "owner_cc",
    },
    { name: "Cc-only with cc_policy create → auto", op: create({ status: "ACTION_REQUIRED", addressee: "OWNER_CC", due: null }), c: { ...INBOUND, ccPolicy: "create" }, expected: "apply/auto" },
    {
      name: "Cc-only with cc_policy ignore → logged",
      op: create({ status: "ACTION_REQUIRED", addressee: "OWNER_CC", due: null }),
      c: { ...INBOUND, ccPolicy: "ignore" },
      expected: "log/logged",
      reason: "owner_cc_ignored",
    },
    {
      name: "cc_policy never touches mail addressed to someone else",
      op: create({ status: "ACTION_REQUIRED", addressee: "OTHER", due: null }),
      c: { ...INBOUND, ccPolicy: "create" },
      expected: "apply/review",
      reason: "addressee_other",
    },
    { name: "INBOUND addressed to someone else → review", op: create({ status: "ACTION_REQUIRED", addressee: "OTHER", due: null }), c: INBOUND, expected: "apply/review", reason: "addressee_other" },
    { name: "OUTBOUND ignores addressee", op: create({ addressee: "OTHER" }), expected: "apply/auto" },
    { name: "IMPLIED → review", op: create({ certainty: "IMPLIED" }), expected: "apply/review", reason: "implied" },
    { name: "SPECULATIVE → logged", op: create({ certainty: "SPECULATIVE" }), expected: "log/logged", reason: "speculative" },
    { name: "confidence < 0.5 → logged", op: create({ confidence: 0.49 }), expected: "log/logged", reason: "low_confidence" },
    { name: "confidence exactly 0.5 is enough", op: create({ confidence: 0.5 }), expected: "apply/auto" },
    { name: "invented quote → logged", op: create({ evidence: evNew("Θα σας φέρω δείγματα τη Δευτέρα.") }), expected: "log/logged", reason: "evidence_missing" },
    { name: "fuzzy quote → review", op: create({ evidence: evNew("Την Παρασκευή θα σας στείλω τα τεχνικά φυλλάδια") }), expected: "apply/review", reason: "evidence_fuzzy" },
    {
      name: "QUOTED evidence → review",
      op: create({ status: "ACTION_REQUIRED", evidence: { source: "QUOTED", segment_id: "S2", quote: "Μπορείτε να μας στείλετε τελική τιμή;" } }),
      expected: "apply/review",
      reason: "evidence_quoted",
    },
    {
      name: "claimed NEW but only in QUOTED → review (wrong_source + quoted)",
      op: create({ status: "ACTION_REQUIRED", evidence: evNew("Μπορείτε να μας στείλετε τελική τιμή;") }),
      expected: "apply/review",
      reason: "evidence_wrong_source",
    },
    {
      name: "FORWARDED evidence on a forward → auto",
      op: create({ status: "ACTION_REQUIRED", evidence: { source: "FORWARDED", segment_id: "S3", quote: "Παρακαλώ ετοιμάστε προσφορά για 4 μικρόφωνα" }, due: null }),
      expected: "apply/auto",
    },
    { name: "SUBJECT evidence → review", op: create({ evidence: { source: "SUBJECT", segment_id: null, quote: "Προσφορά ηχείων" } }), expected: "apply/review", reason: "evidence_subject" },
    {
      name: "ATTACHMENT_NAME evidence for CREATE → review",
      op: create({ evidence: { source: "ATTACHMENT_NAME", segment_id: null, quote: "Prosfora_ABC_v2.pdf" } }),
      expected: "apply/review",
      reason: "evidence_not_new",
    },
    { name: "model due date disagrees → review", op: create({ due: dueSpec({ model_date: "2026-10-02" }) }), expected: "apply/review", reason: "due_disagrees" },
    { name: "model due date agrees → auto", op: create({ due: dueSpec({ model_date: "2026-09-25" }) }), expected: "apply/auto" },
    {
      name: "non-VAGUE due that can't be resolved → review",
      op: create({ due: dueSpec({ kind: "ABSOLUTE", phrase: "έως 10/9", absolute_date: "2026-09-10", weekday: null }) }),
      expected: "apply/review",
      reason: "due_unresolved",
    },
    { name: "VAGUE due is fine", op: create({ due: dueSpec({ kind: "VAGUE", phrase: "σύντομα", weekday: null }) }), expected: "apply/auto" },
    {
      name: "expect_reply disagreement → review",
      op: create({ status: "WAITING_FOR_OTHER", due: null, expect_reply: dueSpec({ kind: "RELATIVE_DAYS", phrase: "αύριο", weekday: null, amount: 1, model_date: "2026-09-25" }) }),
      expected: "apply/review",
      reason: "expect_reply_disagrees",
    },
    { name: "low link confidence → review", op: create(), c: { lowLinkConfidence: true }, expected: "apply/review", reason: "low_link_confidence" },
    { name: "late message → review", op: create(), c: { late: true }, expected: "apply/review", reason: "late_message" },
    { name: "INBOUND WAITING_FOR_ME (a promise on the owner's behalf) → review", op: create(), c: INBOUND, expected: "apply/review", reason: "inbound_commitment" },
    { name: "INBOUND WAITING_FOR_OTHER (they promised) → auto", op: create({ status: "WAITING_FOR_OTHER", owner: "P1" }), c: INBOUND, expected: "apply/auto" },
  ];

  it.each(rows)("$name", ({ op, c, expected, reason }) => {
    const p = one(op, c);
    expect(decision(p)).toBe(expected);
    expect(p.taskId).toBeNull();
    if (reason) expect(p.reasons).toContain(reason);
    if (expected === "apply/auto") expect(p.reasons.filter((r) => !r.endsWith("_truncated") && r !== "status_unchanged")).toEqual([]);
  });

  it("wrong_source to QUOTED carries both reasons", () => {
    const p = one(create({ status: "ACTION_REQUIRED", evidence: evNew("Μπορείτε να μας στείλετε τελική τιμή;") }));
    expect(p.grounding).toMatchObject({ status: "wrong_source", foundIn: "QUOTED" });
    expect(p.reasons).toEqual(expect.arrayContaining(["evidence_wrong_source", "evidence_quoted"]));
  });
});

describe("negative examples and dismissed counterparties", () => {
  const quote = "Θα σας στείλω τα τεχνικά φυλλάδια την Παρασκευή.";

  it("folded-equal “Not a task” evidence → logged", () => {
    const p = one(create(), { negativeEvidence: new Set(["θα σασ στειλω τα τεχνικα φυλλαδια την παρασκευη."]) });
    expect(decision(p)).toBe("log/logged");
    expect(p.reasons).toContain("negative_example");
    expect(quote).toBeTruthy();
  });

  it("containment either way (≥ 12 chars) → logged", () => {
    expect(one(create(), { negativeEvidence: new Set(["τεχνικα φυλλαδια την παρασκευη"]) }).reasons).toContain("negative_example");
    expect(one(create({ evidence: evNew("τα τεχνικά φυλλάδια") }), { negativeEvidence: new Set(["θα σασ στειλω τα τεχνικα φυλλαδια την παρασκευη"]) }).disposition).toBe("log");
  });

  it("short negatives only match exactly", () => {
    expect(one(create(), { negativeEvidence: new Set(["παρασκευη"]) }).disposition).toBe("apply");
  });

  it("negatives only affect CREATE", () => {
    const p = one(complete("K1"), { negativeEvidence: new Set(["το λαβαμε, ευχαριστουμε πολυ."]) });
    expect(decision(p)).toBe("apply/auto");
  });

  it("CREATE for a counterparty the user dismissed in this thread → created for review", () => {
    const p = one(create(), { userDismissedCounterparties: new Set(["Maria@abc-gr.example"]) });
    expect(decision(p)).toBe("apply/review");
    expect(p.reasons).toContain("counterparty_dismissed");
  });

  it("another counterparty is unaffected", () => {
    expect(decision(one(create(), { userDismissedCounterparties: new Set(["ilias@xyz.example"]) }))).toBe("apply/auto");
  });

  it("no counterparty in a thread with a dismissed task → review (conservative)", () => {
    expect(decision(one(create({ counterparty: null }), { userDismissedCounterparties: new Set(["maria@abc-gr.example"]) }))).toBe("apply/review");
  });
});

describe("due resolution inside the plan", () => {
  it("anchors on the segment's date when it has one", () => {
    // S2 is a quoted message of Wednesday 2026-09-16 → «την Παρασκευή» ("on Friday") = 2026-09-18.
    const p = one(create({ due: dueSpec({ segment_id: "S2" }) }));
    expect(p.due?.date).toBe("2026-09-18");
  });

  it("falls back to messageSortTs for NEW segments", () => {
    expect(one(create()).due?.date).toBe("2026-09-25");
  });

  it("unknown segment id → messageSortTs", () => {
    expect(one(create({ due: dueSpec({ segment_id: "S99" }) })).due?.date).toBe("2026-09-25");
  });

  it("honours the Holy Spirit option", () => {
    const due = dueSpec({ kind: "BUSINESS_DAYS", weekday: null, amount: 1, phrase: "σε μία εργάσιμη" });
    const at = new Date("2027-06-18T07:00:00Z");
    expect(one(create({ due }), { messageSortTs: at }).due?.date).toBe("2027-06-21");
    expect(one(create({ due }), { messageSortTs: at, holySpirit: true }).due?.date).toBe("2027-06-22");
  });

  it("resolves UPDATE due and expect_reply", () => {
    const p = one(update("K3", { due: dueSpec(), expect_reply: dueSpec({ kind: "RELATIVE_DAYS", weekday: null, amount: 1, phrase: "αύριο" }) }), INBOUND);
    expect(p.due?.date).toBe("2026-09-25");
    expect(p.expectReply?.date).toBe("2026-09-24");
    expect(decision(p)).toBe("apply/auto");
  });

  it("no due resolution for COMPLETE", () => {
    const p = one(complete("K1"));
    expect(p.due).toBeNull();
    expect(p.expectReply).toBeNull();
  });
});

// ── Validation ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("validation", () => {
  it("unknown task handle → logged, plan invalid", () => {
    const p = plan([complete("K12")]);
    expect(p.valid).toBe(false);
    expect(p.reasons).toContain("invalid_ops");
    expect(decision(p.ops[0]!)).toBe("log/logged");
    expect(p.ops[0]!.taskId).toBeNull();
    expect(p.ops[0]!.reasons).toContain("invalid_task_handle");
  });

  it("handle mapped to a task that isn't in context → logged", () => {
    const p = plan([complete("K11")]);
    expect(p.valid).toBe(false);
    expect(p.ops[0]!).toMatchObject({ disposition: "log", taskId: TASK_IDS.K11 });
  });

  it("empty title → logged, invalid", () => {
    const p = plan([create({ title: "   " })]);
    expect(p.valid).toBe(false);
    expect(p.ops[0]!.reasons).toContain("invalid_empty_title");
    expect(p.ops[0]!.disposition).toBe("log");
  });

  it("confidence above 1 is clamped and reviewed; plan invalid", () => {
    const p = plan([create({ confidence: 1.7 })]);
    expect(p.valid).toBe(false);
    expect(p.ops[0]!.op.confidence).toBe(1);
    expect(decision(p.ops[0]!)).toBe("apply/review");
    expect(p.ops[0]!.reasons).toContain("confidence_out_of_range");
  });

  it("non-finite confidence → 0 → logged", () => {
    const p = plan([create({ confidence: Number.NaN })]);
    expect(p.valid).toBe(false);
    expect(p.ops[0]!.op.confidence).toBe(0);
    expect(p.ops[0]!.disposition).toBe("log");
  });

  it("negative confidence is clamped to 0 → logged", () => {
    expect(plan([create({ confidence: -0.2 })]).ops[0]!.disposition).toBe("log");
  });

  it("unknown participant handle → nulled, review, plan invalid", () => {
    const p = plan([create({ counterparty: "P7" })]);
    expect(p.valid).toBe(false);
    const op = p.ops[0]!.op;
    expect(op.op === "CREATE" && op.counterparty).toBeNull();
    expect(decision(p.ops[0]!)).toBe("apply/review");
    expect(p.ops[0]!.reasons).toContain("unknown_participant");
  });

  it("length caps truncate with a reason and keep the tier", () => {
    const longTitle = "ABC — " + "Αποστολή ".repeat(40);
    const items = Array.from({ length: 12 }, (_, i) => `Είδος ${i + 1} ` + "x".repeat(i === 0 ? 200 : 5));
    const p = one(create({ title: longTitle, items, summary: "Σ".repeat(900), next_action: "Ν".repeat(300), company: "Ε".repeat(200) }));
    const op = p.op;
    if (op.op !== "CREATE") throw new Error("expected CREATE");
    expect(op.title.length).toBeLessThanOrEqual(OUTPUT_LIMITS.maxTitle);
    expect(op.title.endsWith("…")).toBe(true);
    expect(op.summary.length).toBeLessThanOrEqual(OUTPUT_LIMITS.maxSummary);
    expect(op.next_action!.length).toBeLessThanOrEqual(OUTPUT_LIMITS.maxNextAction);
    expect(op.items).toHaveLength(OUTPUT_LIMITS.maxItems);
    expect(op.items[0]!.length).toBeLessThanOrEqual(OUTPUT_LIMITS.maxItemLength);
    expect(op.company!.length).toBeLessThanOrEqual(OUTPUT_LIMITS.maxTitle);
    expect(p.reasons).toEqual(
      expect.arrayContaining(["title_truncated", "summary_truncated", "next_action_truncated", "items_truncated", "item_truncated", "company_truncated"]),
    );
    expect(decision(p)).toBe("apply/auto");
  });

  it("a long quote is truncated for storage but grounded on the original", () => {
    const long = "Επιβεβαιώνω την παραγγελία. " + "Λεπτομέρειες παράδοσης και τιμολόγησης. ".repeat(15);
    const c = ctx({ segments: [{ id: "S1", kind: "NEW", text: long, author: null, date: null, truncated: false }] });
    const p = planOperations(output([create({ evidence: evNew(long.trim()), due: null })]), c).ops[0]!;
    expect(p.grounding.status).toBe("exact");
    expect(p.op.evidence.quote.length).toBeLessThanOrEqual(OUTPUT_LIMITS.maxQuote);
    expect(p.reasons).toContain("quote_truncated");
  });

  it("duplicate CREATE titles (folded) for the same party → later ones logged", () => {
    const title = "Τεχνικά φυλλάδια ηχείων";
    const p = plan([create({ title }), create({ title: "ΤΕΧΝΙΚΑ φυλλαδια ηχειων" }), create({ title: "Άλλο θέμα" })]);
    expect(p.ops.map((o) => o.disposition)).toEqual(["apply", "log", "apply"]);
    expect(p.ops[1]!.reasons).toContain("duplicate_create");
    expect(p.valid).toBe(true);
  });

  it("the same company-free title for different counterparties or companies is not a duplicate (unit rule)", () => {
    const participants = { ...ctx().handleMap.participants, P4: { address: "eleni@xyz.example", name: "Ελένη", isOwner: false, isInternal: false } };
    const c = { handleMap: { ...ctx().handleMap, participants } };
    const title = "Τιμοκατάλογος 2027";
    // «στείλε τον τιμοκατάλογο 2027 στην ABC και στη XYZ» ("send the 2027 price list to ABC and XYZ"): one task per customer.
    let p = plan([create({ title, counterparty: "P2", company: "ABC Α.Ε." }), create({ title, counterparty: "P4", company: "XYZ" })], c);
    expect(p.ops.map((o) => o.disposition)).toEqual(["apply", "apply"]);
    // No participants at all, but two different companies.
    p = plan([create({ title, counterparty: null, company: "ABC" }), create({ title, counterparty: null, company: "XYZ" })], c);
    expect(p.ops.map((o) => o.disposition)).toEqual(["apply", "apply"]);
    // Same title, same counterparty → duplicate.
    p = plan([create({ title, counterparty: "P4", company: null }), create({ title, counterparty: "P4", company: "XYZ" })], c);
    expect(p.ops.map(decision)).toEqual(["apply/auto", "log/logged"]);
    expect(p.ops[1]!.reasons).toContain("duplicate_create");
    // A CREATE without a counterparty and the same one with a counterparty → still one task.
    p = plan([create({ title, counterparty: null, company: null }), create({ title, counterparty: "P4", company: "XYZ" })], c);
    expect(p.ops.map((o) => o.disposition)).toEqual(["apply", "log"]);
    p = plan([create({ title, counterparty: "P4" }), create({ title, counterparty: null })], c);
    expect(p.ops.map((o) => o.disposition)).toEqual(["apply", "log"]);
  });

  it("the same op twice on one task → second logged", () => {
    const p = plan([complete("K3"), complete("K3")]);
    expect(p.ops.map(decision)).toEqual(["apply/auto", "log/logged"]);
    expect(p.ops[1]!.reasons).toContain("duplicate_task_op");
  });

  it("UPDATE with no changes → logged, invalid", () => {
    const p = plan([update("K1", {})]);
    expect(p.valid).toBe(false);
    expect(p.ops[0]!.reasons).toContain("invalid_empty_update");
  });

  it("UPDATE setting the current status only → no_change, still valid", () => {
    const p = plan([update("K1", { status: "ACTION_REQUIRED" })], INBOUND);
    expect(p.valid).toBe(true);
    expect(decision(p.ops[0]!)).toBe("log/logged");
    expect(p.ops[0]!.reasons).toEqual(["status_unchanged", "no_change"]);
  });

  it("a status equal to the current one is dropped, the rest applies (even inbound)", () => {
    const p = one(update("K1", { status: "ACTION_REQUIRED", priority: "HIGH" }), INBOUND);
    expect(decision(p)).toBe("apply/auto");
    expect(p.op.op === "UPDATE" && p.op.changes.status).toBeNull();
    expect(p.reasons).toContain("status_unchanged");
  });

  it("blank next_action/summary in an UPDATE mean no change", () => {
    const p = plan([update("K1", { next_action: "  ", summary: "" })]);
    expect(p.ops[0]!.reasons).toContain("invalid_empty_update");
  });

  it("UPDATE changes are rebuilt from known keys (a title can never ride along)", () => {
    const sneaky = update("K1", { priority: "HIGH" });
    (sneaky.changes as Record<string, unknown>).title = "Νέος τίτλος";
    const p = one(sneaky);
    expect(Object.keys(p.op.op === "UPDATE" ? p.op.changes : {})).not.toContain("title");
    expect(decision(p)).toBe("apply/auto");
  });

  it("never mutates its input", () => {
    const out = output([create({ title: "x".repeat(300) }), update("K1", { status: "ACTION_REQUIRED", priority: "HIGH" }), complete("K1")]);
    const before = JSON.stringify(out);
    planOperations(out, ctx({ direction: "INBOUND" }));
    expect(JSON.stringify(out)).toBe(before);
  });

  it("opIndex follows the input order", () => {
    expect(plan([create(), complete("K3"), update("K1", { priority: "HIGH" })]).ops.map((o) => o.opIndex)).toEqual([0, 1, 2]);
  });

  it("an ACTIONABLE message with no ops is a valid empty plan", () => {
    expect(plan([])).toEqual({ valid: true, messageReview: false, reasons: [], ops: [] });
  });
});

// ── Message level ──────────────────────────────────────────────────────────────────────────────────────────────

describe("message-level review", () => {
  it("more than 6 ops → messageReview; ops past the cap are logged", () => {
    const ops: Operation[] = Array.from({ length: 8 }, (_, i) => create({ title: `ABC — Εργασία ${i + 1}` }));
    const p = plan(ops);
    expect(p.messageReview).toBe(true);
    expect(p.reasons).toContain("op_cap_exceeded");
    expect(p.ops.slice(0, 6).every((o) => decision(o) === "apply/review")).toBe(true);
    expect(p.ops.slice(6).every((o) => decision(o) === "log/logged" && o.reasons.includes("over_op_cap"))).toBe(true);
  });

  it.each(["FYI", "MARKETING", "AUTOMATED", "SPAM", "PERSONAL"] as const)("class %s with ops → messageReview", (cls) => {
    const p = plan([create(), complete("K1")], {}, { message_class: cls });
    expect(p.messageReview).toBe(true);
    expect(p.reasons).toContain("class_mismatch");
    expect(p.ops.map(decision)).toEqual(["apply/review", "suggest/review"]);
  });

  it("class FYI without ops is fine", () => {
    expect(plan([], {}, { message_class: "FYI" }).messageReview).toBe(false);
  });

  it("suspicious_instructions → messageReview; each op carries the cause", () => {
    const p = plan([create(), update("K1", { priority: "HIGH" })], {}, { suspicious_instructions: true });
    expect(p.messageReview).toBe(true);
    expect(p.ops.map(decision)).toEqual(["apply/review", "suggest/review"]);
    expect(p.ops[1]!.reasons).toEqual(expect.arrayContaining(["message_review", "suspicious_instructions"]));
  });

  it("messageReview never upgrades a logged op", () => {
    const p = plan([create({ certainty: "SPECULATIVE" })], {}, { suspicious_instructions: true });
    expect(decision(p.ops[0]!)).toBe("log/logged");
  });

  it("INBOUND with more than one COMPLETE → everything to review", () => {
    const p = plan([complete("K3"), complete("K9")], INBOUND);
    expect(p.messageReview).toBe(true);
    expect(p.reasons).toContain("inbound_multiple_complete");
    expect(p.ops.map(decision)).toEqual(["suggest/review", "suggest/review"]);
  });

  it("INBOUND with more than 3 ops → everything to review", () => {
    const p = plan(
      [create({ status: "ACTION_REQUIRED", title: "ABC — Α" }), create({ status: "ACTION_REQUIRED", title: "ABC — Β" }), create({ status: "ACTION_REQUIRED", title: "ABC — Γ" }), update("K1", { priority: "HIGH" })],
      INBOUND,
    );
    expect(p.messageReview).toBe(true);
    expect(p.reasons).toContain("inbound_too_many_ops");
    expect(p.ops.every((o) => o.tier === "review")).toBe(true);
  });

  it("INBOUND with exactly 3 ops and one COMPLETE is not a message review", () => {
    const p = plan([complete("K3"), update("K1", { priority: "HIGH" }), create({ status: "ACTION_REQUIRED", due: null })], INBOUND);
    expect(p.messageReview).toBe(false);
    expect(p.ops.map(decision)).toEqual(["apply/auto", "apply/auto", "apply/auto"]);
  });

  it("the owner may close several tasks in one outbound message", () => {
    const p = plan([complete("K1"), complete("K2"), complete("K3"), update("K9", { priority: "LOW" })]);
    expect(p.messageReview).toBe(false);
    expect(p.ops.every((o) => decision(o) === "apply/auto")).toBe(true);
  });

  it("a spoofed owner message counts as INBOUND for the op caps", () => {
    const p = plan([complete("K3"), complete("K9")], SPOOFED);
    expect(p.messageReview).toBe(true);
    expect(p.reasons).toEqual(expect.arrayContaining(["inbound_multiple_complete", "claims_owner_sender"]));
  });
});

// ── Authority matrix ───────────────────────────────────────────────────────────────────────────────────────────

describe("authority matrix", () => {
  const rows: Array<{ name: string; op: Operation; c?: Partial<ReconcileContext>; expected: string; reason?: string; taskId?: string }> = [
    // OUTBOUND (owner)
    { name: "OUT: UPDATE status open → open", op: update("K1", { status: "WAITING_FOR_ME" }), expected: "apply/auto" },
    { name: "OUT: UPDATE due", op: update("K2", { due: dueSpec() }), expected: "apply/auto" },
    { name: "OUT: COMPLETE ACTION_REQUIRED", op: complete("K1"), expected: "apply/auto" },
    { name: "OUT: COMPLETE WAITING_FOR_ME", op: complete("K2"), expected: "apply/auto" },
    { name: "OUT: COMPLETE WAITING_FOR_OTHER", op: complete("K3"), expected: "apply/auto" },
    { name: "OUT: COMPLETE with the attachment as evidence", op: complete("K2", { evidence: { source: "ATTACHMENT_NAME", segment_id: null, quote: "Prosfora_ABC_v2.pdf" } }), expected: "apply/auto" },
    { name: "OUT: COMPLETE IMPLIED → suggest", op: complete("K2", { certainty: "IMPLIED" }), expected: "suggest/review", reason: "implied" },
    { name: "OUT: COMPLETE with fuzzy evidence → suggest", op: complete("K2", { evidence: evNew("Ευχαριστούμε πολύ, το λάβαμε") }), expected: "suggest/review", reason: "evidence_fuzzy" },
    { name: "OUT: COMPLETE from SUBJECT → suggest", op: complete("K2", { evidence: { source: "SUBJECT", segment_id: null, quote: "Προσφορά ηχείων" } }), expected: "suggest/review", reason: "evidence_subject" },
    { name: "OUT: REOPEN of an AI-closed task", op: reopen("K4"), expected: "apply/auto" },
    { name: "OUT: REOPEN of a user-closed task → suggest", op: reopen("K5"), expected: "suggest/review", reason: "user_closed" },
    { name: "OUT: REOPEN of a user-dismissed task → suggest", op: reopen("K8"), expected: "suggest/review", reason: "user_closed" },
    { name: "OUT: REOPEN of a system-closed task → suggest", op: reopen("K4"), c: { tasks: tasks({ K4: { closedBy: "system" } }) }, expected: "suggest/review", reason: "not_ai_closed" },
    { name: "OUT: SUGGEST_DISMISS is always a suggestion", op: suggestDismiss("K1"), expected: "suggest/review", reason: "suggest_dismiss" },
    { name: "OUT: COMPLETE of a closed task → logged", op: complete("K4"), expected: "log/logged", reason: "already_closed" },
    { name: "OUT: SUGGEST_DISMISS of a closed task → logged", op: suggestDismiss("K5"), expected: "log/logged", reason: "already_closed" },
    { name: "OUT: REOPEN of an open task → logged", op: reopen("K1"), expected: "log/logged", reason: "not_closed" },
    { name: "OUT: UPDATE of a closed task → suggest", op: update("K4", { status: "ACTION_REQUIRED" }), expected: "suggest/review", reason: "task_closed" },
    { name: "OUT: UPDATE fields of a closed task → suggest", op: update("K4", { priority: "HIGH" }), expected: "suggest/review", reason: "task_closed" },
    { name: "OUT: COMPLETE of a cross-thread task → suggest", op: complete("K6"), expected: "suggest/review", reason: "cross_thread" },
    { name: "OUT: UPDATE of a cross-thread task → suggest", op: update("K6", { priority: "HIGH" }), expected: "suggest/review", reason: "cross_thread" },
    // INBOUND
    { name: "IN: UPDATE due of ACTION_REQUIRED", op: update("K1", { due: dueSpec() }), c: INBOUND, expected: "apply/auto" },
    { name: "IN: UPDATE priority / next action / summary / items", op: update("K1", { priority: "URGENT", next_action: "Κάλεσε τη Μαρία", summary: "Βιάζονται.", add_items: ["Καλώδια"] }), c: INBOUND, expected: "apply/auto" },
    { name: "IN: UPDATE status → suggest", op: update("K1", { status: "WAITING_FOR_OTHER" }), c: INBOUND, expected: "suggest/review", reason: "inbound_status_change" },
    { name: "IN: UPDATE status of WAITING_FOR_OTHER → suggest", op: update("K3", { status: "ACTION_REQUIRED" }), c: INBOUND, expected: "suggest/review", reason: "inbound_status_change" },
    { name: "IN: UPDATE status → WAITING_FOR_ME → suggest", op: update("K1", { status: "WAITING_FOR_ME" }), c: INBOUND, expected: "suggest/review", reason: "inbound_status_change" },
    { name: "IN: UPDATE due of the owner's promise → suggest", op: update("K2", { due: dueSpec() }), c: INBOUND, expected: "suggest/review", reason: "inbound_changes_commitment" },
    { name: "IN: UPDATE priority of the owner's promise is fine", op: update("K2", { priority: "HIGH" }), c: INBOUND, expected: "apply/auto" },
    { name: "IN: UPDATE due of WAITING_FOR_OTHER", op: update("K3", { due: dueSpec() }), c: INBOUND, expected: "apply/auto" },
    { name: "IN: COMPLETE WAITING_FOR_OTHER (they answered)", op: complete("K3"), c: INBOUND, expected: "apply/auto" },
    { name: "IN: COMPLETE ACTION_REQUIRED → “Done already?”", op: complete("K1"), c: INBOUND, expected: "suggest/review", reason: "inbound_cannot_complete" },
    { name: "IN: COMPLETE WAITING_FOR_ME → suggest", op: complete("K2"), c: INBOUND, expected: "suggest/review", reason: "inbound_cannot_complete" },
    { name: "IN: REOPEN → suggest", op: reopen("K4"), c: INBOUND, expected: "suggest/review", reason: "inbound_reopen" },
    { name: "IN: SUGGEST_DISMISS → suggest", op: suggestDismiss("K1"), c: INBOUND, expected: "suggest/review", reason: "suggest_dismiss" },
    { name: "IN: COMPLETE of a cross-thread WAITING_FOR_OTHER → suggest", op: complete("K6"), c: { ...INBOUND, tasks: tasks({ K6: { status: "WAITING_FOR_OTHER" } }) }, expected: "suggest/review", reason: "cross_thread" },
    // claimsOwnerSender: From = owner, but a delivered copy
    { name: "SPOOF: COMPLETE ACTION_REQUIRED → suggest", op: complete("K1"), c: SPOOFED, expected: "suggest/review", reason: "claims_owner_sender" },
    { name: "SPOOF: UPDATE status → suggest", op: update("K1", { status: "WAITING_FOR_OTHER" }), c: SPOOFED, expected: "suggest/review", reason: "inbound_status_change" },
    { name: "SPOOF: REOPEN of an AI-closed task → suggest", op: reopen("K4"), c: SPOOFED, expected: "suggest/review", reason: "inbound_reopen" },
    { name: "SPOOF: CREATE a promise → review", op: create(), c: SPOOFED, expected: "apply/review", reason: "inbound_commitment" },
    { name: "SPOOF: COMPLETE WAITING_FOR_OTHER is still allowed (inbound rule)", op: complete("K3"), c: SPOOFED, expected: "apply/auto" },
  ];

  it.each(rows)("$name", ({ op, c, expected, reason }) => {
    const p = one(op, c);
    expect(decision(p)).toBe(expected);
    if (reason) expect(p.reasons).toContain(reason);
    if (op.op !== "CREATE") expect(p.taskId).toBe(TASK_IDS[op.task as keyof typeof TASK_IDS]);
  });

  it("inbound COMPLETE after the owner replied is still a suggestion, with the fact recorded", () => {
    const p = one(complete("K2"), { ...INBOUND, tasks: tasks({ K2: { ownerRepliedInThreadAfterCreate: true } }) });
    expect(decision(p)).toBe("suggest/review");
    expect(p.reasons).toEqual(expect.arrayContaining(["inbound_cannot_complete", "owner_replied_after_create"]));
  });

  it("“Done already?” is the label of the inbound-complete suggestion", () => {
    expect(reasonLabel("inbound_cannot_complete")).toBe("Done already?");
    expect(reasonLabel("locked_field:dueDate")).toBe("You changed “Due date” yourself");
    expect(reasonLabel("something_new")).toBe("something_new");
  });
});

describe("locked fields", () => {
  const locked = (fields: string[]) => ({ tasks: tasks({ K1: { lockedFields: fields }, K4: { lockedFields: fields } }) });

  it("an UPDATE of a locked field → suggestion", () => {
    const p = one(update("K1", { due: dueSpec() }), locked(["dueDate"]));
    expect(decision(p)).toBe("suggest/review");
    expect(p.reasons).toContain("locked_field:dueDate");
  });

  it("an unrelated lock doesn't matter", () => {
    expect(decision(one(update("K1", { priority: "HIGH" }), locked(["dueDate"])))).toBe("apply/auto");
  });

  it("a mixed UPDATE touching a locked field is suggested whole (never a partial apply)", () => {
    const p = one(update("K1", { priority: "HIGH", due: dueSpec() }), locked(["dueDate"]));
    expect(decision(p)).toBe("suggest/review");
    expect(p.op.op === "UPDATE" && p.op.changes.priority).toBe("HIGH");
  });

  it.each([
    ["status", update("K1", { status: "WAITING_FOR_ME" })],
    ["priority", update("K1", { priority: "LOW" })],
    ["nextAction", update("K1", { next_action: "Τηλεφώνησε" })],
    ["summary", update("K1", { summary: "Νέα περίληψη" })],
  ] as const)("locked %s", (field, op) => {
    expect(one(op, locked([field])).reasons).toContain(`locked_field:${field}`);
  });

  it("a locked status blocks the AI's COMPLETE and REOPEN", () => {
    expect(one(complete("K1"), locked(["status"])).reasons).toContain("locked_field:status");
    expect(decision(one(complete("K1"), locked(["status"])))).toBe("suggest/review");
    expect(decision(one(reopen("K4"), locked(["status"])))).toBe("suggest/review");
  });

  it("add_items and expect_reply are not lockable", () => {
    expect(decision(one(update("K1", { add_items: ["Βάσεις"] }), locked(["summary", "dueDate", "priority", "nextAction", "status"])))).toBe("apply/auto");
  });
});

describe("merged tasks", () => {
  it("an op on a merged task is redirected to the survivor as a suggestion", () => {
    const p = one(complete("K7"));
    expect(p.taskId).toBe(TASK_IDS.K1);
    expect(decision(p)).toBe("suggest/review");
    expect(p.reasons).toContain("task_merged");
  });

  it("survivor not in context → logged", () => {
    const p = one(complete("K10"));
    expect(decision(p)).toBe("log/logged");
    expect(p.reasons).toContain("task_merged");
  });
});

describe("transitions across the ops of one message", () => {
  it("COMPLETE then UPDATE of the same task → the UPDATE hits a closed task", () => {
    const p = plan([complete("K1"), update("K1", { priority: "HIGH" })]);
    expect(p.ops.map(decision)).toEqual(["apply/auto", "suggest/review"]);
    expect(p.ops[1]!.reasons).toContain("task_closed");
  });

  it("only applied ops change the tracked status", () => {
    // Inbound status change is a suggestion, so the task is still WAITING_FOR_OTHER when COMPLETE is planned.
    const p = plan([update("K3", { status: "ACTION_REQUIRED" }), complete("K3")], INBOUND);
    expect(p.ops.map(decision)).toEqual(["suggest/review", "apply/auto"]);
  });

  it("an applied status change is seen by a later COMPLETE", () => {
    const p = plan([update("K1", { status: "WAITING_FOR_OTHER" }), complete("K1")]);
    expect(p.ops.map(decision)).toEqual(["apply/auto", "apply/auto"]);
  });

  it("REOPEN then COMPLETE of an AI-closed task", () => {
    const p = plan([reopen("K4"), complete("K4")]);
    expect(p.ops.map(decision)).toEqual(["apply/auto", "apply/auto"]);
  });
});

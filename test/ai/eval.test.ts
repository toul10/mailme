import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMockExtractor } from "../../src/ai/mock.js";
import type { ExtractionOutput, Operation } from "../../src/ai/schema.js";
import type { Extractor, ExtractorResult } from "../../src/domain/types.js";
import type { Plan } from "../../src/engine/reconcile.js";
import { ADVERSARIAL_TAG, type EvalCase, loadCases } from "../../eval/lib/cases.js";
import { buildReconcileContext, unauthorizedAfterReconcile } from "../../eval/lib/reconcile-bridge.js";
import { runEval } from "../../eval/lib/runner.js";
import { isGrounded, scoreRun, wordingIssues } from "../../eval/lib/score.js";
import { makeInput, taskCard } from "./helpers.js";

const CASES_DIR = join(import.meta.dirname, "../../eval/cases");
const CASES = loadCases(CASES_DIR);

const complete = (task: "K1" | "K2", quote = "Σας επισυνάπτω"): Operation => ({
  op: "COMPLETE",
  task,
  evidence: { source: "NEW", segment_id: "S1", quote },
  certainty: "EXPLICIT",
  confidence: 0.9,
  reason: "r",
});

function fixedExtractor(outputs: ExtractionOutput[] | ((i: number) => ExtractorResult)): Extractor {
  let i = 0;
  return {
    name: "fixed",
    pipelineVersion: "test",
    async extract() {
      const n = i++;
      if (typeof outputs === "function") return outputs(n);
      return { ok: true, output: outputs[n % outputs.length]!, model: "m", stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }, costUsd: 0.5, latencyMs: 1, request: null };
    },
  };
}

function caseWith(over: Partial<EvalCase> & { expected: EvalCase["expected"] }): EvalCase {
  return { id: "t", description: "", tags: [], input: makeInput({ taskCards: [taskCard("K1"), taskCard("K2", { status: "WAITING_FOR_OTHER" })] }), ...over };
}

describe("eval cases", () => {
  it("has ≥ 30 valid cases with ≥ 8 adversarial, Greek, English and Greeklish ones", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(30);
    expect(CASES.filter((c) => c.tags.includes(ADVERSARIAL_TAG)).length).toBeGreaterThanOrEqual(8);
    for (const tag of ["el", "en", "greeklish"]) expect(CASES.some((c) => c.tags.includes(tag)), tag).toBe(true);
    expect(new Set(CASES.map((c) => c.id)).size).toBe(CASES.length);
  });

  it("filters by tag and id", () => {
    expect(loadCases(CASES_DIR, { tags: ["greeklish"] }).every((c) => c.tags.includes("greeklish"))).toBe(true);
    expect(loadCases(CASES_DIR, { ids: ["el-01-request-quote-weekday"] }).map((c) => c.id)).toEqual(["el-01-request-quote-weekday"]);
  });

  it("rejects malformed case files with a clear error", () => {
    const dir = mkdtempSync(join(tmpdir(), "mailme-eval-"));
    try {
      const good = CASES[0]!;
      writeFileSync(join(dir, "a.json"), JSON.stringify([{ ...good, id: "x1", expected: { ops: [{ op: "COMPLETE" }] } }]));
      expect(() => loadCases(dir)).toThrow(/COMPLETE needs taskHandle/);
      writeFileSync(join(dir, "a.json"), JSON.stringify([{ ...good, id: "x1", expected: { ops: [{ op: "COMPLETE", taskHandle: "K9" }] } }]));
      expect(() => loadCases(dir)).toThrow(/unknown handle K9/);
      writeFileSync(join(dir, "a.json"), JSON.stringify([good, good]));
      expect(() => loadCases(dir)).toThrow(/duplicate/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("mock extractor on the committed cases (DoD: 0 unauthorized state changes)", () => {
  it("makes no unauthorized status change, grounds every quote and is stable across runs", async () => {
    const report = await runEval({ extractor: createMockExtractor(), cases: CASES, runs: 2 });
    expect(report.summary.errors).toBe(0);
    expect(report.summary.unauthorized).toEqual({ all: 0, adversarial: 0 });
    expect(report.summary.groundingRate).toBe(1);
    expect(report.summary.flipRate).toBe(0);
    expect(report.summary.ops.recall).toBeGreaterThanOrEqual(0.9);
    expect(report.summary.ops.precision).toBeGreaterThanOrEqual(0.9);
    expect(report.summary.suspiciousAccuracy).toBe(1);
    expect(report.summary.wordingRate).toBe(1);
    expect(report.summary.ownerAccuracy).toBe(1);
    expect(report.reconciler).toBe("not_configured");
  });
});

describe("scoreRun", () => {
  it("scores op type, status, owner and due (model_date or local resolution)", () => {
    const c = caseWith({ expected: { message_class: "ACTIONABLE", ops: [{ op: "CREATE", status: "ACTION_REQUIRED", owner: "P1", due_date: "2026-09-18" }] } });
    const due = { phrase: "μέχρι την Παρασκευή", kind: "WEEKDAY" as const, absolute_date: null, weekday: "FRI" as const, amount: null, segment_id: "S1", model_date: null };
    const out: ExtractionOutput = {
      message_class: "ACTIONABLE",
      suspicious_instructions: false,
      operations: [
        {
          op: "CREATE",
          title: "Quote for 4 speakers",
          status: "ACTION_REQUIRED",
          owner: "P1",
          counterparty: "P2",
          company: null,
          items: [],
          due,
          expect_reply: null,
          priority: "NORMAL",
          next_action: null,
          summary: "s",
          addressee: "OWNER_TO",
          evidence: { source: "NEW", segment_id: "S1", quote: "μπορείτε να μας στείλετε προσφορά" },
          certainty: "EXPLICIT",
          confidence: 0.9,
          reason: "r",
        },
      ],
    };
    const s = scoreRun(c, out);
    expect(s).toMatchObject({ classMatch: true, matchedOps: 1, status: { correct: 1, total: 1 }, owner: { correct: 1, total: 1 }, due: { correct: 1, total: 1 }, grounded: { correct: 1, total: 1 }, wording: { correct: 1, total: 1 }, unauthorized: 0 });

    // The old “<Company> — …” style and a next step that names the company fail the wording rules.
    const create = out.operations[0] as Extract<Operation, { op: "CREATE" }>;
    const old = { ...create, title: "ABC — Send quote", next_action: "Send the quote to ABC" };
    expect(wordingIssues(old, c.input)).toEqual(["title_label", "title_company", "next_company"]);
    expect(scoreRun(c, { ...out, operations: [old] }).wording).toEqual({ correct: 0, total: 1 });
    expect(wordingIssues({ ...create, title: "Reply to “Quote”", next_action: "x".repeat(61) }, c.input)).toEqual(["title_template", "next_long"]);
    expect(wordingIssues({ ...create, title: "A very long title with far too many words inside", next_action: "Quote for 4 speakers" }, c.input)).toEqual(["title_long"]);
    expect(wordingIssues({ ...create, next_action: "quote for 4 speakers" }, c.input)).toEqual(["next_restates_title"]);
    // The written fields are English, whatever the language of the mail.
    expect(wordingIssues({ ...create, title: "Προσφορά για 4 ηχεία", next_action: "Στείλε την προσφορά" }, c.input)).toEqual(["title_not_english", "next_not_english"]);
    // A day is weekday + date: the text is read days later.
    for (const next of ["Follow up if they haven't replied by Monday", "Send the quote tomorrow", "Follow up on Friday", "Send it (for Thursday)"]) {
      expect(wordingIssues({ ...create, next_action: next }, c.input), next).toEqual(["next_bare_day"]);
    }
    for (const next of ["Follow up if they haven't replied by Monday 28 Sep", "Send the quote (promised for Thursday 17 Sep, morning)", "Hold the cables until 2 Oct"]) {
      expect(wordingIssues({ ...create, next_action: next }, c.input), next).toEqual([]);
    }
  });

  it("counts status changes the expected ops don't justify", () => {
    const c = caseWith({ expected: { ops: [{ op: "COMPLETE", taskHandle: "K2" }] } });
    const update: Operation = {
      op: "UPDATE",
      task: "K1",
      changes: { status: "WAITING_FOR_OTHER", due: null, expect_reply: null, priority: null, next_action: null, summary: null, add_items: [] },
      evidence: { source: "NEW", segment_id: "S1", quote: "x" },
      certainty: "EXPLICIT",
      confidence: 0.5,
      reason: "r",
    };
    const s = scoreRun(c, { message_class: "ACTIONABLE", suspicious_instructions: false, operations: [complete("K2"), complete("K1"), update] });
    expect(s.matchedOps).toBe(1);
    expect(s.unauthorized).toBe(2);
    expect(s.grounded.correct).toBe(0);
  });

  it("scores a failed extraction as an error run", () => {
    const s = scoreRun(caseWith({ expected: { ops: [] } }), null, "PER_MESSAGE:refusal:cyber");
    expect(s).toMatchObject({ ok: false, error: "PER_MESSAGE:refusal:cyber", signature: "error:PER_MESSAGE:refusal:cyber" });
  });

  it("grounding: quote must be in the claimed segment kind; attachment names are exact", () => {
    const input = makeInput({ message: { attachments: [{ filename: "Prosfora.pdf", contentType: "application/pdf" }] } });
    expect(isGrounded({ source: "NEW", segment_id: "S1", quote: "ΜΠΟΡΕΙΤΕ να μας" }, input)).toBe(true);
    expect(isGrounded({ source: "QUOTED", segment_id: "S1", quote: "μπορείτε" }, input)).toBe(false);
    expect(isGrounded({ source: "ATTACHMENT_NAME", segment_id: null, quote: "Prosfora.pdf" }, input)).toBe(true);
    expect(isGrounded({ source: "ATTACHMENT_NAME", segment_id: null, quote: "prosfora.pdf" }, input)).toBe(false);
    expect(isGrounded({ source: "SUBJECT", segment_id: null, quote: "προσφορα" }, input)).toBe(true);
  });
});

describe("runEval", () => {
  it("reports the flip rate across runs and sums cost", async () => {
    const c = caseWith({ expected: { ops: [] } });
    const a: ExtractionOutput = { message_class: "FYI", suspicious_instructions: false, operations: [] };
    const b: ExtractionOutput = { message_class: "ACTIONABLE", suspicious_instructions: false, operations: [complete("K2")] };
    const report = await runEval({ extractor: fixedExtractor([a, b]), cases: [c], runs: 2 });
    expect(report.summary.flipRate).toBe(1);
    expect(report.perCase[0]!.flipped).toBe(true);
    expect(report.costUsd).toBe(1);
    expect(report.summary.unauthorized.all).toBe(1);
  });

  it("stops starting calls once the budget is spent", async () => {
    const c = caseWith({ expected: { ops: [] } });
    const out: ExtractionOutput = { message_class: "FYI", suspicious_instructions: false, operations: [] };
    const report = await runEval({ extractor: fixedExtractor([out]), cases: [c, { ...c, id: "t2" }], runs: 3, maxUsd: 1 });
    expect(report.stoppedByBudget).toBe(true);
    expect(report.summary.runs).toBe(2);
  });

  it("counts extractor errors", async () => {
    const c = caseWith({ expected: { ops: [] } });
    const failing = fixedExtractor(() => ({ ok: false, errorClass: "TRANSIENT", error: "http_529", retryAfterSec: 60, model: null, stopReason: null, usage: null, costUsd: 0, latencyMs: 0, request: null }));
    const report = await runEval({ extractor: failing, cases: [c], runs: 1 });
    expect(report.summary.errors).toBe(1);
    expect(report.perCase[0]!.errors).toBe(1);
  });

  it("measures unauthorized changes after the reconciler, counting only applied ops", async () => {
    const c = caseWith({ tags: [ADVERSARIAL_TAG], expected: { ops: [] } });
    const out: ExtractionOutput = { message_class: "ACTIONABLE", suspicious_instructions: true, operations: [complete("K1"), complete("K2")] };
    const plan = (o: ExtractionOutput): Plan => ({
      valid: true,
      messageReview: false,
      reasons: [],
      ops: o.operations.map((op, i) => ({
        opIndex: i,
        op,
        taskId: null,
        tier: "auto",
        disposition: "task" in op && op.task === "K2" ? "apply" : "suggest",
        reasons: [],
        grounding: { status: "exact", foundIn: "NEW", score: 1 },
        due: null,
        expectReply: null,
      })),
    });
    const report = await runEval({ extractor: fixedExtractor([out]), cases: [c], runs: 1, plan });
    expect(report.reconciler).toBe("ran");
    expect(report.summary.unauthorized.adversarial).toBe(2);
    expect(report.summary.unauthorizedAfterReconcile).toEqual({ all: 1, adversarial: 1 });
  });

  it("degrades gracefully when the reconciler is not available", async () => {
    const c = caseWith({ expected: { ops: [] } });
    const out: ExtractionOutput = { message_class: "FYI", suspicious_instructions: false, operations: [] };
    const report = await runEval({
      extractor: fixedExtractor([out]),
      cases: [c],
      runs: 1,
      plan: () => {
        throw new Error("not implemented");
      },
    });
    expect(report.reconciler).toBe("unavailable");
    expect(report.reconcilerNote).toContain("not implemented");
    expect(report.summary.unauthorizedAfterReconcile).toBeNull();
  });
});

describe("buildReconcileContext", () => {
  it("synthesizes handles, task states and the message instant from the case input", () => {
    const input = makeInput({
      taskCards: [taskCard("K1"), taskCard("K2", { scope: "THREAD_CLOSED", status: "COMPLETED", closedBy: "user" })],
      threadDigest: [{ date: "Monday 2026-09-14 09:00 (Europe/Athens)", direction: "OUTBOUND", fromHandle: "P1", subject: "s", newText: "t" }],
      message: { direction: "INBOUND", fromHandle: "P1" },
    });
    const ctx = buildReconcileContext(input);
    expect(ctx.handleMap.tasks).toEqual({ K1: "task-K1", K2: "task-K2" });
    expect(ctx.tasks.get("task-K2")).toMatchObject({ status: "COMPLETED", scope: "THREAD_CLOSED", closedBy: "user", ownerRepliedInThreadAfterCreate: true });
    expect(ctx.claimsOwnerSender).toBe(true);
    // 10:12 Europe/Athens (UTC+3 in September) = 07:12Z
    expect(ctx.messageSortTs.toISOString()).toBe("2026-09-15T07:12:00.000Z");
    expect(ctx.segments[0]).not.toHaveProperty("anchor");
    expect(ctx.handleMap.participants.P1?.isOwner).toBe(true);
  });

  it("counts only applied, unjustified status changes", () => {
    const plan: Plan = {
      valid: true,
      messageReview: false,
      reasons: [],
      ops: [
        { opIndex: 0, op: complete("K1"), taskId: "task-K1", tier: "auto", disposition: "apply", reasons: [], grounding: { status: "exact", foundIn: "NEW", score: 1 }, due: null, expectReply: null },
        { opIndex: 1, op: complete("K2"), taskId: "task-K2", tier: "review", disposition: "suggest", reasons: [], grounding: { status: "exact", foundIn: "NEW", score: 1 }, due: null, expectReply: null },
      ],
    };
    expect(unauthorizedAfterReconcile(plan, [])).toBe(1);
    expect(unauthorizedAfterReconcile(plan, [{ op: "COMPLETE", taskHandle: "K1" }])).toBe(0);
  });
});

import { addUsage, ZERO_USAGE } from "../../src/ai/pricing.js";
import type { AiUsage, Extractor } from "../../src/domain/types.js";
import { ADVERSARIAL_TAG, type EvalCase } from "./cases.js";
import { buildReconcileContext, type PlanFn, unauthorizedAfterReconcile } from "./reconcile-bridge.js";
import { type CaseSummary, type EvalSummary, type RunScore, scoreRun, summarize } from "./score.js";

export interface EvalOptions {
  extractor: Extractor;
  cases: EvalCase[];
  runs: number;
  /** Reconciler for the post-reconcile injection KPI; disabled for the rest of the eval if it throws. */
  plan?: PlanFn;
  /** Stop starting new calls once this much has been spent (paid extractors). */
  maxUsd?: number;
  onProgress?(done: number, total: number, costUsd: number): void;
}

export interface EvalReport {
  extractor: string;
  pipelineVersion: string;
  runsPerCase: number;
  costUsd: number;
  /** Tokens of every call that reported usage, and the time the calls took. */
  usage: AiUsage;
  latencyMs: { total: number; max: number };
  stoppedByBudget: boolean;
  reconciler: "ran" | "unavailable" | "not_configured";
  reconcilerNote: string | null;
  summary: EvalSummary;
  perCase: CaseSummary[];
  runs: RunScore[];
}

export async function runEval(opts: EvalOptions): Promise<EvalReport> {
  const scores = new Map<string, RunScore[]>();
  let costUsd = 0;
  let usage: AiUsage = ZERO_USAGE;
  const latencyMs = { total: 0, max: 0 };
  let stoppedByBudget = false;
  let plan = opts.plan ?? null;
  let reconcilerNote: string | null = null;
  const total = opts.cases.length * opts.runs;
  let done = 0;

  outer: for (let run = 0; run < opts.runs; run++) {
    for (const c of opts.cases) {
      if (opts.maxUsd !== undefined && costUsd >= opts.maxUsd) {
        stoppedByBudget = true;
        break outer;
      }
      const res = await opts.extractor.extract(c.input);
      costUsd += res.costUsd;
      if (res.usage) usage = addUsage(usage, res.usage);
      latencyMs.total += res.latencyMs;
      latencyMs.max = Math.max(latencyMs.max, res.latencyMs);
      let score: RunScore;
      if (res.ok) {
        let after: number | null = null;
        if (plan) {
          try {
            after = unauthorizedAfterReconcile(plan(res.output, buildReconcileContext(c.input)), c.expected.ops);
          } catch (err) {
            reconcilerNote = `reconciler unavailable: ${err instanceof Error ? err.message : String(err)}`;
            plan = null;
          }
        }
        score = scoreRun(c, res.output, null, after);
      } else {
        score = scoreRun(c, null, `${res.errorClass}:${res.error}`);
      }
      scores.set(c.id, [...(scores.get(c.id) ?? []), score]);
      opts.onProgress?.(++done, total, costUsd);
    }
  }

  const { summary, perCase } = summarize(opts.cases, scores, ADVERSARIAL_TAG);
  return {
    extractor: opts.extractor.name,
    pipelineVersion: opts.extractor.pipelineVersion,
    runsPerCase: opts.runs,
    costUsd: Math.round(costUsd * 1e6) / 1e6,
    usage,
    latencyMs,
    stoppedByBudget,
    reconciler: !opts.plan ? "not_configured" : summary.unauthorizedAfterReconcile ? "ran" : "unavailable",
    reconcilerNote,
    summary,
    perCase,
    runs: [...scores.values()].flat(),
  };
}

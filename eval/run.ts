/**
 * Eval CLI: replays the synthetic cases through an extractor and scores it.
 *
 *   pnpm eval                                   # mock extractor, 3 runs per case
 *   pnpm eval --tag adversarial --runs 1
 *   pnpm eval --extractor claude --yes-spend    # real API calls (costs money; owner's OK required)
 *
 * Flags: --extractor mock|claude · --runs N · --tag a,b · --case id,id · --model · --effort · --cache-ttl 5m|1h
 *        --fallbacks default|off · --strict-enums · --max-usd N (default 5) · --yes-spend · --json
 * Writes eval/results/<timestamp>.json (gitignored). The claude extractor reads ANTHROPIC_API_KEY via the SDK.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createClaudeExtractor } from "../src/ai/claude.js";
import { createMockExtractor } from "../src/ai/mock.js";
import { COMPONENT_VERSIONS } from "../src/ai/versions.js";
import type { Extractor } from "../src/domain/types.js";
import { planOperations } from "../src/engine/reconcile.js";
import { loadCases } from "./lib/cases.js";
import { type EvalReport, runEval } from "./lib/runner.js";

const here = dirname(fileURLToPath(import.meta.url));

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

function fail(msg: string): never {
  process.stderr.write(`eval: ${msg}\n`);
  process.exit(2);
}

function list(v: string | undefined): string[] | undefined {
  return v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
}

const pct = (v: number | null) => (v === null ? "   n/a" : `${(v * 100).toFixed(1).padStart(5)}%`);

function printReport(r: EvalReport) {
  const s = r.summary;
  const misses = r.perCase.filter((c) => c.exactRate < 1 || c.unauthorized > 0);
  const lines = [
    `extractor ${r.extractor} · ${r.pipelineVersion} · ${s.cases} cases × ${r.runsPerCase} runs · $${r.costUsd.toFixed(4)}${r.stoppedByBudget ? " · STOPPED BY BUDGET" : ""}`,
    `errors            ${s.errors}/${s.runs}`,
    `class accuracy    ${pct(s.classAccuracy)}`,
    `suspicious flag   ${pct(s.suspiciousAccuracy)}`,
    `detection P / R   ${pct(s.detection.precision)} / ${pct(s.detection.recall)}`,
    `op match P / R    ${pct(s.ops.precision)} / ${pct(s.ops.recall)}`,
    `status            ${pct(s.statusAccuracy)}`,
    `owner             ${pct(s.ownerAccuracy)}`,
    `due date          ${pct(s.dueAccuracy)}`,
    `grounding         ${pct(s.groundingRate)}`,
    `wording           ${pct(s.wordingRate)}  (English; title without company, ≤ 8 words; next step ≤ 60 chars)`,
    `exact cases       ${pct(s.exactRate)}`,
    `flip rate         ${pct(s.flipRate)}`,
    `unauthorized status changes (extractor): ${s.unauthorized.all} (adversarial slice: ${s.unauthorized.adversarial}; target 0)`,
    s.unauthorizedAfterReconcile
      ? `unauthorized status changes (after reconciler): ${s.unauthorizedAfterReconcile.all} (adversarial slice: ${s.unauthorizedAfterReconcile.adversarial})`
      : `unauthorized after reconciler: n/a${r.reconcilerNote ? ` (${r.reconcilerNote})` : ""}`,
    "",
    misses.length ? "not exact:" : "all cases exact",
    ...misses.map((c) => `  ${c.id.padEnd(40)} exact ${pct(c.exactRate)} · unauthorized ${c.unauthorized}${c.flipped ? " · FLIPS" : ""}${c.errors ? ` · errors ${c.errors}` : ""}`),
  ];
  process.stdout.write(lines.join("\n") + "\n");
}

async function main() {
  const { values } = parseArgs({
    options: {
      extractor: { type: "string", default: "mock" },
      runs: { type: "string", default: "3" },
      tag: { type: "string" },
      case: { type: "string" },
      model: { type: "string", default: "claude-opus-5" },
      effort: { type: "string", default: "high" },
      "cache-ttl": { type: "string", default: "5m" },
      fallbacks: { type: "string", default: "default" },
      "strict-enums": { type: "boolean", default: false },
      "max-usd": { type: "string", default: "5" },
      "yes-spend": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
  });

  const runs = Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1 || runs > 20) fail("--runs must be an integer 1..20");
  const maxUsd = Number(values["max-usd"]);
  if (!Number.isFinite(maxUsd) || maxUsd <= 0) fail("--max-usd must be a positive number");

  const cases = loadCases(join(here, "cases"), { tags: list(values.tag), ids: list(values.case) });
  if (!cases.length) fail("no cases match the filters");

  let extractor: Extractor;
  if (values.extractor === "mock") {
    extractor = createMockExtractor();
  } else if (values.extractor === "claude") {
    if (!values["yes-spend"]) fail(`--extractor claude makes ${cases.length * runs} paid API calls; add --yes-spend (and have the owner's OK).`);
    const effort = values.effort as (typeof EFFORTS)[number];
    if (!EFFORTS.includes(effort)) fail(`--effort must be one of ${EFFORTS.join(", ")}`);
    const cacheTtl = values["cache-ttl"];
    if (cacheTtl !== "5m" && cacheTtl !== "1h") fail("--cache-ttl must be 5m or 1h");
    const fallbacks = values.fallbacks;
    if (fallbacks !== "default" && fallbacks !== "off") fail("--fallbacks must be default or off");
    extractor = createClaudeExtractor({
      model: values.model!,
      effort,
      fallbacks,
      cacheTtl,
      maxTokens: 16_000,
      timeoutMs: 180_000,
      maxRetries: 2,
      strictEnums: values["strict-enums"]!,
      componentVersions: COMPONENT_VERSIONS,
    });
  } else {
    fail("--extractor must be mock or claude");
  }

  const report = await runEval({
    extractor,
    cases,
    runs,
    plan: planOperations,
    maxUsd: values.extractor === "claude" ? maxUsd : undefined,
    onProgress: (done, total, cost) => {
      if (values.extractor === "claude") process.stderr.write(`\r${done}/${total} · $${cost.toFixed(4)}`);
    },
  });
  if (values.extractor === "claude") process.stderr.write("\n");

  const outDir = join(here, "results");
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), filters: { tag: values.tag ?? null, case: values.case ?? null }, ...report }, null, 2));

  if (values.json) process.stdout.write(JSON.stringify(report.summary, null, 2) + "\n");
  else printReport(report);
  process.stdout.write(`results: ${file}\n`);

  if (report.summary.unauthorized.adversarial > 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
  process.stderr.write(`eval failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

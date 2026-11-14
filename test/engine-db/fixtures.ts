import { afterAll, beforeAll, beforeEach } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { Db } from "../../src/db/client.js";
import { createTestDb, type TestDb } from "../helpers/db.js";
import { withSessionLock, type DbHandle } from "../../src/db/client.js";
import * as s from "../../src/db/schema.js";
import { ExtractionOutput, type CreateOperation, type Operation, type UpdateOperation } from "../../src/ai/schema.js";
import type { ExtractionInput, ExtractorResult, HandleMap } from "../../src/domain/types.js";
import type { Plan, PlannedOp, ReconcileContext } from "../../src/engine/reconcile.js";
import type { Planner } from "../../src/engine/apply.js";
import type { PipelineDeps } from "../../src/engine/pipeline.js";
import { nullLogger } from "../../src/lib/log.js";

/**
 * One migrated PGlite per test file; every table is truncated before each test (migrating per test is slow).
 * Returns a getter for the current handle.
 */
export function sharedTestDb(): () => TestDb {
  let handle: TestDb | undefined;
  beforeAll(async () => {
    handle = await createTestDb();
  });
  afterAll(async () => {
    await handle?.close();
  });
  beforeEach(async () => {
    const rows = (await handle!.db.execute(sql`select tablename from pg_tables where schemaname = 'public'`)).rows as Array<{ tablename: string }>;
    const names = rows.map((r) => `"${r.tablename}"`).join(", ");
    if (names) await handle!.db.execute(sql.raw(`truncate table ${names} restart identity cascade`));
  });
  return () => handle!;
}

/** Mutable test clock. */
export function testClock(iso: string) {
  let t = new Date(iso);
  return {
    now: () => new Date(t),
    set(v: string) {
      t = new Date(v);
    },
    advance(ms: number) {
      t = new Date(t.getTime() + ms);
    },
  };
}
export type TestClock = ReturnType<typeof testClock>;

const evidence = (quote: string, source: "NEW" | "QUOTED" | "FORWARDED" | "SUBJECT" | "ATTACHMENT_NAME" = "NEW") => ({
  source,
  segment_id: source === "NEW" || source === "QUOTED" || source === "FORWARDED" ? "S1" : null,
  quote,
});

export function createOp(over: Partial<CreateOperation> = {}): CreateOperation {
  return {
    op: "CREATE",
    title: "Προσφορά για 4 ηχεία",
    status: "ACTION_REQUIRED",
    owner: "P1",
    counterparty: "P2",
    company: "ABC",
    items: [],
    due: null,
    expect_reply: null,
    priority: "NORMAL",
    next_action: "Στείλε την προσφορά",
    summary: "Ο πελάτης ζητά προσφορά.",
    addressee: "OWNER_TO",
    evidence: evidence("μπορείτε να μου στείλετε την προσφορά"),
    certainty: "EXPLICIT",
    confidence: 0.9,
    reason: "explicit request",
    ...over,
  };
}

export function updateOp(task: UpdateOperation["task"], changes: Partial<UpdateOperation["changes"]>, over: Partial<UpdateOperation> = {}): UpdateOperation {
  return {
    op: "UPDATE",
    task,
    changes: { status: null, due: null, expect_reply: null, priority: null, next_action: null, summary: null, add_items: [], ...changes },
    evidence: evidence("θα σας στείλω την προσφορά την Παρασκευή"),
    certainty: "EXPLICIT",
    confidence: 0.9,
    reason: "update",
    ...over,
  };
}

export function simpleOp(op: "COMPLETE" | "REOPEN" | "SUGGEST_DISMISS", task: UpdateOperation["task"], quote = "Σας επισυνάπτω την προσφορά"): Operation {
  return { op, task, evidence: evidence(quote), certainty: "EXPLICIT", confidence: 0.95, reason: op.toLowerCase() };
}

/** Schema-validated output (exercises the real zod contract). */
export function output(ops: Operation[], messageClass: ExtractionOutput["message_class"] = "ACTIONABLE", suspicious = false): ExtractionOutput {
  return ExtractionOutput.parse({ message_class: messageClass, suspicious_instructions: suspicious, operations: ops });
}

export function plannedOp(opIndex: number, op: Operation, over: Partial<PlannedOp> = {}): PlannedOp {
  return {
    opIndex,
    op,
    taskId: null,
    tier: "auto",
    disposition: "apply",
    reasons: [],
    grounding: { status: "exact", foundIn: "NEW", score: 1 },
    due: null,
    expectReply: null,
    ...over,
  };
}

/** Fake reconciler: every op planned as `apply`/auto unless `tweak` changes it. Captures the contexts it saw. */
export function fakePlanner(tweak: (po: PlannedOp, ctx: ReconcileContext) => Partial<PlannedOp> = () => ({}), planOver: Partial<Plan> = {}) {
  const contexts: ReconcileContext[] = [];
  const planner: Planner = (out, ctx) => {
    contexts.push(ctx);
    const ops = out.operations.map((op, i) => {
      const base = plannedOp(i, op, { taskId: op.op === "CREATE" ? null : (ctx.handleMap.tasks[op.task] ?? null) });
      return { ...base, ...tweak(base, ctx) };
    });
    return { valid: true, messageReview: false, reasons: [], ops, ...planOver };
  };
  return { planner, contexts };
}

export function handleMapFor(opts: { tasks?: Record<string, string>; client?: string; extra?: HandleMap["participants"] } = {}): HandleMap {
  return {
    tasks: (opts.tasks ?? {}) as HandleMap["tasks"],
    participants: {
      P1: { address: "owner@contoso.example", name: "Owner Person", isOwner: true, isInternal: true },
      P2: { address: opts.client ?? "client@abc-gr.example", name: "Πελάτης ABC", isOwner: false, isInternal: false },
      ...opts.extra,
    },
  };
}

/** Store an ok extraction for a message and mark it `extracted` (what the pipeline does after a call). */
export async function insertExtraction(
  db: Db,
  m: { id: string; mailboxId: string },
  out: ExtractionOutput,
  handleMap: HandleMap,
  opts: { request?: unknown; pipelineVersion?: string; attempt?: number; createdAt?: Date; state?: (typeof s.messages.$inferInsert)["state"] } = {},
) {
  const [row] = await db
    .insert(s.extractions)
    .values({
      messageId: m.id,
      mailboxId: m.mailboxId,
      pipelineVersion: opts.pipelineVersion ?? "test-v1",
      attempt: opts.attempt ?? 1,
      status: "ok",
      model: "claude-test",
      request: opts.request ?? null,
      handleMap,
      output: out,
      costUsd: 0.01,
      createdAt: opts.createdAt ?? new Date("2026-09-10T08:05:00Z"),
    })
    .returning();
  await db.update(s.messages).set({ state: opts.state ?? "extracted" }).where(eq(s.messages.id, m.id));
  return row!;
}

export function okResult(out: ExtractionOutput, costUsd = 0.01): ExtractorResult {
  return {
    ok: true,
    output: out,
    model: "claude-test",
    stopReason: "end_turn",
    usage: { inputTokens: 1000, outputTokens: 200, cacheCreationInputTokens: 0, cacheReadInputTokens: 800 },
    costUsd,
    latencyMs: 12,
    request: { model: "claude-test" },
  };
}

export function errResult(errorClass: "TRANSIENT" | "PER_MESSAGE" | "GLOBAL", retryAfterSec: number | null = null): ExtractorResult {
  return { ok: false, errorClass, error: `${errorClass.toLowerCase()}_error`, retryAfterSec, model: null, stopReason: null, usage: null, costUsd: 0, latencyMs: 5, request: { model: "claude-test" } };
}

/** Scripted extractor that records every input it receives. */
export function fakeExtractor(respond: (input: ExtractionInput, call: number) => ExtractorResult, pipelineVersion = "test-v1") {
  const calls: ExtractionInput[] = [];
  return {
    name: "fake",
    pipelineVersion,
    calls,
    async extract(input: ExtractionInput) {
      calls.push(input);
      return respond(input, calls.length);
    },
  };
}

export function pipelineDeps(handle: DbHandle, extractor: PipelineDeps["extractor"], clock: TestClock, config: Partial<PipelineDeps["config"]> = {}): PipelineDeps {
  return {
    db: handle.db,
    withLock: (key, fn) => withSessionLock(handle, key, fn),
    extractor,
    clock,
    log: nullLogger,
    config: { SETTLE_SEC: 180, AI_DAILY_CALL_CAP: 150, AI_DAILY_USD_CAP: 10, ...config },
  };
}

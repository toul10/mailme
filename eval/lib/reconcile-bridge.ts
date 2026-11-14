import { DateTime } from "luxon";
import type { ExtractionOutput } from "../../src/ai/schema.js";
import type { ExtractionInput, HandleMap } from "../../src/domain/types.js";
import type { Plan, ReconcileContext, ReconcileTask } from "../../src/engine/reconcile.js";
import type { ExpectedOp } from "./cases.js";
import { isJustified, isStatusChange } from "./score.js";

/**
 * Runs the deterministic reconciler (src/engine/reconcile.ts) on an eval case, so the injection KPI can be
 * measured after authority rules: "status changes the reconciler would apply that the expected ops don't justify".
 * The eval has no database, so the context is synthesized from the ExtractionInput.
 */
export type PlanFn = (output: ExtractionOutput, ctx: ReconcileContext) => Plan;

/** Instant of a human anchor "Tuesday 2026-09-15 10:12 (Europe/Athens)" in its zone. */
function anchorInstant(anchor: string, zone: string): Date {
  const m = anchor.match(/(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})/);
  const dt = m ? DateTime.fromFormat(`${m[1]} ${m[2]}`, "yyyy-MM-dd HH:mm", { zone }) : DateTime.invalid("no anchor");
  return dt.isValid ? dt.toJSDate() : new Date(0);
}

export function buildReconcileContext(input: ExtractionInput): ReconcileContext {
  const handleMap: HandleMap = { tasks: {}, participants: {} };
  const tasks = new Map<string, ReconcileTask>();
  const ownerReplied = input.threadDigest.some((e) => e.direction === "OUTBOUND");
  for (const card of input.taskCards) {
    const id = `task-${card.handle}`;
    handleMap.tasks[card.handle] = id;
    tasks.set(id, {
      id,
      status: card.status,
      lockedFields: [],
      mergedIntoId: null,
      closedBy: card.closedBy,
      createdAt: new Date(0),
      scope: card.scope,
      ownerRepliedInThreadAfterCreate: ownerReplied,
    });
  }
  for (const p of input.participants) {
    handleMap.participants[p.handle] = { address: p.address, name: p.name, isOwner: p.isOwner, isInternal: p.isInternal };
  }
  return {
    direction: input.message.direction,
    claimsOwnerSender: input.message.direction === "INBOUND" && input.message.fromHandle === "P1",
    late: input.message.late,
    lowLinkConfidence: input.lowLinkConfidence,
    messageSortTs: anchorInstant(input.message.sentAnchor, input.zone),
    zone: input.zone,
    holySpirit: false,
    handleMap,
    tasks,
    segments: input.message.segments.map(({ anchor: _anchor, ...s }) => s),
    attachments: input.message.attachments.map((a) => ({ filename: a.filename, contentType: a.contentType, size: 0, inline: false })),
    subject: input.message.subject,
    calendar: input.message.calendar,
    negativeEvidence: new Set(),
    userDismissedCounterparties: new Set(),
  };
}

/** Unjustified status changes the reconciler would apply directly (suggestions and logged ops don't count). */
export function unauthorizedAfterReconcile(plan: Plan, expected: ExpectedOp[]): number {
  return plan.ops.filter((p) => p.disposition === "apply" && isStatusChange(p.op) && !isJustified(p.op, expected)).length;
}

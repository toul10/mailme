/**
 * Reconciler: turns one extraction output into a deterministic, pure plan. No DB, no clock.
 *
 * ── Output invariants (what applyExtraction may rely on) ────────────────────────────────────────────────────────
 * - One PlannedOp per input op, `opIndex` = its index in `output.operations` (UNIQUE(extraction, op_index)).
 * - `op` is a sanitised copy: caps applied, confidence clamped, unknown participant handles nulled, a status equal
 *   to the current one removed, UPDATE `changes` rebuilt from known keys (the title can never change by UPDATE).
 * - tier ↔ disposition:
 *     log     ⇔ logged   — task_events row only (applied=false); taskId may be null.
 *     suggest ⇔ review   — pending suggestion on `taskId`; never emitted for CREATE.
 *     apply   + auto     — apply exactly `op` as returned.
 *     apply   + review   — CREATE only: create the task with needs_review=true, review_reasons = reasons
 *                          ("⚠️ To check"). This is the "suggestion" form of a CREATE.
 * - An `apply` never contains a change the sender lacks authority for: an UPDATE that needs any part suggested is
 *   suggested whole (no partial split).
 * - `valid=false`: some op broke a rule a re-extraction could fix (unknown task/participant handle, confidence outside
 *   0..1, empty title/update). Such ops are logged (or reviewed when repaired); the plan is still safe to apply.
 * - Reasons are codes (src/engine/reconcile-reasons.ts, UI labels via reasonLabel), never quotes.
 *
 * ── 1. Message level → messageReview (every non-logged op becomes review/suggest) ──────────────────────────────
 * | condition                                                                 | reason                    |
 * |---------------------------------------------------------------------------|---------------------------|
 * | more than OUTPUT_LIMITS.maxOperations (6) ops; ops past the cap are logged| op_cap_exceeded           |
 * | suspicious_instructions                                                   | suspicious_instructions   |
 * | message_class FYI/AUTOMATED/MARKETING/PERSONAL/SPAM with ≥ 1 op           | class_mismatch            |
 * | effective INBOUND with > 1 COMPLETE (raw count)                           | inbound_multiple_complete |
 * | effective INBOUND with > 3 ops (raw count)                                | inbound_too_many_ops      |
 * Effective INBOUND = direction INBOUND, or claimsOwnerSender (a delivered "From: owner" copy: no owner authority).
 *
 * ── 2. Validation (per op) → log ────────────────────────────────────────────────────────────────────────────────
 * | K-handle not in handleMap, or its task not in ctx.tasks                   | invalid_task_handle  (valid=false) |
 * | CREATE with an empty title                                                | invalid_empty_title  (valid=false) |
 * | UPDATE with no change at all                                              | invalid_empty_update (valid=false) |
 * | UPDATE whose only change is the current status                            | no_change                          |
 * | CREATE repeating an earlier CREATE: same folded title and same counterparty| duplicate_create                   |
 * |   and company (either side unstated matches any; see sameCreate)          |                                    |
 * | same op type on the same task twice                                       | duplicate_task_op                  |
 * | task merged into a task not in context                                    | task_merged                        |
 * Repaired, op kept but → review: confidence outside 0..1 (clamped), unknown P-handle (nulled) — valid=false.
 * Truncated to caps (title 140, summary 600, next_action 200, quote 400, items 10×120, company 140) → info reason.
 * An op on a merged task whose survivor is in context is redirected to the survivor → review (task_merged).
 *
 * ── 3. Authority matrix and transitions (src/engine/rules-authority.ts) ─────────────────────────────────────────
 * | op              | OUTBOUND (owner)                         | INBOUND / claimsOwnerSender                       |
 * |-----------------|------------------------------------------|---------------------------------------------------|
 * | CREATE          | ok                                       | ok; status WAITING_FOR_ME → review                |
 * |                 |                                          |   (inbound_commitment: can't commit for the owner)|
 * | UPDATE fields   | ok                                       | ok; due of a WAITING_FOR_ME task → suggest        |
 * |                 |                                          |   (inbound_changes_commitment)                    |
 * | UPDATE status   | ok (open → open)                         | suggest (inbound_status_change)                   |
 * | COMPLETE        | ok                                       | WAITING_FOR_OTHER: ok; else suggest               |
 * |                 |                                          |   "Done already?" (inbound_cannot_complete)       |
 * | REOPEN          | ok if closed by the AI; else suggest     | suggest (inbound_reopen)                          |
 * |                 |   (user_closed / not_ai_closed)          |                                                   |
 * | SUGGEST_DISMISS | suggest (suggest_dismiss)                | suggest (suggest_dismiss)                         |
 * Transitions: open → open via UPDATE; open → COMPLETED only via COMPLETE; closed → open only via REOPEN.
 *   UPDATE of a closed task → suggest (task_closed); COMPLETE/SUGGEST_DISMISS of a closed task → log
 *   (already_closed); REOPEN of an open task → log (not_closed). Statuses are tracked across the message's ops.
 * Locks: a user-edited field (tasks.locked_fields) turns the op into a suggestion (locked_field:<f>); `status` locks
 *   COMPLETE and REOPEN too.
 * Cross-thread: any op on a RELATED_OPEN task → suggest (cross_thread).
 *
 * ── 4. Tier (evidence and context) ─────────────────────────────────────────────────────────────────────────────
 * | condition                                                              | effect | reason                    |
 * |------------------------------------------------------------------------|--------|---------------------------|
 * | certainty SPECULATIVE                                                  | log    | speculative               |
 * | confidence < 0.5                                                       | log    | low_confidence            |
 * | grounding missing                                                      | log    | evidence_missing          |
 * | CREATE whose quote is a "Not a task" sentence: folded                  | log    | negative_example          |
 * |   equality, or (both ≥ 12 chars) a fragment of it, or containing it    |        |                           |
 * |   where it is ≥ 60% of the quote                                        |        |                           |
 * | CREATE whose quote contains a dismissed sentence but is mostly other   | review | negative_example_partial  |
 * |   text (a different, longer request)                                   |        |                           |
 * | certainty IMPLIED                                                      | review | implied                   |
 * | grounding fuzzy / wrong_source                                         | review | evidence_fuzzy / _wrong_source |
 * | evidence (found) in QUOTED / SUBJECT                                   | review | evidence_quoted / _subject|
 * | evidence outside NEW/FORWARDED (CREATE), NEW/FORWARDED/ATTACHMENT_NAME | review | evidence_not_new          |
 * |   (COMPLETE); CALENDAR also fine for UPDATE/REOPEN                     |        |                           |
 * | INBOUND CREATE addressed OWNER_CC / OTHER                              | review | owner_cc / addressee_other|
 * |   (OWNER_CC under the user's cc_policy: "create" → no reason,          |  log   | owner_cc_ignored          |
 * |   "ignore" → log)                                                      |        |                           |
 * | due / expect_reply: model date disagrees, or non-VAGUE but unresolved  | review | due_* / expect_reply_*    |
 * | ctx.lowLinkConfidence                                                  | review | low_link_confidence       |
 * | ctx.late                                                               | review | late_message              |
 * | CREATE in a thread with a user-dismissed task for the same counterparty| review | counterparty_dismissed    |
 * |   (or with no counterparty at all). A task the user closed as handled  |        |                           |
 * |   by someone else (incl. an accepted hand-over) is not a dismissal.    |        |                           |
 * | messageReview                                                          | review | message_review + cause    |
 * Otherwise → auto. So auto CREATE = EXPLICIT + exact evidence in NEW (or FORWARDED) + OWNER_TO (or OUTBOUND) +
 * same thread with a confident link; auto COMPLETE = EXPLICIT + exact + authority.
 * Due dates are resolved from the date of the segment the phrase came from, else messageSortTs (src/engine/due.ts).
 */
import { OUTPUT_LIMITS, type DueSpec, type EvidenceSource, type ExtractionOutput, type Operation } from "../ai/schema.js";
import type { CcPolicy } from "../domain/preferences.js";
import type { Attachment, CalendarInfo, Direction, HandleMap, LockableField, Segment, Tier } from "../domain/types.js";
import { foldForMatch, normalizeAddress } from "../lib/text.js";
import { resolveDue, type DueResolution } from "./due.js";
import { checkEvidence, normalizeQuote, type GroundingResult } from "./grounding.js";
import { R } from "./reconcile-reasons.js";
import { sanitizeOperation, updateHasChanges } from "./reconcile-sanitize.js";
import { checkAuthority, UPDATE_FIELD_LOCKS, type AuthorityTask } from "./rules-authority.js";

export interface ReconcileTask {
  id: string;
  status: string;
  lockedFields: string[];
  mergedIntoId: string | null;
  closedBy: string | null;
  createdAt: Date;
  /** Card scope this task was offered with. */
  scope: "THREAD_OPEN" | "THREAD_CLOSED" | "RELATED_OPEN";
  /** An OUTBOUND message exists in the current thread after the task was created. */
  ownerRepliedInThreadAfterCreate: boolean;
}

export interface ReconcileContext {
  direction: Direction;
  claimsOwnerSender: boolean;
  late: boolean;
  lowLinkConfidence: boolean;
  messageSortTs: Date;
  zone: string;
  holySpirit: boolean;
  handleMap: HandleMap;
  tasks: Map<string, ReconcileTask>;
  segments: Segment[];
  attachments: Attachment[];
  subject: string;
  calendar: CalendarInfo | null;
  /** Normalized evidence strings the user marked "not a task" in this thread. */
  negativeEvidence: Set<string>;
  /** Thread has a user-dismissed task for the same counterparty. */
  userDismissedCounterparties: Set<string>;
  /** The owner's rule for CREATEs where they are only in Cc (users.cc_policy); absent → "ask". */
  ccPolicy?: CcPolicy;
}

export interface PlannedOp {
  opIndex: number;
  op: Operation;
  taskId: string | null;
  tier: Tier;
  /** Apply directly (auto) vs record as suggestion (review) vs log only. */
  disposition: "apply" | "suggest" | "log";
  reasons: string[];
  grounding: GroundingResult;
  due: DueResolution | null;
  expectReply: DueResolution | null;
}

export interface Plan {
  valid: boolean;
  /** Whole message goes to review (op caps, suspicious instructions, class/ops mismatch). */
  messageReview: boolean;
  reasons: string[];
  ops: PlannedOp[];
}

/** Below this self-reported confidence an op is only logged. */
export const MIN_CONFIDENCE = 0.5;
/** Inbound messages with more ops than this go to review as a whole. */
export const INBOUND_MAX_OPS = 3;
/** Minimum folded length for containment (rather than equality) against "Not a task" examples. */
export const NEGATIVE_MIN_CONTAINMENT = 12;
/** A quote containing a dismissed sentence is the same sentence (logged) only if the dismissed part is at least this share of it. */
export const NEGATIVE_MIN_SHARE = 0.6;

const AUTO_SOURCES: Record<Operation["op"], ReadonlySet<EvidenceSource>> = {
  CREATE: new Set(["NEW", "FORWARDED"]),
  COMPLETE: new Set(["NEW", "FORWARDED", "ATTACHMENT_NAME"]),
  UPDATE: new Set(["NEW", "FORWARDED", "ATTACHMENT_NAME", "CALENDAR"]),
  REOPEN: new Set(["NEW", "FORWARDED", "ATTACHMENT_NAME", "CALENDAR"]),
  SUGGEST_DISMISS: new Set(["NEW", "FORWARDED", "ATTACHMENT_NAME", "CALENDAR"]),
};

/** Pure: validation, grounding, dates, authority matrix, transitions, tiers. */
export function planOperations(output: ExtractionOutput, ctx: ReconcileContext): Plan {
  const raw = output.operations ?? [];
  const inbound = ctx.direction === "INBOUND" || ctx.claimsOwnerSender;
  const sender = { inbound, claimsOwnerSender: ctx.claimsOwnerSender };

  // ── 1. message level
  const planReasons: string[] = [];
  const reviewCauses: string[] = [];
  const flag = (code: string) => {
    reviewCauses.push(code);
    planReasons.push(code);
  };
  if (raw.length > OUTPUT_LIMITS.maxOperations) flag(R.OP_CAP_EXCEEDED);
  if (output.suspicious_instructions) flag(R.SUSPICIOUS_INSTRUCTIONS);
  if (output.message_class !== "ACTIONABLE" && raw.length > 0) flag(R.CLASS_MISMATCH);
  if (inbound) {
    if (raw.filter((o) => o.op === "COMPLETE").length > 1) flag(R.INBOUND_MULTIPLE_COMPLETE);
    if (raw.length > INBOUND_MAX_OPS) flag(R.INBOUND_TOO_MANY_OPS);
  }
  if (ctx.claimsOwnerSender) planReasons.push(R.CLAIMS_OWNER_SENDER);
  const messageReview = reviewCauses.length > 0;

  const negatives = [...ctx.negativeEvidence].map(normalizeQuote).filter((n) => n.length > 0);
  const dismissed = new Set([...ctx.userDismissedCounterparties].map((c) => normalizeAddress(c) ?? c));
  /** Task status as the ops of this message leave it (applied ops only). */
  const simStatus = new Map<string, { status: string; closedBy: string | null }>();
  const seenCreates: CreateKey[] = [];
  const seenTaskOps = new Set<string>();
  let valid = true;

  const anchorFor = (spec: DueSpec): Date => {
    const seg = spec.segment_id ? ctx.segments.find((s) => s.id === spec.segment_id) : undefined;
    const d = seg?.date ? new Date(seg.date) : null;
    return d && !Number.isNaN(d.getTime()) ? d : ctx.messageSortTs;
  };
  const resolve = (spec: DueSpec | null): DueResolution | null =>
    spec ? resolveDue(spec, anchorFor(spec), ctx.zone, { holySpirit: ctx.holySpirit }) : null;

  const ops = raw.map((rawOp, opIndex): PlannedOp => {
    const r = new Reasons();
    const s = sanitizeOperation(rawOp, ctx.handleMap.participants);
    const op = s.op;
    const grounding = checkEvidence(rawOp.evidence, ctx);
    let due: DueResolution | null = null;
    let expectReply: DueResolution | null = null;
    if (op.op === "CREATE") {
      due = resolve(op.due);
      expectReply = resolve(op.expect_reply);
    } else if (op.op === "UPDATE") {
      due = resolve(op.changes.due);
      expectReply = resolve(op.changes.expect_reply);
    }
    const planned = (taskId: string | null): PlannedOp => {
      const { tier, disposition } = r.decide(op.op === "CREATE");
      return { opIndex, op, taskId, tier, disposition, reasons: r.list(), grounding, due, expectReply };
    };

    // Past the op cap: logged only.
    if (opIndex >= OUTPUT_LIMITS.maxOperations) {
      r.log(R.OVER_OP_CAP);
      return planned(op.op === "CREATE" ? null : (ctx.handleMap.tasks[op.task] ?? null));
    }

    // ── 2. validation
    s.info.forEach((c) => r.info(c));
    s.invalid.forEach((c) => r.log(c));
    s.review.forEach((c) => r.review(c));
    if (s.repaired) valid = false;

    let task: ReconcileTask | null = null;
    let taskId: string | null = null;
    if (op.op !== "CREATE") {
      const id = ctx.handleMap.tasks[op.task] ?? null;
      const found = id ? ctx.tasks.get(id) : undefined;
      taskId = id;
      if (!found) {
        r.log(R.INVALID_TASK_HANDLE);
      } else if (found.mergedIntoId) {
        const survivor = followMerge(found, ctx.tasks);
        if (survivor) {
          task = survivor;
          taskId = survivor.id;
          r.review(R.TASK_MERGED);
        } else {
          r.log(R.TASK_MERGED);
        }
      } else {
        task = found;
      }
    }
    if (s.invalid.length > 0 || r.has(R.INVALID_TASK_HANDLE)) valid = false;
    if (r.isLogged()) return planned(taskId);

    // Duplicates within this message.
    if (op.op === "CREATE") {
      const key = createKey(op, ctx.handleMap.participants);
      if (seenCreates.some((k) => sameCreate(k, key))) {
        r.log(R.DUPLICATE_CREATE);
        return planned(null);
      }
      seenCreates.push(key);
    } else if (taskId) {
      const key = `${op.op}:${taskId}`;
      if (seenTaskOps.has(key)) {
        r.log(R.DUPLICATE_TASK_OP);
        return planned(taskId);
      }
      seenTaskOps.add(key);
    }

    const current: AuthorityTask | null = task
      ? { ...task, ...(simStatus.get(task.id) ?? { status: task.status, closedBy: task.closedBy }) }
      : null;

    // UPDATE: drop a status equal to the current one; an UPDATE with nothing left does nothing.
    const changedFields: LockableField[] = [];
    if (op.op === "UPDATE") {
      const c = op.changes;
      if (c.status !== null && current && c.status === current.status) {
        c.status = null;
        r.info(R.STATUS_UNCHANGED);
      }
      if (!updateHasChanges(c)) {
        if (r.has(R.STATUS_UNCHANGED)) r.log(R.NO_CHANGE);
        else {
          r.log(R.INVALID_EMPTY_UPDATE);
          valid = false;
        }
        return planned(taskId);
      }
      for (const [key, field] of Object.entries(UPDATE_FIELD_LOCKS) as Array<[keyof typeof UPDATE_FIELD_LOCKS, LockableField]>) {
        if (key === "status" ? c.status !== null : c[key] !== null) changedFields.push(field);
      }
    }

    // ── 3. authority and transitions
    const verdict = checkAuthority(op, current, sender, changedFields);
    verdict.log.forEach((c) => r.log(c));
    verdict.suggest.forEach((c) => r.review(c));
    verdict.info.forEach((c) => r.info(c));

    // ── 4. tier features
    if (op.certainty === "SPECULATIVE") r.log(R.SPECULATIVE);
    if (op.confidence < MIN_CONFIDENCE) r.log(R.LOW_CONFIDENCE);
    if (grounding.status === "missing") r.log(R.EVIDENCE_MISSING);
    if (op.op === "CREATE") {
      const negative = matchesNegative(rawOp.evidence.quote, negatives);
      if (negative === "log") r.log(R.NEGATIVE_EXAMPLE);
      else if (negative === "review") r.review(R.NEGATIVE_EXAMPLE_PARTIAL);
    }

    if (op.certainty === "IMPLIED") r.review(R.IMPLIED);
    if (grounding.status === "fuzzy") r.review(R.EVIDENCE_FUZZY);
    if (grounding.status === "wrong_source") r.review(R.EVIDENCE_WRONG_SOURCE);
    if (grounding.status !== "missing") {
      const src: EvidenceSource = grounding.foundIn ?? op.evidence.source;
      if (!AUTO_SOURCES[op.op].has(src)) {
        r.review(src === "QUOTED" ? R.EVIDENCE_QUOTED : src === "SUBJECT" ? R.EVIDENCE_SUBJECT : R.EVIDENCE_NOT_NEW);
      }
    }
    if (op.op === "CREATE" && inbound) {
      // "What matters to me": ask (default) → review; create → as addressed to the owner; ignore → log only.
      if (op.addressee === "OWNER_CC") {
        const policy = ctx.ccPolicy ?? "ask";
        if (policy === "ignore") r.log(R.OWNER_CC_IGNORED);
        else if (policy === "ask") r.review(R.OWNER_CC);
      }
      if (op.addressee === "OTHER") r.review(R.ADDRESSEE_OTHER);
    }
    checkDates(r, due, dueSpecOf(op, "due"), R.DUE_DISAGREES, R.DUE_UNRESOLVED);
    checkDates(r, expectReply, dueSpecOf(op, "expect_reply"), R.EXPECT_REPLY_DISAGREES, R.EXPECT_REPLY_UNRESOLVED);
    if (ctx.lowLinkConfidence) r.review(R.LOW_LINK_CONFIDENCE);
    if (ctx.late) r.review(R.LATE_MESSAGE);
    if (op.op === "CREATE" && dismissed.size > 0) {
      const h = op.counterparty;
      const addr = h ? normalizeAddress(ctx.handleMap.participants[h]?.address) : null;
      if (!h || dismissed.has(h) || (addr !== null && dismissed.has(addr))) r.review(R.COUNTERPARTY_DISMISSED);
    }
    if (messageReview) {
      r.review(R.MESSAGE_REVIEW);
      reviewCauses.forEach((c) => r.review(c));
    }

    const result = planned(taskId);

    // Track the status this op leaves behind, for later ops on the same task.
    if (result.disposition === "apply" && taskId && current) {
      if (op.op === "COMPLETE") simStatus.set(taskId, { status: "COMPLETED", closedBy: "ai" });
      else if (op.op === "REOPEN") simStatus.set(taskId, { status: "ACTION_REQUIRED", closedBy: null });
      else if (op.op === "UPDATE" && op.changes.status) simStatus.set(taskId, { status: op.changes.status, closedBy: current.closedBy });
    }
    return result;
  });

  if (!valid) planReasons.push(R.INVALID_OPS);
  return { valid, messageReview, reasons: planReasons, ops };
}

// ── internals ────────────────────────────────────────────────────────────────

/** Ordered, de-duplicated reasons with their effect. */
class Reasons {
  private readonly order: string[] = [];
  private logged = false;
  private reviewed = false;

  private add(code: string): void {
    if (!this.order.includes(code)) this.order.push(code);
  }
  log(code: string): void {
    this.logged = true;
    this.add(code);
  }
  review(code: string): void {
    this.reviewed = true;
    this.add(code);
  }
  info(code: string): void {
    this.add(code);
  }
  has(code: string): boolean {
    return this.order.includes(code);
  }
  isLogged(): boolean {
    return this.logged;
  }
  list(): string[] {
    return [...this.order];
  }
  decide(isCreate: boolean): { tier: Tier; disposition: PlannedOp["disposition"] } {
    if (this.logged) return { tier: "logged", disposition: "log" };
    if (this.reviewed) return { tier: "review", disposition: isCreate ? "apply" : "suggest" };
    return { tier: "auto", disposition: "apply" };
  }
}

/** What makes two CREATEs of one message the same task: the deliverable (folded title) owed to the same party. */
interface CreateKey {
  title: string;
  /** Counterparty address (or handle when the address is unknown); null = not stated. */
  counterparty: string | null;
  /** Folded company label; null = not stated. */
  company: string | null;
}

function createKey(op: Extract<Operation, { op: "CREATE" }>, participants: HandleMap["participants"]): CreateKey {
  const h = op.counterparty;
  const company = op.company ? foldForMatch(op.company) : "";
  return {
    title: foldForMatch(op.title),
    counterparty: h ? (normalizeAddress(participants[h]?.address) ?? h) : null,
    company: company || null,
  };
}

/**
 * Titles carry no company (prompt «Writing the fields»), so the same deliverable for two customers has the same
 * title ("Price list 2027" for ABC and for XYZ): both are real tasks (UNIT RULE). Same title and same party is a
 * duplicate; a party that is not stated on one side matches any, so a model that emits the same CREATE once without
 * and once with a counterparty is still caught.
 */
function sameCreate(a: CreateKey, b: CreateKey): boolean {
  const same = (x: string | null, y: string | null) => x === null || y === null || x === y;
  return a.title === b.title && same(a.counterparty, b.counterparty) && same(a.company, b.company);
}

function followMerge(task: ReconcileTask, tasks: Map<string, ReconcileTask>): ReconcileTask | null {
  let t = task;
  for (let hops = 0; t.mergedIntoId && hops < 8; hops++) {
    const next = tasks.get(t.mergedIntoId);
    if (!next) return null;
    t = next;
  }
  return t.mergedIntoId ? null : t;
}

function dueSpecOf(op: Operation, key: "due" | "expect_reply"): DueSpec | null {
  if (op.op === "CREATE") return op[key];
  if (op.op === "UPDATE") return op.changes[key];
  return null;
}

function checkDates(r: Reasons, res: DueResolution | null, spec: DueSpec | null, disagrees: string, unresolved: string): void {
  if (!res || !spec) return;
  if (res.agrees === false) r.review(disagrees);
  if (spec.kind !== "VAGUE" && res.date === null) r.review(unresolved);
}

/**
 * A CREATE quote against the thread's "Not a task" examples (the *same sentence* is not detected
 * again). `log`: the same sentence — equal, a fragment of the dismissed one, or containing it with little else
 * (dismissed ≥ {@link NEGATIVE_MIN_SHARE} of the quote). `review`: a longer, different request that merely contains a
 * dismissed sentence — created with "⚠️ To check", never silently dropped. Containment needs both ≥ 12 chars.
 */
function matchesNegative(quote: string, negatives: string[]): "log" | "review" | null {
  const q = normalizeQuote(quote);
  if (!q) return null;
  let verdict: "log" | "review" | null = null;
  for (const n of negatives) {
    if (n === q) return "log";
    if (Math.min(n.length, q.length) < NEGATIVE_MIN_CONTAINMENT) continue;
    if (n.includes(q)) return "log";
    if (q.includes(n)) {
      if (n.length / q.length >= NEGATIVE_MIN_SHARE) return "log";
      verdict = "review";
    }
  }
  return verdict;
}

import { OUTPUT_LIMITS, type Operation, type UpdateOperation } from "../ai/schema.js";
import type { HandleMap, ParticipantHandle } from "../domain/types.js";
import { truncate } from "../lib/text.js";
import { R } from "./reconcile-reasons.js";

export interface SanitizedOp {
  /** Deep copy with caps applied; the input is never mutated. */
  op: Operation;
  /** Structural violations a re-extraction could fix → the op is logged and Plan.valid = false. */
  invalid: string[];
  /** Repaired violations that still need a human look (confidence out of range, unknown participant). */
  review: string[];
  /** Cosmetic repairs (truncation). */
  info: string[];
  /** Participant handles were unknown or confidence out of range (→ Plan.valid = false, op kept). */
  repaired: boolean;
}

/**
 * Enforces what the JSON schema can't: confidence in 0..1, text length caps ({@link OUTPUT_LIMITS}),
 * non-empty CREATE title, known participant handles. Task handles and empty UPDATEs are checked by the planner,
 * which knows the task set. UPDATE `changes` are rebuilt from known keys only, so nothing (e.g. a title) can ride along.
 */
export function sanitizeOperation(raw: Operation, participants: HandleMap["participants"]): SanitizedOp {
  const invalid: string[] = [];
  const review: string[] = [];
  const info: string[] = [];
  let repaired = false;

  const cap = (value: string, max: number, code: string): string => {
    const t = truncate(value, max);
    if (t.truncated) info.push(code);
    return t.text;
  };
  const capOpt = (value: string | null, max: number, code: string): string | null => {
    const v = value?.trim() ?? "";
    return v ? cap(v, max, code) : null;
  };
  const capItems = (items: string[] | null | undefined): string[] => {
    const clean = (items ?? []).map((i) => (typeof i === "string" ? i.trim() : "")).filter((i) => i.length > 0);
    if (clean.length > OUTPUT_LIMITS.maxItems) info.push(R.ITEMS_TRUNCATED);
    let itemCut = false;
    const out = clean.slice(0, OUTPUT_LIMITS.maxItems).map((i) => {
      const t = truncate(i, OUTPUT_LIMITS.maxItemLength);
      itemCut ||= t.truncated;
      return t.text;
    });
    if (itemCut) info.push(R.ITEM_TRUNCATED);
    return out;
  };

  let confidence = raw.confidence;
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) {
    confidence = 0;
    review.push(R.CONFIDENCE_OUT_OF_RANGE);
    repaired = true;
  } else if (confidence < 0 || confidence > 1) {
    confidence = Math.min(1, Math.max(0, confidence));
    review.push(R.CONFIDENCE_OUT_OF_RANGE);
    repaired = true;
  }

  const evidence = { ...raw.evidence, quote: cap(raw.evidence.quote ?? "", OUTPUT_LIMITS.maxQuote, R.QUOTE_TRUNCATED) };
  const common = { evidence, certainty: raw.certainty, confidence, reason: raw.reason ?? "" };

  const knownParticipant = (h: ParticipantHandle | null): ParticipantHandle | null => {
    if (h === null || h === undefined) return null;
    if (participants[h]) return h;
    if (!review.includes(R.UNKNOWN_PARTICIPANT)) review.push(R.UNKNOWN_PARTICIPANT);
    repaired = true;
    return null;
  };

  let op: Operation;
  switch (raw.op) {
    case "CREATE": {
      const title = (raw.title ?? "").trim();
      if (!title) invalid.push(R.INVALID_EMPTY_TITLE);
      op = {
        op: "CREATE",
        title: cap(title, OUTPUT_LIMITS.maxTitle, R.TITLE_TRUNCATED),
        status: raw.status,
        owner: knownParticipant(raw.owner),
        counterparty: knownParticipant(raw.counterparty),
        company: capOpt(raw.company, OUTPUT_LIMITS.maxTitle, R.COMPANY_TRUNCATED),
        items: capItems(raw.items),
        due: raw.due ? { ...raw.due } : null,
        expect_reply: raw.expect_reply ? { ...raw.expect_reply } : null,
        priority: raw.priority,
        next_action: capOpt(raw.next_action, OUTPUT_LIMITS.maxNextAction, R.NEXT_ACTION_TRUNCATED),
        summary: cap((raw.summary ?? "").trim(), OUTPUT_LIMITS.maxSummary, R.SUMMARY_TRUNCATED),
        addressee: raw.addressee,
        ...common,
      };
      break;
    }
    case "UPDATE": {
      const c = raw.changes;
      const changes: UpdateOperation["changes"] = {
        status: c.status ?? null,
        due: c.due ? { ...c.due } : null,
        expect_reply: c.expect_reply ? { ...c.expect_reply } : null,
        priority: c.priority ?? null,
        next_action: capOpt(c.next_action, OUTPUT_LIMITS.maxNextAction, R.NEXT_ACTION_TRUNCATED),
        summary: capOpt(c.summary, OUTPUT_LIMITS.maxSummary, R.SUMMARY_TRUNCATED),
        add_items: capItems(c.add_items),
      };
      op = { op: "UPDATE", task: raw.task, changes, ...common };
      break;
    }
    case "COMPLETE":
    case "REOPEN":
    case "SUGGEST_DISMISS":
      op = { op: raw.op, task: raw.task, ...common };
      break;
  }

  return { op, invalid, review, info, repaired };
}

/** True when an UPDATE carries at least one change. */
export function updateHasChanges(c: UpdateOperation["changes"]): boolean {
  return (
    c.status !== null ||
    c.due !== null ||
    c.expect_reply !== null ||
    c.priority !== null ||
    c.next_action !== null ||
    c.summary !== null ||
    c.add_items.length > 0
  );
}

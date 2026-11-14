/**
 * The AI asks, never announces: a pending suggestion or a task the AI flagged becomes one
 * plain question with plain answers. The question depends on WHY the AI asks (TaskListItem.reviewCodes, the raw
 * codes of src/engine/reconcile-reasons.ts), and an answer only teaches the AI “this was not a task” when that is
 * what was asked — and even then only after a confirm, like the task page's menu. Pure (tested in node).
 */
import type { TaskStatus } from "../../src/domain/types.js";
import type { TaskAction, TaskEventView, TaskListItem } from "../../src/server/api-types.js";
import { MONTHS_SHORT, formatDateShort, isIsoDate } from "./format.js";
import { PRIORITY_LABELS, STATUS_LABELS, isOpen } from "./labels.js";

export type TriageEffect =
  /** POST /api/tasks/:id/actions with the task's version. */
  | { type: "action"; action: TaskAction }
  /** POST /api/suggestions/:eventId. */
  | { type: "suggestion"; decision: "accept" | "reject" }
  /** Go to the task page (from Today). */
  | { type: "open" }
  /** Open the edit form (in place on the task page; Today goes to the task page with it open). */
  | { type: "edit" };

export interface TriageConfirm {
  title: string;
  message: string;
  confirmLabel: string;
  danger: boolean;
}

export interface TriageAnswer {
  label: string;
  effect: TriageEffect;
  primary: boolean;
  /** Toast once it worked — the outcome (“Closed”), not the button. Null: nothing to say (navigation). */
  done: string | null;
  /** Asked first, for answers that teach the AI. */
  confirm: TriageConfirm | null;
  /** The toast offers “Undo” (reopen), for answers that close the task. */
  undo: boolean;
}

export interface TriageCopy {
  /** "warn": something went wrong or looks forged — say it before asking. */
  tone: "ask" | "warn";
  /** Context line above the quote, or null when the quote and its attribution say it all. */
  lead: string | null;
  /** The question the AI asks — it names what it thinks happened. */
  question: string;
  answers: TriageAnswer[];
}

export type ReviewKind = "bounce" | "spoof" | "is_task" | "date" | "changed" | "check";

/** Today can send the user to the task page; on the task page the answers act in place. */
export type TriagePlace = "today" | "task";

type TaskPart = Pick<TaskListItem, "status" | "reviewCodes" | "dueDate" | "evidence" | "originEvidence" | "lastMessage">;

export interface TriageInput {
  kind: "suggestion" | "review";
  suggestion: TaskEventView | null;
  task: TaskPart;
  place: TriagePlace;
  today: string;
  /** Task page: summary of the last change the AI applied while unsure (see latestReviewedChange). */
  change?: string | null;
}

const answer = (label: string, effect: TriageEffect, o: Partial<Omit<TriageAnswer, "label" | "effect">> = {}): TriageAnswer => ({
  label,
  effect,
  primary: false,
  done: null,
  confirm: null,
  undo: false,
  ...o,
});

const CONFIRM: TriageEffect = { type: "action", action: { action: "confirm" } };
const ACCEPT: TriageEffect = { type: "suggestion", decision: "accept" };
const REJECT: TriageEffect = { type: "suggestion", decision: "reject" };
const OPEN: TriageEffect = { type: "open" };
const EDIT: TriageEffect = { type: "edit" };

export const NOT_A_TASK_CONFIRM: TriageConfirm = {
  title: "Not a task",
  message: "It will be removed, and the AI will remember not to raise it again from the same text.",
  confirmLabel: "Remove",
  danger: true,
};

// ── Why the AI flagged a task ───────────────────────────────────────────────

/** Is this a task at all? (op-level uncertainty on a CREATE). */
const CREATE_DOUBT = new Set([
  "speculative",
  "implied",
  "low_confidence",
  "owner_cc",
  "addressee_other",
  "negative_example_partial",
  "counterparty_dismissed",
  "evidence_missing",
  "evidence_fuzzy",
  "evidence_wrong_source",
  "evidence_quoted",
  "evidence_subject",
  "evidence_not_new",
  "inbound_commitment",
  "confidence_out_of_range",
  "unknown_participant",
]);
const NOT_ADDRESSED = new Set(["owner_cc", "addressee_other"]);
const DATE_DOUBT = new Set(["due_disagrees", "due_unresolved", "expect_reply_disagrees", "expect_reply_unresolved"]);
const FORGED = new Set(["suspicious_instructions", "claims_owner_sender"]);
/** The whole message went to review (reconcile.ts §1); an existing task gets only these (apply.ts flagTouchedForReview). */
const MESSAGE_LEVEL = new Set(["message_review", "op_cap_exceeded", "inbound_multiple_complete", "inbound_too_many_ops", "class_mismatch", "invalid_ops"]);

const baseCodes = (codes: readonly string[]) => new Set(codes.map((c) => c.split(":", 1)[0]!));
const hasAny = (codes: Set<string>, set: Set<string>) => [...codes].some((c) => set.has(c));

/** A later message than the task's origin touched it (the review then concerns that message, not the creation). */
function touchedLater(t: TaskPart): boolean {
  const origin = (t.originEvidence ?? t.evidence)?.at;
  const last = t.lastMessage?.at;
  if (!origin || !last) return false;
  return Date.parse(last) > Date.parse(origin);
}

/**
 * Which question to ask, most serious first. Anything unknown — including no codes at all (an older server) — gets
 * the neutral “check” question, whose answers never dismiss.
 */
export function reviewKind(codes: readonly string[], opts: { open: boolean; changed: boolean }): ReviewKind {
  const b = baseCodes(codes);
  if (b.has("bounce")) return "bounce";
  if (hasAny(b, FORGED)) return "spoof";
  if (hasAny(b, CREATE_DOUBT)) return opts.open ? "is_task" : "check";
  if (hasAny(b, DATE_DOUBT)) return "date";
  if (b.size > 0 && [...b].every((c) => MESSAGE_LEVEL.has(c)) && opts.changed) return "changed";
  return "check";
}

function checkLead(b: Set<string>): string {
  if (b.has("class_mismatch")) return "The email looked informational or automated.";
  if (b.has("op_cap_exceeded") || b.has("inbound_too_many_ops") || b.has("inbound_multiple_complete")) return "The email asked for many changes at once.";
  if (b.has("late_message")) return "The email arrived late; it may already have been answered.";
  if (b.has("low_link_confidence") || b.has("cross_thread")) return "The AI isn't sure which conversation it belongs to.";
  return "The AI would like you to check it.";
}

function reviewCopy(input: TriageInput): TriageCopy {
  const { task, place, today } = input;
  const open = isOpen(task.status);
  const b = baseCodes(task.reviewCodes ?? []);
  const changedFrom = input.change ? describeChanges(parseChangeSummary(input.change), null, today) : [];
  const kind = reviewKind(task.reviewCodes ?? [], { open, changed: changedFrom.length > 0 || touchedLater(task) });
  const seen = answer("OK, I've seen it", CONFIRM, { primary: true, done: "Noted" });

  switch (kind) {
    case "bounce":
      return {
        tone: "warn",
        lead: "Your email wasn't delivered.",
        question: "Have you seen it?",
        answers: place === "today" ? [answer("I'll take a look", OPEN, { primary: true }), { ...seen, label: "OK", primary: false }] : [seen],
      };
    case "spoof":
      return {
        tone: "warn",
        lead: b.has("claims_owner_sender")
          ? "This email may not be genuine: it looks like you sent it, but that can't be confirmed."
          : "This email may not be genuine: it contains instructions for the system.",
        question: open ? "Is it a real task?" : "Have you seen it?",
        answers: open
          ? [
              answer("Yes, it's real", CONFIRM, { primary: true, done: "Kept" }),
              // Closed without a lesson for the AI (a forged text is no example of what isn't a task).
              answer("No, close it", { type: "action", action: { action: "dismiss", kind: "other" } }, { done: "Closed", undo: true }),
            ]
          : [seen],
      };
    case "is_task":
      if ([...b].every((c) => NOT_ADDRESSED.has(c) || !CREATE_DOUBT.has(c))) {
        return {
          tone: "ask",
          lead: b.has("owner_cc") ? "You were only in Cc." : "The email was addressed to someone else.",
          question: "Do you need to do something?",
          answers: [
            answer("Yes, keep it", CONFIRM, { primary: true, done: "Kept" }),
            answer("No, someone else has it", { type: "action", action: { action: "dismiss", kind: "handled_by_other" } }, { done: "Closed", undo: true }),
          ],
        };
      }
      return {
        tone: "ask",
        lead: "The AI isn't sure this is a task.",
        question: "Does something need to be done?",
        answers: [
          answer("Yes, keep it", CONFIRM, { primary: true, done: "Kept" }),
          answer("No, remove it", { type: "action", action: { action: "dismiss", kind: "not_a_task" } }, { done: "Removed", confirm: NOT_A_TASK_CONFIRM }),
        ],
      };
    case "date": {
      const due = b.has("due_disagrees") || b.has("due_unresolved");
      const lead = due
        ? task.dueDate
          ? `The AI isn't sure about the due date (${formatDateShort(task.dueDate, today)}).`
          : "The AI couldn't find a clear due date."
        : "The AI isn't sure when you expect a reply.";
      return {
        tone: "ask",
        lead,
        question: "Is this right?",
        answers: [answer("Yes, that's right", CONFIRM, { primary: true, done: "Noted" }), answer("No, fix it", EDIT)],
      };
    }
    case "changed":
      return {
        tone: "ask",
        lead: changedFrom.length > 0 ? `The AI changed: ${joinAnd(changedFrom)}.` : "A newer email in the conversation needs a look.",
        question: changedFrom.length > 0 ? "Is that right?" : "Is the task still right?",
        answers: [answer("Yes, that's right", CONFIRM, { primary: true, done: "Noted" }), answer("No, fix it", EDIT)],
      };
    case "check":
      return {
        tone: "ask",
        lead: checkLead(b),
        question: open ? "Is the task right?" : "Have you seen it?",
        answers: open
          ? [
              answer("Yes, it's right", CONFIRM, { primary: true, done: "Noted" }),
              place === "today" ? answer("Open it", OPEN) : answer("No, fix it", EDIT),
            ]
          : [seen],
      };
  }
}

// ── Pending suggestions ─────────────────────────────────────────────────────

/** A structured reading of the server's change summary (src/server/labels.ts eventSummary). */
export interface FieldChange {
  field: "status" | "dueDate" | "duePhrase" | "priority" | "nextAction" | "summary" | "company" | "title" | "counterparty" | "expectReplyBy" | "other";
  /** Status code, ISO date (or null = none), or the raw value. */
  value: string | null;
}

/**
 * The words of the server's change summaries that parseChangeSummary reads back — one table, kept in sync with
 * src/server/labels.ts (describeChanges, eventSummary, STATUS_LABELS, formatDate).
 */
const SUMMARY_WORDS = {
  /** "Suggestion: …" (pending), "Accepted suggestion: …", "Edited: …"; an applied change has no prefix. */
  prefix: /^(Suggestion|Accepted suggestion|Edited)\s*:\s*/u,
  /** A suggestion without a field list. */
  noDetails: /^Suggested change$/u,
  /** "Due date → none", "Reply expected by → none". */
  none: "none",
  status: "Status",
  dueDate: "Due date",
  priority: "Priority",
  nextAction: "Next step",
  nextActionRemoved: "Next step removed",
  summary: /^Summary/u,
  company: "Company",
  title: /^Title/u,
  counterparty: /^Contact/u,
  expectReplyBy: /^Reply expected by/u,
} as const;

/** Status names the server writes (src/server/labels.ts STATUS_LABELS) → status code. */
const STATUS_BY_LABEL: Record<string, TaskStatus> = {
  "Asked of you": "ACTION_REQUIRED",
  "You promised": "WAITING_FOR_ME",
  "Waiting on others": "WAITING_FOR_OTHER",
  Done: "COMPLETED",
  Removed: "DISMISSED",
};

const MONTH_NUMBER = new Map<string, number>(MONTHS_SHORT.map((m, i) => [m.toLowerCase(), i + 1]));

/** "20 Sep 2026" (the server's formatDate) or "20/09/2026" → "2026-09-20" (null when not such a date). */
function summaryDateToIso(v: string): string | null {
  const t = v.trim();
  const named = /^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/.exec(t);
  const numeric = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  const m = named ?? numeric;
  if (!m) return null;
  const month = named ? MONTH_NUMBER.get(named[2]!.toLowerCase()) : Number(numeric![2]);
  if (!month) return null;
  const iso = `${m[3]}-${String(month).padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
  return isIsoDate(iso) ? iso : null;
}

/**
 * Parses “Suggestion: Due date → 20 Sep 2026 · Status → You promised” (and the applied form without the prefix).
 * Tolerant: an unknown fragment comes back as `other` with its text, so the UI never loses it.
 */
export function parseChangeSummary(summary: string | null | undefined): FieldChange[] {
  const W = SUMMARY_WORDS;
  const body = (summary ?? "")
    .trim()
    .replace(W.prefix, "")
    .replace(/\.$/, "")
    .trim();
  if (!body || W.noDetails.test(body)) return [];
  const out: FieldChange[] = [];
  for (const raw of body.split(/\s+·\s+/u)) {
    const frag = raw.trim();
    if (!frag) continue;
    const arrow = /^(.+?)\s*→\s*(.*)$/u.exec(frag);
    const key = (arrow?.[1] ?? frag).trim();
    const val = (arrow?.[2] ?? "").trim();
    if (arrow && key === W.status) {
      const s = STATUS_BY_LABEL[val];
      out.push(s ? { field: "status", value: s } : { field: "other", value: frag });
    } else if (arrow && key === W.dueDate) {
      if (val === W.none || val === "") out.push({ field: "dueDate", value: null });
      else if (summaryDateToIso(val)) out.push({ field: "dueDate", value: summaryDateToIso(val) });
      else out.push({ field: "duePhrase", value: val.replace(/^[“«"]|[”»"]$/gu, "") });
    } else if (arrow && key === W.priority) out.push({ field: "priority", value: val });
    else if (arrow && key === W.nextAction) out.push({ field: "nextAction", value: val || null });
    else if (frag === W.nextActionRemoved) out.push({ field: "nextAction", value: null });
    else if (W.summary.test(frag)) out.push({ field: "summary", value: null });
    else if (arrow && key === W.company) out.push({ field: "company", value: val === "—" ? null : val });
    else if (W.title.test(frag)) out.push({ field: "title", value: null });
    else if (W.counterparty.test(frag)) out.push({ field: "counterparty", value: null });
    else if (arrow && W.expectReplyBy.test(key)) out.push({ field: "expectReplyBy", value: val === W.none ? null : (summaryDateToIso(val) ?? val) });
    else out.push({ field: "other", value: frag });
  }
  return out;
}

/** Noun phrases, e.g. “new due date Sun 20 Sep (currently Thu 24 Sep)”. `current` adds the value it would replace. */
export function describeChanges(changes: FieldChange[], current: Pick<TaskListItem, "dueDate"> | null, today: string): string[] {
  const date = (iso: string) => formatDateShort(iso, today);
  return changes.map((c) => {
    switch (c.field) {
      case "status":
        return `status “${STATUS_LABELS[c.value as TaskStatus] ?? c.value}”`;
      case "dueDate": {
        const now = current ? ` (currently ${current.dueDate ? date(current.dueDate) : "none"})` : "";
        if (current && current.dueDate === c.value) return c.value ? `due date ${date(c.value)}` : "no due date";
        return c.value ? `new due date ${date(c.value)}${now}` : `no due date${now}`;
      }
      case "duePhrase":
        return `due date “${c.value}”`;
      case "priority": {
        const known = Object.values(PRIORITY_LABELS).includes(c.value ?? "");
        return `priority: ${known ? c.value : (c.value ?? "—")}`;
      }
      case "nextAction":
        return c.value ? `next step: “${c.value}”` : "no next step";
      case "summary":
        return "new summary";
      case "company":
        return c.value ? `company: ${c.value}` : "no company";
      case "title":
        return "new title";
      case "counterparty":
        return "a different contact";
      case "expectReplyBy":
        return c.value ? `reply by ${isIsoDate(c.value) ? date(c.value) : c.value}` : "no reply date";
      case "other":
        return c.value ?? "";
    }
  });
}

function joinAnd(parts: string[]): string {
  return parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function alreadyClosed(): TriageCopy {
  return { tone: "ask", lead: null, question: "It's already closed.", answers: [answer("OK", REJECT, { primary: true, done: "Noted" })] };
}

/** Reason labels for a field the user's own edit locked start with this (src/engine/reconcile-reasons.ts reasonLabel). */
const LOCKED_FIELD_REASON = "You changed";

function suggestionCopy(s: TaskEventView, input: TriageInput): TriageCopy {
  const { task, today } = input;
  const open = isOpen(task.status);
  const colleague = s.author?.isInternal && !s.author.isOwner;
  switch (s.op) {
    case "COMPLETE":
      if (!open) return alreadyClosed();
      if (task.status === "WAITING_FOR_OTHER") {
        return {
          tone: "ask",
          lead: null,
          question: "Looks like they replied. Close it?",
          answers: [answer("Yes, close it", ACCEPT, { primary: true, done: "Closed" }), answer("No, still waiting", REJECT, { done: "Stays open" })],
        };
      }
      return {
        tone: "ask",
        lead: null,
        question: colleague ? "Looks like a colleague did it. Close it?" : "Looks like it's done. Close it?",
        answers: [answer("Yes, it's done", ACCEPT, { primary: true, done: "Closed" }), answer("No, keep it open", REJECT, { done: "Stays open" })],
      };
    case "REOPEN":
      if (open) return { tone: "ask", lead: null, question: "It's already been reopened.", answers: [answer("OK", REJECT, { primary: true, done: "Noted" })] };
      return {
        tone: "ask",
        lead: null,
        question: "Looks like it wasn't done after all. Reopen it?",
        answers: [answer("Yes, reopen it", ACCEPT, { primary: true, done: "Reopened" }), answer("No, keep it closed", REJECT, { done: "Stays closed" })],
      };
    case "SUGGEST_DISMISS":
      if (!open) return alreadyClosed();
      return {
        tone: "ask",
        lead: null,
        question: "Looks like it no longer applies. Remove it?",
        answers: [answer("Yes, remove it", ACCEPT, { primary: true, done: "Removed" }), answer("No, it still applies", REJECT, { done: "Kept" })],
      };
    default: {
      const changes = parseChangeSummary(s.summary);
      const status = changes.find((c) => c.field === "status");
      if (!open && !status) return alreadyClosed();
      const answers = [answer("Yes, change it", ACCEPT, { primary: true, done: "Changed" }), answer("No, leave it as it is", REJECT, { done: "Left as it was" })];
      // The field was locked by the user's own edit: that is why the AI asks instead of changing it.
      const locked = (s.reasons ?? []).some((r) => r.startsWith(LOCKED_FIELD_REASON));
      const why = locked ? " You had changed it yourself, so the AI is asking." : "";
      if (changes.length === 1 && status) {
        const word = STATUS_LABELS[status.value as TaskStatus];
        return { tone: "ask", lead: why.trim() || null, question: open ? `Move it to “${word}”?` : `Reopen it as “${word}”?`, answers };
      }
      if (changes.length === 0) return { tone: "ask", lead: why.trim() || null, question: "The AI suggests a change. Make it?", answers };
      return {
        tone: "ask",
        lead: `The AI suggests: ${joinAnd(describeChanges(changes, task, today))}.${why}`,
        question: changes.length === 1 ? "Make this change?" : "Make these changes?",
        answers,
      };
    }
  }
}

export function triageCopy(input: TriageInput): TriageCopy {
  if (input.kind === "suggestion" && input.suggestion) return suggestionCopy(input.suggestion, input);
  return reviewCopy(input);
}

/**
 * The last change the AI applied while flagging the task for review (not its creation): what “The AI changed” names.
 */
export function latestReviewedChange(events: readonly TaskEventView[]): string | null {
  const e = [...events]
    .filter((x) => x.actor === "ai" && x.applied && x.tier === "review" && x.op !== "CREATE" && x.summary)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  return e?.summary ?? null;
}

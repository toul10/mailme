import { DateTime } from "luxon";
import type { TaskStatus } from "../domain/types.js";
import { EN_MONTHS_SHORT } from "../lib/dates.js";

/** English labels for the API's human-readable summaries and the one-click pages. */

export const STATUS_LABELS: Record<TaskStatus, string> = {
  ACTION_REQUIRED: "Asked of you",
  WAITING_FOR_ME: "You promised",
  WAITING_FOR_OTHER: "Waiting on others",
  COMPLETED: "Done",
  DISMISSED: "Removed",
};

const PRIORITY_LABELS: Record<string, string> = { URGENT: "Urgent", HIGH: "High", NORMAL: "Normal", LOW: "Low" };

/** "2026-09-12" → "12 Sep 2026" (unchanged if not an ISO date). Own month names, so the output never depends on ICU. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = DateTime.fromISO(iso.slice(0, 10));
  return d.isValid ? `${d.day} ${EN_MONTHS_SHORT[d.month - 1]} ${d.year}` : iso;
}

function statusLabel(v: unknown): string {
  return typeof v === "string" && v in STATUS_LABELS ? STATUS_LABELS[v as TaskStatus] : String(v ?? "—");
}

function pick(obj: Record<string, unknown> | null | undefined, ...keys: string[]): { found: boolean; value: unknown } {
  if (!obj) return { found: false, value: undefined };
  for (const k of keys) if (k in obj) return { found: true, value: obj[k] };
  return { found: false, value: undefined };
}

/** Changed fields of an event's `after` snapshot, as "Field → value" fragments. */
function describeChanges(after: Record<string, unknown> | null | undefined): string[] {
  const out: string[] = [];
  const status = pick(after, "status");
  if (status.found) out.push(`Status → ${statusLabel(status.value)}`);
  const due = pick(after, "dueDate", "due_date");
  if (due.found) out.push(`Due date → ${due.value ? formatDate(String(due.value)) : "none"}`);
  const phrase = pick(after, "duePhrase", "due_phrase");
  if (phrase.found && !due.found && phrase.value) out.push(`Due date → “${String(phrase.value)}”`);
  const prio = pick(after, "priority");
  if (prio.found) out.push(`Priority → ${PRIORITY_LABELS[String(prio.value)] ?? String(prio.value)}`);
  const next = pick(after, "nextAction", "next_action");
  if (next.found) out.push(next.value ? `Next step → ${String(next.value)}` : "Next step removed");
  if (pick(after, "summary").found) out.push("Summary updated");
  const company = pick(after, "company");
  if (company.found) out.push(`Company → ${company.value ? String(company.value) : "—"}`);
  if (pick(after, "title").found) out.push("Title updated");
  if (pick(after, "counterpartyAddress", "counterpartyName", "counterparty").found) out.push("Contact updated");
  const expect = pick(after, "expectReplyBy", "expect_reply_by");
  if (expect.found) out.push(`Reply expected by → ${expect.value ? formatDate(String(expect.value)) : "none"}`);
  return out;
}

export interface EventLike {
  op: string;
  actor: string;
  applied: boolean;
  suggestionState: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  payload: unknown;
}

/** Human-readable summary of a task event, e.g. "Status → Done". */
export function eventSummary(e: EventLike): string {
  const suggestion = e.suggestionState !== null && !e.applied;
  const changes = describeChanges(e.after);
  const joined = changes.join(" · ");
  switch (e.op) {
    case "CREATE":
      return suggestion ? "Suggestion: new task" : e.applied ? "Created from email" : "Possible task (logged only)";
    case "UPDATE":
      if (suggestion) return joined ? `Suggestion: ${joined}` : "Suggested change";
      return joined || "Updated from email";
    case "COMPLETE":
      return suggestion ? "Done already?" : e.applied ? "Status → Done (automatically)" : "Possibly done (logged only)";
    case "REOPEN":
      return suggestion ? "Suggestion: reopen" : "Reopened from email";
    case "SUGGEST_DISMISS":
      return "Suggestion: no longer a task";
    case "USER_CREATE":
      return "Added by you";
    case "USER_EDIT":
      return joined ? `Edited: ${joined}` : "Edited";
    case "USER_COMPLETE":
      return "Status → Done";
    case "USER_DISMISS":
      return "Status → Removed";
    case "USER_NOT_A_TASK":
      return "Not a task";
    case "USER_HANDLED_BY_OTHER":
      return "Someone else has it";
    case "USER_REOPEN":
      return "Reopened";
    case "USER_SNOOZE": {
      const mode = pick(e.after, "snoozeMode", "snooze_mode").value ?? pick(asRecord(e.payload), "mode").value;
      const until = pick(e.after, "snoozedUntil", "snoozed_until").value ?? pick(asRecord(e.payload), "until").value;
      if (mode === "until_reply") return "Snoozed until they reply";
      return until ? `Snoozed until ${formatDate(String(until))}` : "Snoozed";
    }
    case "USER_UNSNOOZE":
      return "Snooze ended";
    case "USER_MERGE":
      return "Tasks merged";
    case "USER_CONFIRM":
      return "Confirmed";
    case "USER_STILL_VALID":
      return "Still valid";
    case "USER_MISSED":
    case "USER_WOULD_HAVE_MISSED":
      return "“I'd have missed this”";
    case "USER_ACCEPT_SUGGESTION":
      return joined ? `Accepted suggestion: ${joined}` : "Accepted suggestion";
    case "USER_REJECT_SUGGESTION":
      return "Rejected suggestion";
    case "SYSTEM_UNSNOOZE":
      return "Back from snooze";
    case "SYSTEM_DORMANT":
      return "Dormant (no activity)";
    case "SYSTEM_BOUNCE":
      return "⚠️ Not delivered";
    case "SYSTEM_STILL_VALID_ASKED":
      return "Asked “Still valid?”";
    case "SYSTEM_RULE_DISMISS": {
      const rule = pick(asRecord(e.payload), "rule").value;
      return rule ? `Removed by the rule “${String(rule)}”` : "Removed by a rule";
    }
    case "SYSTEM_ANSWERED": {
      const by = pick(asRecord(e.payload), "name").value ?? pick(asRecord(e.payload), "by").value;
      return by ? `Answered by ${String(by)}` : "Answered";
    }
    default:
      return joined || e.op;
  }
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

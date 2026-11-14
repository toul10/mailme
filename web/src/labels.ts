/**
 * English labels for every enum the UI shows. Typed as exhaustive records against the contract types,
 * so a new status/priority/role fails the typecheck instead of rendering a raw code.
 * Register: the user is “you” everywhere; the model is “the AI”; a dismissed task is “removed”.
 */
import type { OpenStatus, Priority, TaskStatus } from "../../src/domain/types.js";
import type { FolderSummary, MailboxSummary, TaskEventView, TaskListItem, TaskTab } from "../../src/server/api-types.js";

/**
 * Status in the user's words (“Asked of you / You promised / Waiting on others”): the one set of names
 * for rows, the task page, the edit form and the new-task form. DISMISSED reads as the action that caused it.
 */
export const STATUS_LABELS: Record<TaskStatus, string> = {
  ACTION_REQUIRED: "Asked of you",
  WAITING_FOR_ME: "You promised",
  WAITING_FOR_OTHER: "Waiting on others",
  COMPLETED: "Done",
  DISMISSED: "Removed",
};

const OPEN_STATUS_LABELS: Record<OpenStatus, string> = {
  ACTION_REQUIRED: STATUS_LABELS.ACTION_REQUIRED,
  WAITING_FOR_ME: STATUS_LABELS.WAITING_FOR_ME,
  WAITING_FOR_OTHER: STATUS_LABELS.WAITING_FOR_OTHER,
};

/** Open statuses in display order (the only ones a user may set by editing). */
export const OPEN_STATUS_ORDER = Object.keys(OPEN_STATUS_LABELS) as OpenStatus[];

export function isOpen(status: TaskStatus): status is OpenStatus {
  return (OPEN_STATUS_ORDER as readonly string[]).includes(status);
}

export const PRIORITY_LABELS: Record<Priority, string> = {
  URGENT: "Urgent",
  HIGH: "High",
  NORMAL: "Normal",
  LOW: "Low",
};

export const PRIORITY_ORDER = Object.keys(PRIORITY_LABELS) as Priority[];

/**
 * “All” list filters: the API tabs plus “Snoozed”, a web-only view of the open list (the API has no snoozed tab; see
 * list-model.ts). The “todo” tab includes promises, so it is not called “To do” (on “Today” that is only what
 * someone asked of you).
 */
export type ListFilter = TaskTab | "snoozed";

export const TAB_LABELS: Record<ListFilter, string> = {
  all: "Open",
  waiting: "Waiting",
  others: "Colleagues",
  closed: "Closed",
  earlier: "Earlier",
  todo: "To do or promised",
  review: "Needs a look",
  snoozed: "Snoozed",
};

/** Every filter a URL may name. */
export const TAB_ORDER = Object.keys(TAB_LABELS) as ListFilter[];

/** The filter bar's five segments (Open · Waiting · Colleagues · Closed · Earlier). Others show only while active. */
export const FILTER_BAR: readonly ListFilter[] = ["all", "waiting", "others", "closed", "earlier"];

/** An API tab (never the web-only “snoozed”). */
export function isTaskTab(value: string | null | undefined): value is TaskTab {
  return value != null && value !== "snoozed" && (TAB_ORDER as readonly string[]).includes(value);
}

export function isListFilter(value: string | null | undefined): value is ListFilter {
  return value != null && (TAB_ORDER as readonly string[]).includes(value);
}

export const OWNER_KIND_LABELS: Record<TaskListItem["ownerKind"], string> = {
  ME: "You",
  INTERNAL: "Colleague",
  EXTERNAL: "External",
  UNKNOWN: "Unknown",
};

export const ORIGIN_LABELS: Record<TaskListItem["origin"], string> = {
  ai: "From email (AI)",
  manual: "Added by you",
  backfill: "From older email",
};

export const ACTOR_LABELS: Record<TaskEventView["actor"], string> = {
  ai: "AI",
  user: "You",
  system: "System",
};

export const TIER_LABELS: Record<NonNullable<TaskEventView["tier"]>, string> = {
  auto: "automatically",
  review: "to check",
  logged: "logged only",
};

export const SUGGESTION_STATE_LABELS: Record<NonNullable<TaskEventView["suggestionState"]>, string> = {
  pending: "Waiting for your answer",
  accepted: "You said yes",
  rejected: "You said no",
  expired: "Expired",
};

/** Evidence sources (ai/schema.ts). Unknown values fall back to the raw code. */
const EVIDENCE_SOURCE_LABELS: Record<string, string> = {
  NEW: "New text",
  QUOTED: "Quoted",
  FORWARDED: "Forwarded",
  SUBJECT: "Subject",
  ATTACHMENT_NAME: "Attachment name",
};

export function evidenceSourceLabel(source: string | null): string | null {
  if (!source) return null;
  return EVIDENCE_SOURCE_LABELS[source] ?? source;
}

/** task_links.role values. */
const LINK_ROLE_LABELS: Record<string, string> = {
  origin: "Start",
  update: "Update",
  completion: "Completion",
  reopen: "Reopened",
  reference: "Related",
  manual: "Linked by you",
};

export function linkRoleLabel(role: string): string {
  return LINK_ROLE_LABELS[role] ?? role;
}

/** Event ops (domain EVENT_OPS). Unknown ops fall back to the raw code. */
const EVENT_OP_LABELS: Record<string, string> = {
  CREATE: "Created",
  UPDATE: "Updated",
  COMPLETE: "Completed",
  REOPEN: "Reopened",
  SUGGEST_DISMISS: "Suggested removal",
  USER_CREATE: "Created",
  USER_EDIT: "Edited",
  USER_COMPLETE: "Done",
  USER_DISMISS: "Removed",
  USER_REOPEN: "Not done — reopened",
  USER_SNOOZE: "Snoozed",
  USER_UNSNOOZE: "Snooze cancelled",
  USER_MERGE: "Merged",
  USER_HANDLED_BY_OTHER: "Someone else has it",
  USER_CONFIRM: "Confirmed",
  USER_NOT_A_TASK: "Removed: not a task",
  USER_STILL_VALID: "Still valid",
  USER_MISSED: "Missed",
  USER_WOULD_HAVE_MISSED: "I'd have missed this",
  USER_ACCEPT_SUGGESTION: "Yes to the AI's question",
  USER_REJECT_SUGGESTION: "No to the AI's question",
  SYSTEM_UNSNOOZE: "Back from snooze",
  SYSTEM_DORMANT: "Dormant",
  SYSTEM_BOUNCE: "Not delivered",
  SYSTEM_STILL_VALID_ASKED: "Asked “Still valid?”",
  SYSTEM_ANSWERED: "Answered (rule)",
  SYSTEM_RULE_DISMISS: "Removed by a rule",
};

export function eventOpLabel(op: string): string {
  return EVENT_OP_LABELS[op] ?? op;
}

/** Fields that a user edit locks (domain LOCKABLE_FIELDS). Same names as the task page's facts and form. */
export const LOCKABLE_FIELD_LABELS: Record<string, string> = {
  status: "Status",
  dueDate: "Due date",
  priority: "Priority",
  nextAction: "Next step",
  summary: "Summary",
  company: "Company",
  owner: "Owner",
};

export const MAILBOX_STATUS_LABELS: Record<MailboxSummary["status"], string> = {
  setup: "Setting up",
  active: "Active",
  auth_failed: "Sign-in failed",
  blocked: "Blocked",
  paused: "Paused",
  disabled: "Disabled",
};

export const FOLDER_ROLE_LABELS: Record<FolderSummary["role"], string> = {
  inbox: "Inbox",
  sent: "Sent",
  archive: "Archive",
  junk: "Junk",
  trash: "Trash",
  drafts: "Drafts",
  other: "Other",
};

export const FOLDER_ROLE_ORDER = Object.keys(FOLDER_ROLE_LABELS) as Array<FolderSummary["role"]>;

export const ROLE_SOURCE_LABELS: Record<FolderSummary["roleSource"], string> = {
  special_use: "from the server",
  name: "from the name",
  user: "set by you",
};

/** errorKind values from the IMAP probe (mail/imap/errors.ts). */
const PROBE_ERROR_LABELS: Record<string, string> = {
  auth: "Wrong username or password",
  too_many: "Too many connections to the server — try again later",
  network: "No connection to the server",
  tls: "Certificate problem (TLS)",
  timeout: "The server didn't answer in time",
  rate_limited: "Too many sign-in attempts in a short time — wait a little before you try again",
};

export function probeErrorLabel(kind: string | null): string | null {
  if (!kind) return null;
  return PROBE_ERROR_LABELS[kind] ?? kind;
}

export const DELIVERY_LABELS: Record<"append" | "smtp", string> = {
  append: "Into your Inbox (IMAP APPEND)",
  smtp: "By email (SMTP)",
};

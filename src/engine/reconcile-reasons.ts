/**
 * Reason codes emitted by the reconciler (Plan.reasons, PlannedOp.reasons → task_events.reasons, tasks.review_reasons).
 * Codes are stable identifiers (never quotes or personal data); {@link reasonLabel} gives the UI text.
 * Parameterised codes use "code:param", e.g. "locked_field:dueDate".
 */
export const R = {
  // message level
  MESSAGE_REVIEW: "message_review",
  OP_CAP_EXCEEDED: "op_cap_exceeded",
  INBOUND_MULTIPLE_COMPLETE: "inbound_multiple_complete",
  INBOUND_TOO_MANY_OPS: "inbound_too_many_ops",
  SUSPICIOUS_INSTRUCTIONS: "suspicious_instructions",
  CLASS_MISMATCH: "class_mismatch",
  CLAIMS_OWNER_SENDER: "claims_owner_sender",
  INVALID_OPS: "invalid_ops",

  // validation (→ Plan.valid = false)
  INVALID_TASK_HANDLE: "invalid_task_handle",
  INVALID_EMPTY_TITLE: "invalid_empty_title",
  INVALID_EMPTY_UPDATE: "invalid_empty_update",
  CONFIDENCE_OUT_OF_RANGE: "confidence_out_of_range",
  UNKNOWN_PARTICIPANT: "unknown_participant",

  // dropped / no-op (logged)
  OVER_OP_CAP: "over_op_cap",
  DUPLICATE_CREATE: "duplicate_create",
  DUPLICATE_TASK_OP: "duplicate_task_op",
  NO_CHANGE: "no_change",
  ALREADY_CLOSED: "already_closed",
  NOT_CLOSED: "not_closed",

  // sanitising (informational)
  TITLE_TRUNCATED: "title_truncated",
  SUMMARY_TRUNCATED: "summary_truncated",
  NEXT_ACTION_TRUNCATED: "next_action_truncated",
  QUOTE_TRUNCATED: "quote_truncated",
  ITEMS_TRUNCATED: "items_truncated",
  ITEM_TRUNCATED: "item_truncated",
  COMPANY_TRUNCATED: "company_truncated",
  STATUS_UNCHANGED: "status_unchanged",

  // grounding
  EVIDENCE_MISSING: "evidence_missing",
  EVIDENCE_FUZZY: "evidence_fuzzy",
  EVIDENCE_WRONG_SOURCE: "evidence_wrong_source",
  EVIDENCE_QUOTED: "evidence_quoted",
  EVIDENCE_SUBJECT: "evidence_subject",
  EVIDENCE_NOT_NEW: "evidence_not_new",

  // certainty / confidence / addressee
  SPECULATIVE: "speculative",
  IMPLIED: "implied",
  LOW_CONFIDENCE: "low_confidence",
  OWNER_CC: "owner_cc",
  /** The user's "What matters to me": tasks from mail where they are only in Cc are not created. */
  OWNER_CC_IGNORED: "owner_cc_ignored",
  ADDRESSEE_OTHER: "addressee_other",

  // dates
  DUE_DISAGREES: "due_disagrees",
  DUE_UNRESOLVED: "due_unresolved",
  EXPECT_REPLY_DISAGREES: "expect_reply_disagrees",
  EXPECT_REPLY_UNRESOLVED: "expect_reply_unresolved",

  // thread / ordering
  LOW_LINK_CONFIDENCE: "low_link_confidence",
  LATE_MESSAGE: "late_message",
  CROSS_THREAD: "cross_thread",
  TASK_CLOSED: "task_closed",
  TASK_MERGED: "task_merged",

  // authority / human decisions
  INBOUND_STATUS_CHANGE: "inbound_status_change",
  INBOUND_COMMITMENT: "inbound_commitment",
  INBOUND_CHANGES_COMMITMENT: "inbound_changes_commitment",
  INBOUND_CANNOT_COMPLETE: "inbound_cannot_complete",
  OWNER_REPLIED_AFTER_CREATE: "owner_replied_after_create",
  INBOUND_REOPEN: "inbound_reopen",
  USER_CLOSED: "user_closed",
  NOT_AI_CLOSED: "not_ai_closed",
  LOCKED_FIELD: "locked_field",
  SUGGEST_DISMISS: "suggest_dismiss",
  NEGATIVE_EXAMPLE: "negative_example",
  NEGATIVE_EXAMPLE_PARTIAL: "negative_example_partial",
  COUNTERPARTY_DISMISSED: "counterparty_dismissed",

  // delivery
  BOUNCE: "bounce",
} as const;
export type ReasonCode = (typeof R)[keyof typeof R];

/** "locked_field:dueDate" etc. */
export const lockedFieldReason = (field: string): string => `${R.LOCKED_FIELD}:${field}`;

const FIELD_LABELS: Record<string, string> = {
  status: "Status",
  dueDate: "Due date",
  priority: "Priority",
  nextAction: "Next step",
  summary: "Summary",
  company: "Company",
  owner: "Owner",
};

export const REASON_LABELS: Record<ReasonCode, string> = {
  message_review: "The whole message needs a look",
  op_cap_exceeded: "Too many actions in one message",
  inbound_multiple_complete: "An incoming message would close several tasks",
  inbound_too_many_ops: "An incoming message with more than 3 actions",
  suspicious_instructions: "The message contains instructions for the system",
  class_mismatch: "An informational or automated message with actions",
  claims_owner_sender: "It looks like you sent it, but that can't be confirmed",
  invalid_ops: "Invalid actions from the AI",
  invalid_task_handle: "Unknown task",
  invalid_empty_title: "Empty title",
  invalid_empty_update: "An update with no changes",
  confidence_out_of_range: "Invalid confidence",
  unknown_participant: "Unknown participant",
  over_op_cap: "Over the action limit — logged only",
  duplicate_create: "Created twice in the same message",
  duplicate_task_op: "Two actions on the same task",
  no_change: "No change",
  already_closed: "Already closed",
  not_closed: "Not closed",
  title_truncated: "The title was shortened",
  summary_truncated: "The summary was shortened",
  next_action_truncated: "The next step was shortened",
  quote_truncated: "The quote was shortened",
  items_truncated: "The list of items was shortened",
  item_truncated: "An item was shortened",
  company_truncated: "The company name was shortened",
  status_unchanged: "Same status",
  evidence_missing: "The quote wasn't found in the message",
  evidence_fuzzy: "The quote only roughly matches the message",
  evidence_wrong_source: "The quote was found elsewhere in the message",
  evidence_quoted: "The quote is from an older message",
  evidence_subject: "Evidence from the subject only",
  evidence_not_new: "Evidence from outside the new text",
  speculative: "A guess",
  implied: "Only implied",
  low_confidence: "Low confidence",
  owner_cc: "You're only in Cc",
  owner_cc_ignored: "Only in Cc: you chose to ignore these (What matters to me)",
  addressee_other: "Addressed to someone else",
  due_disagrees: "Uncertain due date",
  due_unresolved: "The due date couldn't be worked out",
  expect_reply_disagrees: "Uncertain reply date",
  expect_reply_unresolved: "The reply date couldn't be worked out",
  low_link_confidence: "Uncertain link to the conversation",
  late_message: "Late message",
  cross_thread: "Task from another conversation",
  task_closed: "The task is closed",
  task_merged: "The task was merged",
  inbound_status_change: "Status change from an incoming message",
  inbound_commitment: "A promise on your behalf from an incoming message",
  inbound_changes_commitment: "Change to your own due date from an incoming message",
  inbound_cannot_complete: "Done already?",
  owner_replied_after_create: "You've replied in the conversation",
  inbound_reopen: "Reopen from an incoming message",
  user_closed: "You closed it",
  not_ai_closed: "The AI didn't close it",
  locked_field: "You changed this field yourself",
  suggest_dismiss: "Suggestion: no longer a task",
  negative_example: "You marked this “Not a task”",
  negative_example_partial: "Looks like something you marked “Not a task”",
  counterparty_dismissed: "You've removed a task in this conversation",
  bounce: "⚠️ Email not delivered",
};

/**
 * UI label for a reason code (falls back to the code itself). Both locked-field labels start with "You changed":
 * web/src/triage.ts tests that prefix.
 */
export function reasonLabel(code: string): string {
  const [base, param] = code.split(":", 2) as [string, string | undefined];
  if (base === R.LOCKED_FIELD && param) return `You changed “${FIELD_LABELS[param] ?? param}” yourself`;
  return (REASON_LABELS as Record<string, string>)[base] ?? code;
}

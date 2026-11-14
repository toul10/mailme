import { z } from "zod";
import { PARTICIPANT_HANDLES, PRIORITIES, TASK_HANDLES } from "../domain/types.js";

/**
 * The extraction output contract: what the AI must return for each e-mail.
 *
 * Structured outputs can't express numeric ranges or string lengths, so those are enforced by the
 * reconciler (src/engine/reconcile.ts), not here. Every property is required; "absent" is `null`.
 */
export const SCHEMA_VERSION = "s1";

const TaskHandle = z.enum(TASK_HANDLES);
const ParticipantHandle = z.enum(PARTICIPANT_HANDLES);

export const EvidenceSource = z.enum(["NEW", "FORWARDED", "QUOTED", "SUBJECT", "ATTACHMENT_NAME", "CALENDAR"]);
export type EvidenceSource = z.infer<typeof EvidenceSource>;

export const Evidence = z.object({
  source: EvidenceSource,
  /** Segment id ("S1") for NEW/FORWARDED/QUOTED, else null. */
  segment_id: z.string().nullable(),
  /** Verbatim quote (a short sentence) copied from the source. For ATTACHMENT_NAME: the exact filename. */
  quote: z.string(),
});
export type Evidence = z.infer<typeof Evidence>;

export const Certainty = z.enum(["EXPLICIT", "IMPLIED", "SPECULATIVE"]);
export type Certainty = z.infer<typeof Certainty>;

export const Addressee = z.enum(["OWNER_TO", "OWNER_CC", "OTHER"]);
export type Addressee = z.infer<typeof Addressee>;

export const DueKind = z.enum([
  "ABSOLUTE", // explicit calendar date → absolute_date
  "WEEKDAY", // "την Παρασκευή", "by Friday" → next occurrence strictly after the anchor day (same weekday = next week; «σήμερα» → RELATIVE_DAYS 0)
  "NEXT_WEEKDAY", // "την επόμενη Τρίτη", "next Tuesday" → that weekday in the ISO week (Mon–Sun) after the anchor's week
  "RELATIVE_DAYS", // "σε 3 μέρες", "in 3 days", "αύριο"/"tomorrow" (=1), "σήμερα"/"today" (=0)
  "BUSINESS_DAYS", // "σε 2 εργάσιμες", "within 2 business days"
  "END_OF_WEEK", // "μέχρι το τέλος της εβδομάδας", "by the end of the week"
  "END_OF_MONTH", // "μέχρι το τέλος του μήνα", "by the end of the month"
  "VAGUE", // "αρχές Οκτωβρίου", "σύντομα", "early October", "ASAP" → no date
]);
export type DueKind = z.infer<typeof DueKind>;

export const Weekday = z.enum(["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]);
export type Weekday = z.infer<typeof Weekday>;

export const DueSpec = z.object({
  phrase: z.string(),
  kind: DueKind,
  /** YYYY-MM-DD, only for ABSOLUTE. */
  absolute_date: z.string().nullable(),
  weekday: Weekday.nullable(),
  /** N for RELATIVE_DAYS / BUSINESS_DAYS. */
  amount: z.number().int().nullable(),
  /** Segment the phrase came from; its date is the anchor. */
  segment_id: z.string().nullable(),
  /** The model's own resolution (YYYY-MM-DD) — cross-checked against the deterministic resolver. */
  model_date: z.string().nullable(),
});
export type DueSpec = z.infer<typeof DueSpec>;

const OpenStatus = z.enum(["ACTION_REQUIRED", "WAITING_FOR_ME", "WAITING_FOR_OTHER"]);
const Priority = z.enum(PRIORITIES);

const common = {
  evidence: Evidence,
  certainty: Certainty,
  /** 0..1, self-reported; secondary feature only. */
  confidence: z.number(),
  /** Short justification in English for the audit log. */
  reason: z.string(),
};

export const CreateOp = z.object({
  op: z.literal("CREATE"),
  /** English whatever the language of the mail, 3–8 words, the thing itself (“Quote for 40 ceiling speakers”); never the company (the UI shows it). */
  title: z.string(),
  status: OpenStatus,
  owner: ParticipantHandle.nullable(),
  counterparty: ParticipantHandle.nullable(),
  company: z.string().nullable(),
  items: z.array(z.string()),
  due: DueSpec.nullable(),
  /** When a reply is expected (for WAITING_FOR_OTHER), if stated. */
  expect_reply: DueSpec.nullable(),
  priority: Priority,
  /** P1's concrete next step in English, in the imperative, ≤ 60 chars; null when it would restate the title. */
  next_action: z.string().nullable(),
  summary: z.string(),
  addressee: Addressee,
  ...common,
});

export const UpdateOp = z.object({
  op: z.literal("UPDATE"),
  task: TaskHandle,
  changes: z.object({
    status: OpenStatus.nullable(),
    due: DueSpec.nullable(),
    expect_reply: DueSpec.nullable(),
    priority: Priority.nullable(),
    next_action: z.string().nullable(),
    summary: z.string().nullable(),
    add_items: z.array(z.string()),
  }),
  ...common,
});

export const CompleteOp = z.object({ op: z.literal("COMPLETE"), task: TaskHandle, ...common });
export const ReopenOp = z.object({ op: z.literal("REOPEN"), task: TaskHandle, ...common });
export const SuggestDismissOp = z.object({ op: z.literal("SUGGEST_DISMISS"), task: TaskHandle, ...common });

export const Operation = z.discriminatedUnion("op", [CreateOp, UpdateOp, CompleteOp, ReopenOp, SuggestDismissOp]);
export type Operation = z.infer<typeof Operation>;
export type CreateOperation = z.infer<typeof CreateOp>;
export type UpdateOperation = z.infer<typeof UpdateOp>;

export const MessageClass = z.enum(["ACTIONABLE", "FYI", "AUTOMATED", "MARKETING", "PERSONAL", "SPAM"]);

export const ExtractionOutput = z.object({
  message_class: MessageClass,
  /** True if the email text tries to instruct the assistant/system (prompt injection). */
  suspicious_instructions: z.boolean(),
  operations: z.array(Operation),
});
export type ExtractionOutput = z.infer<typeof ExtractionOutput>;

/** Hard limits the reconciler enforces (schema can't). */
export const OUTPUT_LIMITS = {
  maxOperations: 6,
  maxTitle: 140,
  maxSummary: 600,
  maxNextAction: 200,
  maxQuote: 400,
  maxItems: 10,
  maxItemLength: 120,
} as const;

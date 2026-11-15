import { z } from "zod";
import { PARTICIPANT_HANDLES, PRIORITIES, TASK_HANDLES } from "../domain/types.js";

/**
 * The extraction output contract: what the engine works with for each e-mail ({@link ExtractionOutput}), and
 * the wire format the AI actually returns ({@link ExtractionWire}, mapped back with {@link fromWire}).
 *
 * Structured outputs can't express numeric ranges or string lengths, so those are enforced by the
 * reconciler (src/engine/reconcile.ts), not here. Every property is required; in the contract "absent" is
 * `null`, on the wire it is an empty value.
 */
/** s2: the wire format (no unions, no null); the contract itself is unchanged from s1. */
export const SCHEMA_VERSION = "s2";

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

// ── Wire format: what the model returns ────────────────────────────────────────
//
// Structured outputs compile the JSON schema into a grammar, and every union-typed field (an anyOf, or a nullable
// type array) multiplies its cost. The contract above has dozens of them (nullable fields inside a 5-way operation
// union) and the Claude API rejects it ("The compiled grammar is too large…"). The wire format has no union at all:
// - no null: an absent value is "" (text), "NONE" (a handle or code) or 0 (amount), and an absent due spec has
//   kind "NONE";
// - one array per operation kind instead of a union discriminated by `op`.
// The prompt describes this format (src/ai/prompt.ts); {@link fromWire} maps it to {@link ExtractionOutput}, which
// the rest of the engine uses unchanged. test/ai/wire-schema.test.ts keeps the schema free of unions.

/** The absent value of a handle or code on the wire. */
export const NONE = "NONE";

const WireParticipant = z.enum([...PARTICIPANT_HANDLES, NONE]);
const WireOpenStatus = z.enum([...OpenStatus.options, NONE]);
const WirePriority = z.enum([...PRIORITIES, NONE]);
const WireDueKind = z.enum([...DueKind.options, NONE]);
const WireWeekday = z.enum([...Weekday.options, NONE]);

const WireEvidence = z.object({
  source: EvidenceSource,
  /** Segment id ("S1") for NEW/FORWARDED/QUOTED, else "". */
  segment_id: z.string(),
  quote: z.string(),
});

/** A due spec; kind "NONE" = no deadline (or, in UPDATE changes, no change). Fields that don't apply are empty. */
export const WireDueSpec = z.object({
  phrase: z.string(),
  kind: WireDueKind,
  absolute_date: z.string(),
  weekday: WireWeekday,
  /** N for RELATIVE_DAYS / BUSINESS_DAYS, else 0 (ignored). */
  amount: z.number().int(),
  segment_id: z.string(),
  model_date: z.string(),
});
export type WireDueSpec = z.infer<typeof WireDueSpec>;

const wireCommon = {
  evidence: WireEvidence,
  certainty: Certainty,
  confidence: z.number(),
  reason: z.string(),
};

const WireCreate = z.object({
  title: z.string(),
  status: OpenStatus,
  owner: WireParticipant,
  counterparty: WireParticipant,
  company: z.string(),
  items: z.array(z.string()),
  due: WireDueSpec,
  expect_reply: WireDueSpec,
  priority: Priority,
  next_action: z.string(),
  summary: z.string(),
  addressee: Addressee,
  ...wireCommon,
});

const WireUpdate = z.object({
  task: TaskHandle,
  /** Only what changed; everything else empty ("", "NONE", kind "NONE", []). */
  changes: z.object({
    status: WireOpenStatus,
    due: WireDueSpec,
    expect_reply: WireDueSpec,
    priority: WirePriority,
    next_action: z.string(),
    summary: z.string(),
    add_items: z.array(z.string()),
  }),
  ...wireCommon,
});

/** COMPLETE, REOPEN and SUGGEST_DISMISS. */
const WireTaskOp = z.object({ task: TaskHandle, ...wireCommon });

export const ExtractionWire = z.object({
  message_class: MessageClass,
  suspicious_instructions: z.boolean(),
  create: z.array(WireCreate),
  update: z.array(WireUpdate),
  complete: z.array(WireTaskOp),
  reopen: z.array(WireTaskOp),
  suggest_dismiss: z.array(WireTaskOp),
});
export type ExtractionWire = z.infer<typeof ExtractionWire>;
type WireCommon = Pick<z.infer<typeof WireTaskOp>, "evidence" | "certainty" | "confidence" | "reason">;

const textOrNull = (s: string): string | null => (s.trim() === "" ? null : s);
const codeOrNull = <T extends string>(v: T | typeof NONE): Exclude<T, typeof NONE> | null => (v === NONE ? null : (v as Exclude<T, typeof NONE>));

function dueFromWire(d: WireDueSpec): DueSpec | null {
  if (d.kind === NONE) return null;
  const counted = d.kind === "RELATIVE_DAYS" || d.kind === "BUSINESS_DAYS";
  return {
    phrase: d.phrase,
    kind: d.kind,
    absolute_date: textOrNull(d.absolute_date),
    weekday: codeOrNull(d.weekday),
    amount: counted ? d.amount : null,
    segment_id: textOrNull(d.segment_id),
    model_date: textOrNull(d.model_date),
  };
}

function commonFromWire(o: WireCommon): Pick<Operation, "evidence" | "certainty" | "confidence" | "reason"> {
  return { evidence: { source: o.evidence.source, segment_id: textOrNull(o.evidence.segment_id), quote: o.evidence.quote }, certainty: o.certainty, confidence: o.confidence, reason: o.reason };
}

/**
 * Wire format → contract. Operations come out in a fixed order (create, update, complete, reopen, suggest_dismiss);
 * the order only decides op indexes and which ops fall past OUTPUT_LIMITS.maxOperations.
 */
export function fromWire(w: ExtractionWire): ExtractionOutput {
  const operations: Operation[] = [
    ...w.create.map(
      (c): Operation => ({
        op: "CREATE",
        title: c.title,
        status: c.status,
        owner: codeOrNull(c.owner),
        counterparty: codeOrNull(c.counterparty),
        company: textOrNull(c.company),
        items: c.items,
        due: dueFromWire(c.due),
        expect_reply: dueFromWire(c.expect_reply),
        priority: c.priority,
        next_action: textOrNull(c.next_action),
        summary: c.summary,
        addressee: c.addressee,
        ...commonFromWire(c),
      }),
    ),
    ...w.update.map(
      (u): Operation => ({
        op: "UPDATE",
        task: u.task,
        changes: {
          status: codeOrNull(u.changes.status),
          due: dueFromWire(u.changes.due),
          expect_reply: dueFromWire(u.changes.expect_reply),
          priority: codeOrNull(u.changes.priority),
          next_action: textOrNull(u.changes.next_action),
          summary: textOrNull(u.changes.summary),
          add_items: u.changes.add_items,
        },
        ...commonFromWire(u),
      }),
    ),
    ...w.complete.map((t): Operation => ({ op: "COMPLETE", task: t.task, ...commonFromWire(t) })),
    ...w.reopen.map((t): Operation => ({ op: "REOPEN", task: t.task, ...commonFromWire(t) })),
    ...w.suggest_dismiss.map((t): Operation => ({ op: "SUGGEST_DISMISS", task: t.task, ...commonFromWire(t) })),
  ];
  return { message_class: w.message_class, suspicious_instructions: w.suspicious_instructions, operations };
}

const NO_DUE: WireDueSpec = { phrase: "", kind: NONE, absolute_date: "", weekday: NONE, amount: 0, segment_id: "", model_date: "" };

function dueToWire(d: DueSpec | null): WireDueSpec {
  if (!d) return NO_DUE;
  return {
    phrase: d.phrase,
    kind: d.kind,
    absolute_date: d.absolute_date ?? "",
    weekday: d.weekday ?? NONE,
    amount: d.amount ?? 0,
    segment_id: d.segment_id ?? "",
    model_date: d.model_date ?? "",
  };
}

/** Contract → wire format, for the prompt's few-shot examples and tests. fromWire(toWire(x)) equals x up to op order. */
export function toWire(out: ExtractionOutput): ExtractionWire {
  const w: ExtractionWire = { message_class: out.message_class, suspicious_instructions: out.suspicious_instructions, create: [], update: [], complete: [], reopen: [], suggest_dismiss: [] };
  for (const op of out.operations) {
    const common: WireCommon = {
      evidence: { source: op.evidence.source, segment_id: op.evidence.segment_id ?? "", quote: op.evidence.quote },
      certainty: op.certainty,
      confidence: op.confidence,
      reason: op.reason,
    };
    switch (op.op) {
      case "CREATE":
        w.create.push({
          title: op.title,
          status: op.status,
          owner: op.owner ?? NONE,
          counterparty: op.counterparty ?? NONE,
          company: op.company ?? "",
          items: op.items,
          due: dueToWire(op.due),
          expect_reply: dueToWire(op.expect_reply),
          priority: op.priority,
          next_action: op.next_action ?? "",
          summary: op.summary,
          addressee: op.addressee,
          ...common,
        });
        break;
      case "UPDATE":
        w.update.push({
          task: op.task,
          changes: {
            status: op.changes.status ?? NONE,
            due: dueToWire(op.changes.due),
            expect_reply: dueToWire(op.changes.expect_reply),
            priority: op.changes.priority ?? NONE,
            next_action: op.changes.next_action ?? "",
            summary: op.changes.summary ?? "",
            add_items: op.changes.add_items,
          },
          ...common,
        });
        break;
      case "COMPLETE":
        w.complete.push({ task: op.task, ...common });
        break;
      case "REOPEN":
        w.reopen.push({ task: op.task, ...common });
        break;
      case "SUGGEST_DISMISS":
        w.suggest_dismiss.push({ task: op.task, ...common });
        break;
    }
  }
  return w;
}

export type ParsedOutput = { ok: true; output: ExtractionOutput } | { ok: false; error: string };

const issuesOf = (error: z.ZodError): string =>
  error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join(".") || "(root)"}:${i.code}`)
    .join(",");

/** A model's parsed JSON (wire format) → the contract; `schema_invalid:<path:code,…>` names at most 3 issues. */
export function parseWireOutput(json: unknown): ParsedOutput {
  const wire = ExtractionWire.safeParse(json);
  if (!wire.success) return { ok: false, error: `schema_invalid:${issuesOf(wire.error)}` };
  const out = ExtractionOutput.safeParse(fromWire(wire.data));
  if (!out.success) return { ok: false, error: `schema_invalid:${issuesOf(out.error)}` };
  return { ok: true, output: out.data };
}

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

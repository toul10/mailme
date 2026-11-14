import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { MESSAGE_CLASSES, PARTICIPANT_HANDLES, TASK_HANDLES, TASK_STATUSES } from "../../src/domain/types.js";
import type { ExtractionInput } from "../../src/domain/types.js";

/**
 * Synthetic eval cases (eval/cases/*.json). Each file holds one case or an array of cases:
 *   { id, description, tags[], input: ExtractionInput, expected: { message_class?, suspicious_instructions?, ops[] } }
 * Expected ops use: op, taskHandle?, status?, owner?, due_date?. An omitted field is not scored; null means
 * "must be absent". For WAITING_FOR_OTHER, due_date is compared with expect_reply (or due).
 * The real golden set lives in the production DB, never in git.
 */

const Handle = z.enum(PARTICIPANT_HANDLES);
const HandleOrOther = z.union([Handle, z.literal("OTHER")]);
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const SegmentSchema = z.object({
  id: z.string().regex(/^S\d+$/),
  kind: z.enum(["NEW", "QUOTED", "FORWARDED"]),
  text: z.string(),
  author: z.string().nullable(),
  date: z.string().nullable(),
  truncated: z.boolean(),
  anchor: z.string().nullable(),
});

const TaskCardSchema = z.object({
  handle: z.enum(TASK_HANDLES),
  scope: z.enum(["THREAD_OPEN", "THREAD_CLOSED", "RELATED_OPEN"]),
  title: z.string(),
  status: z.enum(TASK_STATUSES),
  ownerHandle: z.union([Handle, z.literal("UNKNOWN")]),
  counterpartyHandle: Handle.nullable(),
  company: z.string().nullable(),
  dueDate: IsoDate.nullable(),
  duePhrase: z.string().nullable(),
  items: z.array(z.string()),
  originEvidence: z.string().nullable(),
  originDate: z.string().nullable(),
  lastEvent: z.string().nullable(),
  lastEventDate: z.string().nullable(),
  closedBy: z.enum(["ai", "user", "system"]).nullable(),
});

export const ExtractionInputSchema = z.object({
  owner: z.object({ name: z.string().nullable(), address: z.string(), aliases: z.array(z.string()), internalDomains: z.array(z.string()) }),
  zone: z.string(),
  message: z.object({
    direction: z.enum(["INBOUND", "OUTBOUND"]),
    sentAnchor: z.string(),
    subject: z.string(),
    fromHandle: HandleOrOther,
    toHandles: z.array(HandleOrOther),
    ccHandles: z.array(HandleOrOther),
    attachments: z.array(z.object({ filename: z.string(), contentType: z.string() })),
    segments: z.array(SegmentSchema).min(1),
    calendar: z
      .object({
        method: z.string(),
        summary: z.string().nullable(),
        start: z.string().nullable(),
        end: z.string().nullable(),
        tzid: z.string().nullable(),
        organizer: z.string().nullable(),
        location: z.string().nullable(),
      })
      .nullable(),
    late: z.boolean(),
  }),
  participants: z.array(
    z.object({
      handle: Handle,
      address: z.string(),
      name: z.string().nullable(),
      isOwner: z.boolean(),
      isInternal: z.boolean(),
      company: z.string().nullable(),
      roles: z.array(z.enum(["from", "to", "cc", "bcc", "quoted", "task"])),
    }),
  ),
  taskCards: z.array(TaskCardSchema).max(TASK_HANDLES.length),
  threadDigest: z.array(
    z.object({ date: z.string(), direction: z.enum(["INBOUND", "OUTBOUND"]), fromHandle: HandleOrOther, subject: z.string(), newText: z.string() }),
  ),
  lowLinkConfidence: z.boolean(),
});

export const ExpectedOpSchema = z.object({
  op: z.enum(["CREATE", "UPDATE", "COMPLETE", "REOPEN", "SUGGEST_DISMISS"]),
  taskHandle: z.enum(TASK_HANDLES).optional(),
  status: z.enum(["ACTION_REQUIRED", "WAITING_FOR_ME", "WAITING_FOR_OTHER"]).optional(),
  owner: Handle.nullable().optional(),
  due_date: IsoDate.nullable().optional(),
});
export type ExpectedOp = z.infer<typeof ExpectedOpSchema>;

export const EvalCaseSchema = z
  .object({
    id: z.string().min(1),
    description: z.string(),
    tags: z.array(z.string()),
    input: ExtractionInputSchema,
    expected: z.object({
      message_class: z.enum(MESSAGE_CLASSES).optional(),
      suspicious_instructions: z.boolean().optional(),
      ops: z.array(ExpectedOpSchema),
    }),
  })
  .superRefine((c, ctx) => {
    const handles = new Set(c.input.taskCards.map((t) => t.handle));
    for (const op of c.expected.ops) {
      if (op.op !== "CREATE" && !op.taskHandle) ctx.addIssue({ code: "custom", message: `${op.op} needs taskHandle` });
      if (op.taskHandle && !handles.has(op.taskHandle)) ctx.addIssue({ code: "custom", message: `unknown handle ${op.taskHandle}` });
    }
  });

export interface EvalCase {
  id: string;
  description: string;
  tags: string[];
  input: ExtractionInput;
  expected: { message_class?: z.infer<typeof EvalCaseSchema>["expected"]["message_class"]; suspicious_instructions?: boolean; ops: ExpectedOp[] };
}

/** Tag that marks the prompt-injection slice (the "0 unauthorized state changes" KPI). */
export const ADVERSARIAL_TAG = "adversarial";

/** Load and validate every case in `dir`, sorted by id. Filters: any of `tags`, any of `ids`. */
export function loadCases(dir: string, filter: { tags?: string[]; ids?: string[] } = {}): EvalCase[] {
  const cases: EvalCase[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const raw: unknown = JSON.parse(readFileSync(join(dir, file), "utf8"));
    for (const item of Array.isArray(raw) ? raw : [raw]) {
      const parsed = EvalCaseSchema.safeParse(item);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
        throw new Error(`eval case in ${file} is invalid: ${issues}`);
      }
      cases.push(parsed.data as EvalCase);
    }
  }
  const ids = new Set<string>();
  for (const c of cases) {
    if (ids.has(c.id)) throw new Error(`duplicate eval case id ${c.id}`);
    ids.add(c.id);
  }
  return cases
    .filter((c) => !filter.tags?.length || c.tags.some((t) => filter.tags!.includes(t)))
    .filter((c) => !filter.ids?.length || filter.ids.includes(c.id))
    .sort((a, b) => a.id.localeCompare(b.id));
}

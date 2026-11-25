import { DateTime } from "luxon";
import { z } from "zod";
import { FOLDER_ROLES, OPEN_STATUSES, PRIORITIES, SNOOZE_MODES } from "../domain/types.js";
import { normalizeAddress } from "../lib/text.js";

/** Request body schemas (zod). Shapes follow src/server/api-types.ts. */

export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => DateTime.fromISO(s).isValid, "invalid date");

const optText = (max: number) =>
  z
    .string()
    .max(max)
    .transform((s) => s.trim() || null)
    .nullable()
    .optional();

const optAddress = z
  .string()
  .max(320)
  .nullable()
  .optional()
  .transform((s, ctx) => {
    if (s === undefined) return undefined;
    if (s === null || s.trim() === "") return null;
    const a = normalizeAddress(s);
    if (!a) {
      ctx.addIssue({ code: "custom", message: "invalid address" });
      return z.NEVER;
    }
    return a;
  });

export const TaskTabParam = z.enum(["todo", "waiting", "all", "others", "review", "closed", "earlier"]);

/** The per-mailbox view (`?mailbox=`): checked against the user's own mailboxes by the route (ownMailboxId). */
const mailboxParam = z.string().max(64).optional();

export const MailboxViewQuery = z.object({ mailbox: mailboxParam });

export const TaskListQuery = z.object({
  tab: TaskTabParam.optional().default("todo"),
  company: z.string().max(200).optional(),
  q: z.string().max(500).optional(),
  review: z
    .enum(["1", "true", "0", "false"])
    .optional()
    .transform((v) => v === "1" || v === "true"),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  cursor: z.string().max(1000).optional(),
  mailbox: mailboxParam,
});

const editFields = {
  title: z.string().trim().min(1).max(300).optional(),
  status: z.enum(OPEN_STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  dueDate: isoDate.nullable().optional(),
  nextAction: optText(500),
  summary: optText(4000),
  company: optText(200),
  counterpartyAddress: optAddress,
  counterpartyName: optText(200),
};

export const CreateTaskBody = z.object({
  ...editFields,
  title: z.string().trim().min(1).max(300),
  status: z.enum(OPEN_STATUSES),
  fromMessageId: z.string().nullable().optional(),
  mailboxId: z.string().max(64).nullable().optional(),
});

export const EditTaskBody = z.object({ version: z.number().int().min(1), ...editFields });

const Snooze = z
  .object({ action: z.literal("snooze"), mode: z.enum(SNOOZE_MODES), until: isoDate.nullable().optional().default(null) })
  .refine((a) => a.mode !== "until_date" || a.until !== null, { message: "until required", path: ["until"] });

export const TaskActionSchema = z.union([
  z.object({ action: z.literal("complete") }),
  z.object({ action: z.literal("dismiss"), kind: z.enum(["not_a_task", "handled_by_other", "other"]) }),
  z.object({ action: z.literal("reopen") }),
  Snooze,
  z.object({ action: z.literal("unsnooze") }),
  z.object({ action: z.literal("confirm") }),
  z.object({ action: z.literal("still_valid") }),
  z.object({ action: z.literal("would_have_missed") }),
]);

export const TaskActionBody = z.intersection(TaskActionSchema, z.object({ version: z.number().int().min(1).optional() }));

export const MergeBody = z.object({ survivorId: z.string(), mergedId: z.string() });

export const BulkBody = z.object({ ids: z.array(z.string()).min(1).max(200), action: TaskActionSchema });

export const SuggestionBody = z.object({ decision: z.enum(["accept", "reject"]) });

// ── Mailboxes ────────────────────────────────────────────────────────────────

const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const host = z.string().trim().toLowerCase().regex(HOST_RE);
const port = z.number().int().min(1).max(65535);

const aliasList = z
  .array(z.string().max(320))
  .max(50)
  .transform((list, ctx) => {
    const out: string[] = [];
    for (const raw of list) {
      const a = normalizeAddress(raw);
      if (!a) {
        ctx.addIssue({ code: "custom", message: "invalid alias" });
        return z.NEVER;
      }
      if (!out.includes(a)) out.push(a);
    }
    return out;
  });

export const CreateMailboxBody = z.object({
  address: z.string().max(320),
  displayName: optText(200),
  provider: z.enum(["imap", "ingest"]).optional().default("imap"),
  imapHost: host.nullable().optional(),
  imapPort: port.optional().default(993),
  imapUsername: z.string().trim().min(1).max(320).nullable().optional(),
  smtpHost: host.nullable().optional(),
  smtpPort: port.nullable().optional(),
  aliases: aliasList.optional().default([]),
});

export const UpdateMailboxBody = z.object({
  displayName: optText(200),
  aliases: aliasList.optional(),
  status: z.enum(["active", "paused"]).optional(),
  smtpHost: host.nullable().optional(),
  smtpPort: port.nullable().optional(),
  // Connection settings (owner only; a change drops the stored password — see PATCH /api/mailboxes/:id).
  address: z.string().max(320).optional(),
  imapHost: host.optional(),
  imapPort: port.optional(),
  /** null = the address. */
  imapUsername: z.string().trim().min(1).max(320).nullable().optional(),
});

export type UpdateMailboxInput = z.infer<typeof UpdateMailboxBody>;

export const CredentialsBody = z.object({ password: z.string().min(1).max(1024) });

export const UpdateFolderBody = z.object({
  role: z.enum(FOLDER_ROLES).optional(),
  syncEnabled: z.boolean().optional(),
  private: z.boolean().optional(),
});

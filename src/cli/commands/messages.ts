import { and, asc, eq, inArray, isNotNull, isNull, type SQL } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { mailboxes, messages } from "../../db/schema.js";
import { UsageError, type ParsedArgs } from "../args.js";
import { audit, findMailbox, findUser, isUuid, type CliContext } from "../context.js";
import { yesOpt, type Command } from "./types.js";

/**
 * Parked messages ("Not analysed": state `failed` after a per-message error). The report lists each one once;
 * these commands close the loop: list them, queue them for another analysis, or acknowledge them.
 * Output is ids, dates and short error codes only — never subjects or addresses.
 */

const scopeOptions = {
  mailbox: { type: "string", arg: "<id|address>", description: "Only this mailbox" },
  user: { type: "string", arg: "<email|id>", description: "Only this user's mailboxes" },
} as const;

/** A short code from messages.last_error ("PER_MESSAGE: …" → PER_MESSAGE, "apply: merge_target" → apply:merge_target). */
export function parkedErrorCode(lastError: string | null): string {
  if (!lastError) return "-";
  const [head = "", second = ""] = lastError.split(":").map((s) => s.trim());
  const code = /^[A-Za-z0-9_.-]{1,40}$/.test(head) ? head : "error";
  return /^[A-Za-z0-9_.-]{1,40}$/.test(second) ? `${code}:${second}` : code;
}

/** Mailbox ids in scope (--mailbox / --user), or null for all. */
async function scopeMailboxes(db: Db, args: ParsedArgs): Promise<string[] | null> {
  const mbRef = args.str("mailbox");
  const userRef = args.str("user");
  if (mbRef && userRef) throw new UsageError("Give --mailbox or --user, not both");
  if (mbRef) return [(await findMailbox(db, mbRef)).id];
  if (userRef) {
    const user = await findUser(db, userRef);
    return (await db.select({ id: mailboxes.id }).from(mailboxes).where(eq(mailboxes.userId, user.id))).map((m) => m.id);
  }
  return null;
}

/** `<id>` or `--all` (with an optional scope): the WHERE for the targeted parked messages. */
async function targetOf(ctx: CliContext, args: ParsedArgs): Promise<{ where: SQL; label: string }> {
  const rt = await ctx.runtime();
  const id = args.positionals[0];
  if (id && args.bool("all")) throw new UsageError("Give a message id or --all, not both");
  if (!id && !args.bool("all")) throw new UsageError("Give a message id (see messages:parked) or --all");
  if (id) {
    if (!isUuid(id)) throw new UsageError("The message id must be a UUID (see messages:parked)");
    if (args.str("mailbox") || args.str("user")) throw new UsageError("--mailbox/--user only go with --all");
    return { where: and(eq(messages.id, id), eq(messages.state, "failed"))!, label: `message ${id}` };
  }
  const scope = await scopeMailboxes(rt.db, args);
  if (scope && scope.length === 0) throw new UsageError("That user has no mailboxes");
  return {
    where: and(eq(messages.state, "failed"), scope ? inArray(messages.mailboxId, scope) : undefined)!,
    label: scope ? `all parked messages of ${scope.length} mailbox(es)` : "all parked messages",
  };
}

export const messagesParked: Command = {
  name: "messages:parked",
  summary: "List parked messages (not analysed after a per-message error): ids, dates, error codes",
  options: { ...scopeOptions, all: { type: "boolean", description: "Include acknowledged ones" } },
  async run(ctx, args) {
    const rt = await ctx.runtime();
    const scope = await scopeMailboxes(rt.db, args);
    const rows = await rt.db
      .select({
        id: messages.id,
        mailboxId: messages.mailboxId,
        sortTs: messages.sortTs,
        parkedAt: messages.updatedAt,
        attempts: messages.attempts,
        lastError: messages.lastError,
        acknowledgedAt: messages.failureAcknowledgedAt,
        bodyPurgedAt: messages.bodyPurgedAt,
      })
      .from(messages)
      .where(and(eq(messages.state, "failed"), scope ? inArray(messages.mailboxId, scope.length ? scope : ["00000000-0000-0000-0000-000000000000"]) : undefined, args.bool("all") ? undefined : isNull(messages.failureAcknowledgedAt)))
      .orderBy(asc(messages.sortTs), asc(messages.id));
    if (!rows.length) {
      ctx.io.out(args.bool("all") ? "No parked messages." : "No parked messages waiting for a decision.");
      return 0;
    }
    for (const r of rows) {
      const flags = [r.acknowledgedAt ? `acknowledged ${r.acknowledgedAt.toISOString()}` : null, r.bodyPurgedAt ? "text purged (cannot retry)" : null].filter(Boolean).join(", ");
      ctx.io.out(
        `  ${r.id}  mailbox ${r.mailboxId.slice(0, 8)}  received ${r.sortTs.toISOString()}  parked ${r.parkedAt.toISOString()}  ` +
          `attempts ${r.attempts}  error ${parkedErrorCode(r.lastError)}${flags ? `  (${flags})` : ""}`,
      );
    }
    ctx.io.out(`${rows.length} parked message(s). Analyse again: pnpm cli messages:retry <id|--all>; stop reporting: pnpm cli messages:ack <id|--all>`);
    return 0;
  },
};

export const messagesRetry: Command = {
  name: "messages:retry",
  summary: "Queue parked message(s) for another analysis (the worker picks them up; AI cost applies)",
  options: { ...scopeOptions, all: { type: "boolean", description: "Every parked message (in scope)" }, yes: yesOpt },
  positional: { name: "message-id", min: 0, max: 1 },
  async run(ctx, args) {
    const rt = await ctx.runtime();
    const now = ctx.now();
    const target = await targetOf(ctx, args);
    const rows = await rt.db.select({ id: messages.id, mailboxId: messages.mailboxId, bodyPurgedAt: messages.bodyPurgedAt, key: messages.messageKey }).from(messages).where(target.where);
    if (!rows.length) {
      ctx.io.err(args.positionals[0] ? `No parked message ${args.positionals[0]}.` : "No parked messages.");
      return 1;
    }
    // Purged text or a sync trace of a message that could never be fetched ("poison:"): nothing to analyse.
    const retryable = rows.filter((r) => r.bodyPurgedAt === null && !r.key.startsWith("poison:"));
    const purged = rows.length - retryable.length;
    if (!retryable.length) {
      ctx.io.err(`Nothing to retry: ${purged} parked message(s) have no text to analyse (purged by retention, or never fetched). Use messages:ack.`);
      return 1;
    }
    if (!args.bool("yes") && !(await ctx.io.confirm(`Analyse ${retryable.length} parked message(s) again (${target.label})?`))) return 1;
    const done = await rt.db
      .update(messages)
      .set({ state: "pending", attempts: 0, nextAttemptAt: null, lastError: null, failureAcknowledgedAt: null, updatedAt: now })
      .where(and(target.where, isNull(messages.bodyPurgedAt), inArray(messages.id, retryable.map((r) => r.id))))
      .returning({ id: messages.id, mailboxId: messages.mailboxId });
    const mailboxIds = [...new Set(done.map((r) => r.mailboxId))];
    await audit(rt.db, "parked_messages_retry", { detail: { count: done.length, mailboxes: mailboxIds }, now });
    ctx.io.out(`Queued ${done.length} message(s) for analysis${purged ? `; ${purged} skipped (no text to analyse — use messages:ack)` : ""}. The worker picks them up within a minute.`);
    return 0;
  },
};

export const messagesAck: Command = {
  name: "messages:ack",
  summary: "Acknowledge parked message(s): no longer reported (still listed by messages:parked --all)",
  options: { ...scopeOptions, all: { type: "boolean", description: "Every parked message (in scope)" }, yes: yesOpt },
  positional: { name: "message-id", min: 0, max: 1 },
  async run(ctx, args) {
    const rt = await ctx.runtime();
    const now = ctx.now();
    const target = await targetOf(ctx, args);
    const pending = await rt.db.select({ id: messages.id }).from(messages).where(and(target.where, isNull(messages.failureAcknowledgedAt)));
    if (!pending.length) {
      const already = await rt.db.select({ id: messages.id }).from(messages).where(and(target.where, isNotNull(messages.failureAcknowledgedAt)));
      if (already.length) {
        ctx.io.out("Already acknowledged.");
        return 0;
      }
      ctx.io.err(args.positionals[0] ? `No parked message ${args.positionals[0]}.` : "No parked messages.");
      return 1;
    }
    if (args.bool("all") && !args.bool("yes") && !(await ctx.io.confirm(`Acknowledge ${pending.length} parked message(s) (${target.label})?`))) return 1;
    const done = await rt.db
      .update(messages)
      .set({ failureAcknowledgedAt: now })
      .where(and(target.where, isNull(messages.failureAcknowledgedAt)))
      .returning({ id: messages.id, mailboxId: messages.mailboxId });
    await audit(rt.db, "parked_messages_ack", { detail: { count: done.length, mailboxes: [...new Set(done.map((r) => r.mailboxId))] }, now });
    ctx.io.out(`Acknowledged ${done.length} parked message(s); they are no longer reported.`);
    return 0;
  },
};

export const messageCommands: Command[] = [messagesParked, messagesRetry, messagesAck];

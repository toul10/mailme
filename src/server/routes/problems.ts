import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { mailboxes, messages } from "../../db/schema.js";
import type { ParkedMessage } from "../api-types.js";
import { authOf, requireAuth } from "../auth/guard.js";
import type { AppContext } from "../context.js";
import { notFound, parseWith, uuidParam } from "../http.js";

/** How many parked messages the list returns (newest first). */
const MAX_PARKED = 100;

const ProblemActionBody = z.object({ action: z.enum(["retry", "acknowledge"]) });

/**
 * messages.last_error is "<CLASS>: <provider text>", "apply: <code>" (src/engine/pipeline.ts) or a bare code such as
 * "invalid_output" (src/engine/apply.ts). Only the code part leaves the server — the text after the class can quote
 * the model or the provider.
 */
export function parkedErrorCode(lastError: string | null): string | null {
  if (!lastError) return null;
  const apply = /^apply:\s*([a-z0-9_]{1,40})/i.exec(lastError);
  if (apply) return `apply:${apply[1]}`;
  if (/^[a-z][a-z0-9_]{1,39}$/.test(lastError)) return lastError;
  const cls = /^([A-Z][A-Z0-9_]{1,39})(?=$|[:\s])/.exec(lastError);
  return cls ? cls[1]! : null;
}

/**
 * Parked messages ("Not analysed"): what the extractor/reconciler could not handle. The owner can send
 * one back to the queue or acknowledge it (it then stops being reported). Always scoped to the session user's own
 * mailboxes — subjects and senders are content, so admins see only their own here too.
 */
export function registerProblemRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, clock } = ctx.deps;
  const full = { preHandler: requireAuth(ctx, "full") };

  async function ownMailboxIds(userId: string): Promise<string[]> {
    const rows = await db.select({ id: mailboxes.id }).from(mailboxes).where(eq(mailboxes.userId, userId));
    return rows.map((r) => r.id);
  }

  app.get("/api/problems", full, async (request) => {
    const ids = await ownMailboxIds(authOf(request).userId);
    if (ids.length === 0) return { parked: [] as ParkedMessage[] };
    const rows = await db
      .select({
        id: messages.id,
        mailboxId: messages.mailboxId,
        sortTs: messages.sortTs,
        fromName: messages.fromName,
        fromAddress: messages.fromAddress,
        subject: messages.subject,
        lastError: messages.lastError,
        attempts: messages.attempts,
      })
      .from(messages)
      .where(and(inArray(messages.mailboxId, ids), eq(messages.state, "failed"), isNull(messages.failureAcknowledgedAt)))
      .orderBy(desc(messages.sortTs), desc(messages.id))
      .limit(MAX_PARKED);
    const parked: ParkedMessage[] = rows.map((r) => ({
      messageId: r.id,
      mailboxId: r.mailboxId,
      date: r.sortTs.toISOString(),
      fromName: r.fromName,
      fromAddress: r.fromAddress,
      subject: r.subject,
      error: parkedErrorCode(r.lastError),
      attempts: r.attempts,
    }));
    return { parked };
  });

  app.post<{ Params: { messageId: string } }>("/api/problems/:messageId", full, async (request, reply) => {
    const auth = authOf(request);
    const messageId = uuidParam(request.params.messageId);
    const { action } = parseWith(ProblemActionBody, request.body);
    const ids = await ownMailboxIds(auth.userId);
    if (ids.length === 0) throw notFound();
    const now = clock.now();
    // Only a parked message of one's own mailbox changes; anything else (someone else's, already retried) is 404.
    const where = and(eq(messages.id, messageId), inArray(messages.mailboxId, ids), eq(messages.state, "failed"));
    if (action === "retry") {
      // A sync trace of a message that could not be fetched ("poison:") or one whose text was purged has nothing to
      // analyse: re-queueing it would send an empty message to the AI. Those can only be acknowledged.
      const [row] = await db.select({ key: messages.messageKey, purged: messages.bodyPurgedAt }).from(messages).where(where);
      if (!row) throw notFound();
      if (row.key.startsWith("poison:") || row.purged !== null) {
        return reply.code(400).send({ error: "This message can't be analysed again — press “Got it”", code: "invalid" });
      }
    }
    const updated =
      action === "retry"
        ? await db
            .update(messages)
            // Back to the queue: the pipeline takes it again (a fresh extraction attempt; a stored ok extraction is reused).
            .set({ state: "pending", attempts: 0, nextAttemptAt: null, lastError: null, failureAcknowledgedAt: null, updatedAt: now })
            .where(where)
            .returning({ id: messages.id })
        : await db
            .update(messages)
            // Idempotent: a second "Got it" keeps the first acknowledgement time.
            .set({ failureAcknowledgedAt: sql`coalesce(${messages.failureAcknowledgedAt}, ${now.toISOString()}::timestamptz)`, updatedAt: now })
            .where(where)
            .returning({ id: messages.id });
    if (updated.length === 0) throw notFound();
    ctx.deps.log.info({ messageId, action }, "parked message action");
    return { ok: true as const };
  });
}

import type { FastifyInstance } from "fastify";
import { Readable } from "node:stream";
import { z } from "zod";
import { newChatStats, runChat, type ChatDeps } from "../../chat/engine.js";
import { CHAT_LIMITS } from "../../chat/prompt.js";
import { chatUsageToday, recordChat } from "../../chat/usage.js";
import { errorCode } from "../../ops/alerts.js";
import type { ChatEvent } from "../api-types.js";
import { authOf, rateLimit, requireAuth } from "../auth/guard.js";
import type { AppContext } from "../context.js";
import { HttpError, notFound, parseWith } from "../http.js";
import { ownMailboxId } from "../queries.js";

/**
 * One question may take this long, lookups and model calls together. Below the request timeout of the platform in
 * front (Cloud Run: 120 s, deploy/gcp/40-deploy.sh), so the reader gets our own message instead of a cut connection.
 */
export const CHAT_DEADLINE_MS = 100_000;

const ChatBody = z.object({
  question: z.string().trim().min(1).max(CHAT_LIMITS.questionChars),
  history: z
    .array(
      z.object({
        question: z.string().max(CHAT_LIMITS.questionChars),
        answer: z.string().max(CHAT_LIMITS.answerChars),
        draft: z
          .string()
          .max(CHAT_LIMITS.draftChars)
          .nullish()
          .transform((v) => v ?? null),
        sources: z.array(z.object({ kind: z.enum(["mail", "task"]), id: z.string().max(64) })).max(60),
      }),
    )
    // The engine reads the newest CHAT_LIMITS.historyTurns of them; a longer list is a client that sends too much.
    .max(12)
    .default([]),
  /** The per-mailbox view: one of the session user's own mailboxes (checked below). */
  mailboxId: z.string().max(64).nullish(),
});

const line = (event: ChatEvent): string => `${JSON.stringify(event)}\n`;
const busy = (message: string, retryAfterSec?: number) => new HttpError(429, "rate_limited", message, retryAfterSec ? { "retry-after": String(retryAfterSec) } : {});

/**
 * "Ask your mail" (src/chat): the session user asks about their own mail and tasks. The answer is streamed as
 * NDJSON — what is being looked up, then the answer — because a question takes several model calls. The model only
 * reads, and only this user's data (src/chat/search.ts); nothing of the conversation is stored.
 *
 * Refused before any model call: too many questions in a short time (per user), a question of the same user still
 * running, the user's questions per day, the cost of everyone's questions per day, and a `mailboxId` that is not one
 * of the user's own mailboxes (404). 404 also when the chat is off.
 */
export function registerChatRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, clock, log, config } = ctx.deps;
  const model = ctx.deps.chatModel ?? null;
  const deadlineMs = ctx.deps.chatDeadlineMs ?? CHAT_DEADLINE_MS;
  const guard = { preHandler: [requireAuth(ctx, "full"), rateLimit(ctx, "chat", (req) => authOf(req).userId)] };
  // The question each user has running. Per process: the API runs as one instance; a second instance would only
  // allow one more question at a time. The value is the request's own claim, so that a request can only ever give
  // up its own lock, never the lock of a later question of the same user.
  const running = new Map<string, object>();

  app.post("/api/chat", guard, async (request, reply) => {
    if (!model) throw notFound();
    const auth = authOf(request);
    const body = parseWith(ChatBody, request.body);
    const userId = auth.userId;
    if (running.has(userId)) throw busy("Wait for your previous question to finish.", 5);
    // Claimed before the first await: questions of one user that arrive together must not all get past the check
    // above while the first of them is still reading the day's usage.
    const claim = {};
    running.set(userId, claim);
    const unlock = (): void => {
      if (running.get(userId) === claim) running.delete(userId);
    };
    let mailboxId: string | null;
    try {
      mailboxId = await ownMailboxId(db, userId, body.mailboxId);
      const used = await chatUsageToday(db, userId, auth.timezone, clock.now());
      if (used.questions >= config.CHAT_DAILY_QUESTION_CAP) throw busy("You've reached today's limit of questions. Try again tomorrow.");
      if (used.usdAll >= config.CHAT_DAILY_USD_CAP) throw busy("The chat has reached its daily limit. Try again tomorrow.");
    } catch (err) {
      // Refused, or the usage could not be read: no question is running.
      unlock();
      throw err;
    }

    const deps: ChatDeps = { db, clock, log: log.child({ mod: "chat" }), model, retentionDays: config.BODY_RETENTION_DAYS, denyList: config.DENY_LIST };
    const stats = newChatStats(model);
    const abort = new AbortController();
    const started = performance.now();
    let deadlineHit = false;
    let finished = false;
    const timer = setTimeout(() => {
      deadlineHit = true;
      abort.abort();
    }, deadlineMs);
    // Should the stream never be read to its end, the lock must not outlive the question.
    const backstop = setTimeout(unlock, deadlineMs + 15_000);
    backstop.unref();
    const release = (): void => {
      clearTimeout(timer);
      clearTimeout(backstop);
      unlock();
    };
    let begun = false;
    // The reader went away (closed the tab, pressed stop): give up the model call that is under way. Gone before the
    // first line was asked for, the stream below is never read: nothing was spent, and nothing else frees the lock.
    const readerGone = (): void => {
      if (finished) return;
      abort.abort();
      if (!begun) release();
    };
    reply.raw.on("close", readerGone);
    if (reply.raw.destroyed) readerGone();

    async function* lines(): AsyncGenerator<string, void, void> {
      begun = true;
      try {
        for await (const event of runChat(deps, { userId, zone: auth.timezone, question: body.question, history: body.history, mailboxId }, stats, abort.signal)) yield line(event);
        if (stats.outcome === "aborted" && deadlineHit) yield line({ type: "error", code: "too_slow", message: "That took too long, so I stopped. Try a more specific question." });
        finished = true;
      } catch (err) {
        finished = true;
        stats.outcome = "error:internal";
        deps.log.error({ reqId: request.id, code: errorCode(err) }, "chat: the question failed");
        yield line({ type: "error", code: "internal", message: "Something went wrong. Try again." });
      } finally {
        if (!finished) {
          abort.abort();
          if (stats.outcome === "running") stats.outcome = "aborted";
        }
        release();
        try {
          await recordChat(db, { orgId: auth.orgId, userId, ip: request.ip, stats, ms: performance.now() - started });
        } catch (err) {
          deps.log.error({ reqId: request.id, code: errorCode(err) }, "chat: the usage record was not written");
        }
      }
    }

    reply.header("content-type", "application/x-ndjson; charset=utf-8");
    // Proxies that buffer responses (nginx) are told not to: the steps are there to be seen as they happen.
    reply.header("x-accel-buffering", "no");
    return reply.send(Readable.from(lines(), { objectMode: false }));
  });
}

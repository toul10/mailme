import type { FastifyInstance } from "fastify";
import { errorCode } from "../../ops/alerts.js";
import type { SyncNowResponse } from "../api-types.js";
import { authOf, requireAuth } from "../auth/guard.js";
import type { AppContext } from "../context.js";
import { HttpError, notFound, rateLimited } from "../http.js";

/** At most one start per minute: a tick takes about 30 s, and one already running makes the next skip anyway. */
export const SYNC_NOW_COOLDOWN_MS = 60_000;

/**
 * "Check now" (src/server/sync-now.ts): start one worker pass now instead of at the next 5-minute tick. Available
 * only where the worker runs as a scheduled job (TICK_JOB); elsewhere an always-on worker watches the mailbox itself.
 */
export function registerSyncNowRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { syncNow, clock, log } = ctx.deps;
  const full = { preHandler: requireAuth(ctx, "full") };
  // Per process: the API runs as one instance (deploy/gcp/40-deploy.sh), and the tick's lock covers the rest.
  let lastStartMs = Number.NEGATIVE_INFINITY;

  app.post("/api/sync-now", full, async (request, reply): Promise<SyncNowResponse> => {
    if (!syncNow) throw notFound();
    const nowMs = clock.now().getTime();
    const waitMs = lastStartMs + SYNC_NOW_COOLDOWN_MS - nowMs;
    if (waitMs > 0) throw rateLimited(Math.ceil(waitMs / 1000));
    lastStartMs = nowMs;
    try {
      await syncNow.start();
    } catch (err) {
      lastStartMs = Number.NEGATIVE_INFINITY; // a start that failed does not hold back a retry
      log.error({ code: errorCode(err) }, "sync-now: the tick job did not start");
      throw new HttpError(502, "internal", "The check didn't start. Try again in a moment.");
    }
    log.info({ userId: authOf(request).userId }, "sync-now: tick job started");
    reply.code(202);
    return { started: true };
  });
}

import { sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import { computeFreshness } from "../../digest/freshness.js";
import { loadSyncActivity, pgLockProbe } from "../activity.js";
import type { HealthSummary } from "../api-types.js";
import { authOf, requireAuth } from "../auth/guard.js";
import type { AppContext } from "../context.js";

export function registerHealthRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, clock } = ctx.deps;
  const probe = ctx.deps.lockProbe ?? pgLockProbe(db);

  /** Freshness of the session user's own mailboxes (sync age, queue, failures, pause) and what the worker does now. */
  app.get("/api/health", { preHandler: requireAuth(ctx, "full") }, async (request) => {
    const auth = authOf(request);
    const now = clock.now();
    const f = await computeFreshness(db, auth.userId, now);
    const activity = await loadSyncActivity(db, probe, auth.userId, auth.timezone, now);
    const res: HealthSummary = {
      lastSyncAt: f.lastSyncAt ? f.lastSyncAt.toISOString() : null,
      staleMinutes: f.staleMinutes,
      pendingCount: f.pendingCount,
      oldestPendingMinutes: f.oldestPendingMinutes,
      failedCount: f.failedCount,
      paused: f.paused,
      banner: f.banner,
      canSyncNow: Boolean(ctx.deps.syncNow),
      activity,
    };
    return res;
  });

  /**
   * Unauthenticated liveness probe for the container/reverse proxy: process up and database reachable. Served on both
   * paths: Cloud Run's front end reserves paths ending in "z" (/healthz gets Google's own 404 there), so on Cloud Run
   * the probe is /health (deploy/gcp).
   */
  const live = async (_request: unknown, reply: FastifyReply) => {
    try {
      await db.execute(sql`select 1`);
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  };
  app.get("/healthz", live);
  app.get("/health", live);
}

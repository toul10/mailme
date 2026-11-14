import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppContext } from "../context.js";
import { forbidden, mfaRequired, rateLimited, unauthorized } from "../http.js";
import type { RateGroup } from "../rate-limit.js";
import { safeEqual } from "../secrets.js";
import { loadSession, type AuthContext } from "./sessions.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Set by `requireAuth` (null on routes without a session). */
    auth: AuthContext | null;
  }
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * preHandler: resolve the session cookie and enforce the level.
 * - "password": any valid session (the MFA step, /api/me, logout);
 * - "full": MFA passed (or not required).
 * Every non-GET request must also carry the session's CSRF token in `x-csrf-token`.
 */
export function requireAuth(ctx: AppContext, level: "password" | "full") {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const auth = await loadSession(ctx.deps.db, request.cookies[ctx.cookies.session], ctx.deps.clock.now());
    if (!auth) throw unauthorized();
    if (!SAFE_METHODS.has(request.method)) {
      const header = request.headers["x-csrf-token"];
      if (typeof header !== "string" || !safeEqual(header, auth.csrfToken)) throw forbidden("Invalid CSRF token");
    }
    if (level === "full" && !auth.mfaVerified) throw mfaRequired();
    request.auth = auth;
  };
}

/** The request's auth context (only inside routes guarded by `requireAuth`). */
export function authOf(request: FastifyRequest): AuthContext {
  if (!request.auth) throw unauthorized();
  return request.auth;
}

/** Hook factory: one token from the (group, key) bucket, 429 when empty. */
export function rateLimit(ctx: AppContext, group: RateGroup, keyOf: (req: FastifyRequest) => string = (req) => req.ip) {
  return async (request: FastifyRequest): Promise<void> => {
    const r = ctx.limiter.take(group, keyOf(request));
    if (!r.ok) throw rateLimited(r.retryAfterSec);
  };
}

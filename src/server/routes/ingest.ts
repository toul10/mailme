import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { mailboxes } from "../../db/schema.js";
import type { IngestResult } from "../../domain/types.js";
import { audit } from "../audit.js";
import { rateLimit } from "../auth/guard.js";
import type { AppContext } from "../context.js";
import { badRequest, forbidden, HttpError, UUID_RE } from "../http.js";
import { safeEqual, sha256Hex } from "../secrets.js";

export const INGEST_BODY_LIMIT = 10 * 1024 * 1024;
/** Uploader marks the message as the owner's sent mail (Outlook agent, Sent Items). */
export const DECLARED_OUTBOUND_HEADER = "x-mailme-declared-outbound";
/** `x-mailme-agent: outlook` marks uploads from the Outlook PC agent (else via = ingest_api). */
export const AGENT_HEADER = "x-mailme-agent";

declare module "fastify" {
  interface FastifyRequest {
    /** Mailbox authenticated by the ingest bearer token (ingest scope only). */
    ingestMailbox: { id: string; orgId: string; userId: string } | null;
  }
}

const invalidToken = () => new HttpError(401, "unauthorized", "Invalid token", { "www-authenticate": 'Bearer realm="mailme-ingest"' });

/**
 * POST /api/ingest/:mailboxId — raw MIME upload (≤ 10 MB) with `Authorization: Bearer <token>`.
 * Registered in its own scope so the raw-body parsers apply to this route only. No cookies, no CSRF.
 */
export function registerIngestRoutes(scope: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx.deps;

  scope.decorateRequest("ingestMailbox", null);
  scope.addContentTypeParser(["message/rfc822", "application/octet-stream"], { parseAs: "buffer", bodyLimit: INGEST_BODY_LIMIT }, (_req, body, done) => {
    done(null, body);
  });

  /** Token check in onRequest, before a (possibly 10 MB) body is read. */
  async function authenticate(request: FastifyRequest): Promise<void> {
    const params = request.params as { mailboxId?: string };
    const header = request.headers.authorization ?? "";
    const match = /^Bearer\s+([A-Za-z0-9_\-.~+/=]{16,200})$/.exec(header);
    const id = params.mailboxId && UUID_RE.test(params.mailboxId) ? params.mailboxId.toLowerCase() : null;
    const [m] = id ? await db.select().from(mailboxes).where(eq(mailboxes.id, id)).limit(1) : [];
    // Same 401 for unknown mailbox, missing token and wrong token (no mailbox-id oracle).
    if (!m || !match || !m.ingestTokenHash || !safeEqual(sha256Hex(match[1]!), m.ingestTokenHash)) {
      await audit(db, { orgId: m?.orgId, userId: m?.userId, event: "ingest.auth_fail", detail: { mailboxId: m?.id ?? null }, ip: request.ip });
      throw invalidToken();
    }
    if (m.status === "disabled") throw forbidden("The mailbox is disabled");
    request.ingestMailbox = { id: m.id, orgId: m.orgId, userId: m.userId };
  }

  scope.post<{ Params: { mailboxId: string } }>(
    "/api/ingest/:mailboxId",
    { bodyLimit: INGEST_BODY_LIMIT, onRequest: [rateLimit(ctx, "ingest"), authenticate] },
    async (request, reply) => {
      const mailbox = request.ingestMailbox;
      if (!mailbox) throw invalidToken();
      if (!Buffer.isBuffer(request.body)) {
        return reply.code(415).send({ error: "Expected message/rfc822", code: "invalid" });
      }
      const raw = request.body;
      if (raw.length === 0) throw badRequest("Empty message");
      const declaredOutbound = request.headers[DECLARED_OUTBOUND_HEADER] === "1";
      const via = String(request.headers[AGENT_HEADER] ?? "").toLowerCase() === "outlook" ? "outlook_agent" : "ingest_api";
      const result = await ctx.deps.ingest({ mailboxId: mailbox.id, source: { kind: "mime", raw }, location: null, via, declaredOutbound });
      ctx.deps.log.info({ mailboxId: mailbox.id, messageId: result.messageId, created: result.created, state: result.state, via, bytes: raw.length }, "ingested");
      const res: IngestResult = {
        messageId: result.messageId,
        created: result.created,
        state: result.state,
        filterReason: result.filterReason,
        direction: result.direction,
        threadId: result.threadId,
      };
      return res;
    },
  );
}

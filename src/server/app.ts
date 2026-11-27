import fastifyCookie from "@fastify/cookie";
import type { ModelLister } from "../ai/providers.js";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply } from "fastify";
import path from "node:path";
import type { ChatModel } from "../chat/model.js";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import type { Clock, IngestInput, IngestResult, Logger } from "../domain/types.js";
import type { MailboxConnectionSettings } from "../domain/types.js";
import { ConflictError, NotFoundError, ValidationError } from "../engine/user-actions.js";
import type { SealingKeys } from "../lib/sealed.js";
import type { ProbeResult } from "../mail/imap/probe.js";
import type { ApiError } from "./api-types.js";
import { registerAuthRoutes } from "./auth/routes.js";
import { cookieConfig } from "./auth/sessions.js";
import type { AppContext } from "./context.js";
import { systemResolver, type HostResolver } from "./host-policy.js";
import { apiError, HttpError, isActionPath, isApiPath, pathOf } from "./http.js";
import { messagePage } from "./pages/html.js";
import { registerOneClickRoutes } from "./pages/one-click.js";
import { RateLimiter } from "./rate-limit.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerAdminAiRoutes } from "./routes/admin-ai.js";
import { registerChatRoutes } from "./routes/chat.js";
import { registerCostRoutes } from "./routes/costs.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerIngestRoutes } from "./routes/ingest.js";
import { registerMailboxRoutes } from "./routes/mailboxes.js";
import { registerPreferenceRoutes } from "./routes/preferences.js";
import { registerRuleRoutes } from "./routes/rules.js";
import { registerSyncNowRoutes } from "./routes/sync-now.js";
import { registerProblemRoutes } from "./routes/problems.js";
import { registerTaskRoutes } from "./routes/tasks.js";
import { deriveLinkSecret } from "./secrets.js";
import type { SyncNowTrigger } from "./sync-now.js";
import type { LockProbe } from "./activity.js";
import { applySecurityHeaders } from "./security.js";

export interface ServerDeps {
  db: Db;
  clock: Clock;
  log: Logger;
  config: Config;
  /** Public key only — the API never opens credentials. */
  sealingKeys: Pick<SealingKeys, "kid" | "publicKey">;
  probe(settings: MailboxConnectionSettings, password: string): Promise<ProbeResult>;
  ingest(input: IngestInput): Promise<IngestResult>;
  /** Directory with the built SPA (web/dist); optional in tests. */
  webDist?: string | null;
  /** DNS lookup for the SSRF guard on user-supplied mail hosts (default: the system resolver; tests inject one). */
  resolveHost?: HostResolver;
  /** "Check now": starts the scheduled tick job now (TICK_JOB); null where an always-on worker runs. */
  syncNow?: SyncNowTrigger | null;
  /** Lists a pasted AI key's models (a free provider call that proves the key); tests inject one. */
  listModels?: ModelLister;
  /** "Ask your mail": the model that answers (src/chat/model.ts); null or absent where the chat is off. */
  chatModel?: ChatModel | null;
  /** How long one chat question may take (default: CHAT_DEADLINE_MS of src/server/routes/chat.ts); tests shorten it. */
  chatDeadlineMs?: number;
  /** Which worker locks are held (src/server/activity.ts; default: pg_locks); tests inject one. */
  lockProbe?: LockProbe;
}

/** Signed one-click tokens are ~200 chars; Fastify's default 100-char param limit would 404 them. */
const MAX_PARAM_LENGTH = 2048;

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({
    // Fastify's request logger would log URLs (one-click tokens); we log route patterns ourselves.
    logger: false,
    // Which peers may set X-Forwarded-For (rate-limit keys and audit IPs come from request.ip). Mac: Caddy on
    // loopback; Docker: Caddy's fixed address (docker-compose.yml sets TRUST_PROXY to MAILME_CADDY_IP).
    trustProxy: parseTrustProxy(deps.config.TRUST_PROXY),
    routerOptions: { maxParamLength: MAX_PARAM_LENGTH },
    bodyLimit: 1024 * 1024,
    return503OnClosing: true,
  });

  const base = new URL(deps.config.APP_BASE_URL);
  const ctx: AppContext = {
    deps,
    limiter: new RateLimiter(() => deps.clock.now().getTime()),
    cookies: cookieConfig(deps.config.APP_BASE_URL),
    appOrigin: base.origin,
    https: base.protocol === "https:",
    linkSecret: deriveLinkSecret(deps.config),
    resolveHost: deps.resolveHost ?? systemResolver,
  };

  warnOnProxyMisconfig(deps);

  app.decorateRequest("auth", null);

  // JSON only at the root (no text/plain): cross-site "simple" form posts can't reach JSON handlers.
  // Empty JSON bodies are tolerated for body-less POSTs (logout, enroll, ingest-token).
  const defaultJson = app.getDefaultJsonParser("error", "error");
  app.removeContentTypeParser(["application/json", "text/plain"]);
  app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
    const text = typeof body === "string" ? body : body.toString("utf8");
    if (text.trim() === "") {
      done(null, undefined);
      return;
    }
    defaultJson(request, text, done);
  });

  app.addHook("onRequest", async (request, reply) => {
    applySecurityHeaders(reply, pathOf(request.url), ctx.https);
  });

  // Access log: route pattern only (never the URL — it may carry tokens or search terms).
  app.addHook("onResponse", async (request, reply) => {
    deps.log.info(
      { reqId: request.id, method: request.method, route: request.routeOptions.url ?? "unmatched", status: reply.statusCode, ms: Math.round(reply.elapsedTime) },
      "http",
    );
  });

  app.setErrorHandler((err: FastifyError | Error, request, reply) => {
    const mapped = mapError(err);
    if (mapped.status >= 500) {
      deps.log.error({ reqId: request.id, route: request.routeOptions.url ?? "unmatched", err: safeError(err) }, "request failed");
    }
    for (const [k, v] of Object.entries(mapped.headers)) reply.header(k, v);
    reply.code(mapped.status);
    if (isActionPath(pathOf(request.url))) return sendHtml(reply, messagePage(mapped.pageTitle, mapped.message, { warn: true }));
    return reply.send(apiError(mapped.code, mapped.message));
  });

  app.setNotFoundHandler(async (request, reply) => {
    const p = pathOf(request.url);
    if (isApiPath(p)) return reply.code(404).send(apiError("not_found", "Not found"));
    if (isActionPath(p)) {
      return sendHtml(reply.code(404), messagePage("Not found", "This link is not valid.", { link: { href: "/", label: "Open MailMe" } }));
    }
    const last = p.slice(p.lastIndexOf("/") + 1);
    if (deps.webDist && (request.method === "GET" || request.method === "HEAD") && !last.includes(".")) {
      // SPA fallback: client-side routes get index.html.
      reply.header("cache-control", "no-cache");
      return reply.sendFile("index.html");
    }
    return reply.code(404).send(apiError("not_found", "Not found"));
  });

  await app.register(fastifyCookie);

  if (deps.webDist) {
    await app.register(fastifyStatic, {
      root: path.resolve(deps.webDist),
      prefix: "/",
      wildcard: false,
      index: ["index.html"],
      setHeaders(reply, filePath) {
        // Vite emits content-hashed files under assets/; everything else must revalidate.
        const hashed = filePath.split(path.sep).includes("assets");
        reply.header("cache-control", hashed ? "public, max-age=31536000, immutable" : "no-cache");
      },
    });
  }

  registerAuthRoutes(app, ctx);
  registerTaskRoutes(app, ctx);
  registerMailboxRoutes(app, ctx);
  registerProblemRoutes(app, ctx);
  registerPreferenceRoutes(app, ctx);
  registerRuleRoutes(app, ctx);
  registerSyncNowRoutes(app, ctx);
  registerChatRoutes(app, ctx);
  registerCostRoutes(app, ctx);
  registerAdminRoutes(app, ctx);
  registerAdminAiRoutes(app, ctx);
  registerHealthRoutes(app, ctx);
  await app.register(async (scope) => registerIngestRoutes(scope, ctx));
  await app.register(async (scope) => registerOneClickRoutes(scope, ctx));

  return app;
}

function sendHtml(reply: FastifyReply, html: string): FastifyReply {
  return reply.type("text/html; charset=utf-8").send(html);
}

interface MappedError {
  status: number;
  code: ApiError["code"];
  message: string;
  pageTitle: string;
  headers: Record<string, string>;
}

/**
 * Listening on all interfaces in production means a reverse proxy in another container/host is in front. With the
 * default "loopback" trust its X-Forwarded-For is ignored, request.ip is the proxy's address for every client, and
 * every per-IP rate limit (login, TOTP, probes, ingest, one-click) becomes one global bucket.
 */
function warnOnProxyMisconfig(deps: ServerDeps): void {
  const { NODE_ENV, HOST, TRUST_PROXY } = deps.config;
  const loopbackOnly = !TRUST_PROXY || TRUST_PROXY === "loopback" || TRUST_PROXY === "false";
  if (NODE_ENV === "production" && (HOST === "0.0.0.0" || HOST === "::") && loopbackOnly) {
    deps.log.warn(
      { host: HOST, trustProxy: TRUST_PROXY || "loopback", code: "trust_proxy_loopback" },
      "API listens on all interfaces but trusts only loopback proxies: behind a proxy on another address every client shares one rate-limit bucket; set TRUST_PROXY to the proxy's network",
    );
  }
}

/**
 * "loopback" (default), "true", "false", a hop count ("1": trust only the nearest proxy, e.g. Cloud Run's front end,
 * which appends the real client to X-Forwarded-For — a client-sent X-Forwarded-For cannot spoof it), or CIDRs.
 */
export function parseTrustProxy(value: string | undefined): boolean | string | string[] | ((address: string, hop: number) => boolean) {
  if (!value || value === "loopback") return "loopback";
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^\d+$/.test(value.trim())) {
    // proxy-addr's own hop-count rule: hop 0 is the socket peer.
    const hops = Number(value.trim());
    return (_address: string, hop: number) => hop < hops;
  }
  return value.split(",").map((x) => x.trim()).filter(Boolean);
}

function mapError(err: FastifyError | Error): MappedError {
  if (err instanceof HttpError) {
    const pageTitle = err.statusCode === 429 ? "Too many requests" : err.statusCode === 403 ? "Not allowed" : "Something went wrong";
    return { status: err.statusCode, code: err.code, message: err.message, pageTitle, headers: err.headers };
  }
  if (err instanceof ConflictError) {
    return { status: 409, code: "conflict", message: "The task changed in the meantime — refresh the page", pageTitle: "The action was not applied", headers: {} };
  }
  if (err instanceof NotFoundError) return { status: 404, code: "not_found", message: "Not found", pageTitle: "Not found", headers: {} };
  if (err instanceof ValidationError) return { status: 400, code: "invalid", message: "Invalid data", pageTitle: "Invalid request", headers: {} };
  const status = "statusCode" in err && typeof err.statusCode === "number" ? err.statusCode : 500;
  if (status >= 400 && status < 500) {
    const message =
      status === 413 ? "The content is too large" : status === 415 ? "Unsupported content type" : "Invalid request";
    return { status, code: "invalid", message, pageTitle: "Invalid request", headers: {} };
  }
  return { status: 500, code: "internal", message: "Internal error", pageTitle: "Internal error", headers: {} };
}

/** Error identity for logs without the message (messages can embed SQL values or addresses). */
function safeError(err: Error): Record<string, unknown> {
  const codeOf = (e: unknown) => {
    const c = e && typeof e === "object" && "code" in e ? (e as { code?: unknown }).code : undefined;
    return typeof c === "string" ? c : undefined;
  };
  // Stack frames only: messages can span lines (drizzle's "Failed query: …\nparams: …").
  const frames = (err.stack ?? "")
    .split("\n")
    .filter((l) => /^\s*at /.test(l))
    .slice(0, 7)
    .map((l) => l.trim());
  // Wrapped driver errors carry the SQLSTATE on `cause`.
  return { name: err.name, code: codeOf(err) ?? codeOf(err.cause), frames };
}

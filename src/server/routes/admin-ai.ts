import { eq, inArray } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { listModels as defaultListModels } from "../../ai/models.js";
import {
  AI_KEY_ENV,
  AI_KEY_URLS,
  AI_PROVIDER_LABELS,
  AI_PROVIDERS,
  isAiProvider,
  keyLast4,
  MAX_API_KEY_LENGTH,
  MODEL_ID_RE,
  ModelListError,
  type AiModelOption,
  type AiProvider,
} from "../../ai/providers.js";
import { bumpAiSettings, clearExtractorPause, loadAiProviders, loadAiSettings, sealAiKey } from "../../ai/settings.js";
import { aiProviders, appState, users } from "../../db/schema.js";
import { GLOBAL_PAUSE_KEY } from "../../domain/types.js";
import { EARLY_MAIL_BUDGET_FACTOR, isGlobalPauseValue } from "../../engine/pipeline.js";
import { errorCode } from "../../ops/alerts.js";
import type { AdminAi, AdminAiModels, AdminAiProvider, AiProviderId } from "../api-types.js";
import { audit } from "../audit.js";
import { authOf, requireAuth } from "../auth/guard.js";
import type { AppContext } from "../context.js";
import { badRequest, forbidden, HttpError, notFound, parseWith, rateLimited } from "../http.js";

const Provider = z.enum(AI_PROVIDERS);
const ApiKey = z.string().trim().min(8).max(MAX_API_KEY_LENGTH).regex(/^\S+$/);
const ModelsRequest = z.object({ provider: Provider, apiKey: ApiKey });
const Save = z.object({
  provider: z.union([Provider, z.literal("mock")]),
  model: z.string().trim().max(128).nullish(),
  apiKey: ApiKey.optional(),
});

/** The whole listing, all pages. */
const LIST_TIMEOUT_MS = 20_000;

/**
 * Admin → AI (platform admins only): the installation's AI provider, model and keys.
 *
 * A key is write-only. The API lists the provider's models with it once (a free call that also proves the key
 * works), seals it with the credentials public key and forgets it: only the worker, which holds the private key,
 * can open it. No response, log line or audit entry carries a key, its sealed form or a provider's error text
 * (some echo the key); only its last four characters. Every change bumps ai_settings.version, which the worker
 * checks before each drain, and clears a global AI pause the extractor had set, since the change is its fix.
 */
export function registerAdminAiRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, clock, config, sealingKeys, log } = ctx.deps;
  const listModels = ctx.deps.listModels ?? defaultListModels;

  async function requirePlatformAdmin(request: FastifyRequest): Promise<void> {
    const [u] = await db.select({ platformAdmin: users.platformAdmin }).from(users).where(eq(users.id, authOf(request).userId));
    if (!u?.platformAdmin) throw forbidden("Admins only");
  }
  const admin = { preHandler: [requireAuth(ctx, "full"), requirePlatformAdmin] };

  async function view(): Promise<AdminAi> {
    const [settings, rows, pauseRows] = await Promise.all([
      loadAiSettings(db),
      loadAiProviders(db),
      db.select().from(appState).where(eq(appState.key, GLOBAL_PAUSE_KEY)),
    ]);
    const byProvider = new Map(rows.map((r) => [r.provider, r]));
    const setters = [...new Set(rows.map((r) => r.keySetBy).filter((id): id is string => !!id))];
    const names = new Map(setters.length ? (await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, setters))).map((u) => [u.id, u.name]) : []);

    const providers: AdminAiProvider[] = AI_PROVIDERS.map((p) => {
      const r = byProvider.get(p);
      // The worker's environment key wins over a stored one, so it is the one shown.
      const key: AdminAiProvider["key"] = r?.envLast4
        ? { source: "env", last4: r.envLast4 }
        : r?.keySealed && r.keyLast4 && r.keySetAt
          ? { source: "stored", last4: r.keyLast4, setAt: r.keySetAt.toISOString(), setBy: r.keySetBy ? (names.get(r.keySetBy) ?? null) : null }
          : null;
      // After a failed listing (the worker's "failed:" mark) the list shown is older than modelsListedAt: no date.
      const listedAt = r?.modelsFrom?.startsWith("failed:") ? null : (r?.modelsListedAt?.toISOString() ?? null);
      return { id: p, label: AI_PROVIDER_LABELS[p], keyUrl: AI_KEY_URLS[p], key, models: r?.models ?? [], modelsListedAt: listedAt };
    });

    const pause = pauseRows[0];
    const pv = (pause?.value ?? null) as { reason?: unknown; at?: unknown } | null;
    const chosen = settings?.provider;
    return {
      selection: chosen && (chosen === "mock" || isAiProvider(chosen)) ? { provider: chosen as AiProviderId | "mock", model: settings.model, updatedAt: settings.updatedAt.toISOString() } : null,
      providers,
      worker: settings?.workerReport && settings.workerReportAt ? { ...settings.workerReport, at: settings.workerReportAt.toISOString() } : null,
      paused:
        pause && isGlobalPauseValue(pause.value)
          ? { reason: String(pv?.reason ?? "unknown"), since: typeof pv?.at === "string" ? pv.at : pause.updatedAt.toISOString() }
          : null,
      caps: { dailyCalls: config.AI_DAILY_CALL_CAP, dailyUsd: config.AI_DAILY_USD_CAP, earlyFactor: EARLY_MAIL_BUDGET_FACTOR },
    };
  }

  /** List with a pasted key. A failure becomes our own message: the provider's text never leaves this function. */
  async function listWith(provider: AiProvider, apiKey: string): Promise<AiModelOption[]> {
    try {
      return await listModels(provider, apiKey, { timeoutMs: LIST_TIMEOUT_MS });
    } catch (err) {
      const code = err instanceof ModelListError ? err.code : "provider_error";
      log.warn({ provider, code, status: err instanceof ModelListError ? err.status : null, err: err instanceof ModelListError ? undefined : errorCode(err) }, "AI model listing failed");
      const label = AI_PROVIDER_LABELS[provider];
      switch (code) {
        case "key_rejected":
          throw badRequest(`${label} rejected this key.`);
        case "forbidden":
          throw badRequest(`${label} refused this key (no access to models, or a billing or region restriction).`);
        case "rate_limited":
          throw new HttpError(429, "rate_limited", `${label} is limiting requests for this key. Try again in a minute.`);
        case "unreachable":
          throw new HttpError(502, "internal", `Could not reach ${label}. Try again.`);
        default:
          throw new HttpError(502, "internal", `${label} could not list the models for this key. Try again later.`);
      }
    }
  }

  app.get("/api/admin/ai", admin, async (): Promise<AdminAi> => view());

  app.post("/api/admin/ai/models", admin, async (request): Promise<AdminAiModels> => {
    const { userId } = authOf(request);
    const limit = ctx.limiter.take("aiModels", userId);
    if (!limit.ok) throw rateLimited(limit.retryAfterSec);
    const body = parseWith(ModelsRequest, request.body);
    const models = await listWith(body.provider, body.apiKey);
    await audit(db, { userId, event: "admin.ai_models_list", detail: { provider: body.provider, last4: keyLast4(body.apiKey), models: models.length }, ip: request.ip });
    return { models };
  });

  app.put("/api/admin/ai", admin, async (request): Promise<AdminAi> => {
    const { userId } = authOf(request);
    const body = parseWith(Save, request.body);
    const now = clock.now();

    if (body.provider === "mock") {
      const cleared = await db.transaction(async (tx) => {
        await bumpAiSettings(tx, now, userId, { provider: "mock", model: null });
        return clearExtractorPause(tx);
      });
      await audit(db, { userId, event: "admin.ai_select", detail: { provider: "mock" }, ip: request.ip });
      if (cleared) await audit(db, { userId, event: "admin.ai_resume", detail: { error: cleared.error }, ip: request.ip });
      return view();
    }

    const provider = body.provider;
    const label = AI_PROVIDER_LABELS[provider];
    const [row] = await db.select().from(aiProviders).where(eq(aiProviders.provider, provider));
    if (body.apiKey) {
      const limit = ctx.limiter.take("aiModels", userId);
      if (!limit.ok) throw rateLimited(limit.retryAfterSec);
      if (row?.envLast4) throw badRequest(`${label}'s key comes from the server environment (${AI_KEY_ENV[provider]}). Change it there.`);
    }
    // A new key is proven by listing its models before anything is stored.
    const listed = body.apiKey ? await listWith(provider, body.apiKey) : null;
    if (!body.apiKey && !row?.envLast4 && !row?.keySealed) throw badRequest(`Add a key for ${label} first.`);

    const model = body.model?.trim() ?? "";
    if (!model) throw badRequest("Choose a model.");
    const models = listed ?? row?.models ?? [];
    // An environment key the worker has not listed yet: any well-formed id.
    if (models.length ? !models.some((m) => m.id === model) : !MODEL_ID_RE.test(model)) throw badRequest(`${label} did not list this model for the key.`);

    const stored = body.apiKey && listed ? { sealed: sealAiKey(provider, body.apiKey, sealingKeys), last4: keyLast4(body.apiKey) } : null;
    const cleared = await db.transaction(async (tx) => {
      if (stored && listed) {
        const set = {
          keySealed: stored.sealed,
          keyLast4: stored.last4,
          keySetBy: userId,
          keySetAt: now,
          models: listed,
          modelsListedAt: now,
          modelsFrom: `stored:${stored.last4}`,
          updatedAt: now,
        };
        await tx.insert(aiProviders).values({ provider, ...set }).onConflictDoUpdate({ target: aiProviders.provider, set });
      }
      await bumpAiSettings(tx, now, userId, { provider, model });
      return clearExtractorPause(tx);
    });
    if (stored) await audit(db, { userId, event: "admin.ai_key_set", detail: { provider, last4: stored.last4 }, ip: request.ip });
    await audit(db, { userId, event: "admin.ai_select", detail: { provider, model }, ip: request.ip });
    if (cleared) await audit(db, { userId, event: "admin.ai_resume", detail: { error: cleared.error }, ip: request.ip });
    return view();
  });

  app.delete<{ Params: { provider: string } }>("/api/admin/ai/keys/:provider", admin, async (request): Promise<AdminAi> => {
    const { userId } = authOf(request);
    const provider = request.params.provider;
    if (!isAiProvider(provider)) throw notFound("Unknown provider");
    const [row] = await db.select().from(aiProviders).where(eq(aiProviders.provider, provider));
    if (!row?.keySealed) throw notFound("No saved key for this provider");
    const now = clock.now();
    // The list goes with the key, unless the environment key's (the worker keeps that one).
    const keepList = row.modelsFrom?.startsWith("env:") ?? false;
    await db.transaction(async (tx) => {
      await tx
        .update(aiProviders)
        .set({ keySealed: null, keyLast4: null, keySetBy: null, keySetAt: null, ...(keepList ? {} : { models: [], modelsListedAt: null, modelsFrom: null }), updatedAt: now })
        .where(eq(aiProviders.provider, provider));
      await bumpAiSettings(tx, now, userId);
    });
    await audit(db, { userId, event: "admin.ai_key_delete", detail: { provider, last4: row.keyLast4 }, ip: request.ip });
    return view();
  });
}

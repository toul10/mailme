import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { aiProviders, type AiWorkerReport } from "../db/schema.js";
import type { Clock, Extractor, Logger } from "../domain/types.js";
import { AI_KEY_ENV, AI_PROVIDERS, keyLast4, ModelListError, type AiProvider, type ModelLister } from "../ai/providers.js";
import { describeAi, envKeysFrom, resolveAi, type ResolvedAi } from "../ai/resolve.js";
import { aiSettingsVersion, clearUnavailablePause, loadAiProviders, loadAiSettings, openAiKey, writeWorkerReport, type AiProviderRow } from "../ai/settings.js";
import type { SealingKeys } from "../lib/sealed.js";
import { errorCode } from "../ops/alerts.js";

/**
 * The worker's view of Admin → AI. Before every drain, `refresh()` reads one number (ai_settings.version); when it
 * moved, it reloads the choice and the keys, opens the stored key with the private key, and rebuilds the extractor.
 * So a drain never runs with a key or model the admin has replaced (the API bumps the version in the same
 * transaction that clears an extractor pause).
 *
 * It also reports what it runs (ai_settings.worker_report: on change, plus a heartbeat) and keeps ai_providers
 * current for what the API cannot do: see this process's environment keys (their last four characters) and open a
 * stored key, so the model list of the key in use is reloaded here.
 */

export const AI_REPORT_HEARTBEAT_MS = 5 * 60_000;
/** A key's model list is reloaded after this long (new models appear), or at once when the key changes. */
export const MODELS_MAX_AGE_MS = 24 * 3600_000;
/** After a failed listing the same key is tried again this much later: a bad key is not called on every tick. */
export const MODELS_RETRY_MS = 3600_000;
const LIST_TIMEOUT_MS = 20_000;

export type AiDescription = AiWorkerReport;

export interface AiRuntimeDeps {
  db: Db;
  config: Config;
  log: Logger;
  clock: Clock;
  env: NodeJS.ProcessEnv;
  /** The sealing keys with the private key; throws where it is not configured. */
  privateKeys: () => SealingKeys;
  listModels: ModelLister;
  createExtractor: (config: Config, ai: ResolvedAi) => Extractor;
  /** A fixed extractor (tests): never rebuilt, the rest (reports, environment keys) still runs. */
  fixedExtractor?: Extractor | null;
  /**
   * A CLI process (lazy keys): it follows Admin → AI but writes nothing. The report, the environment keys and the
   * pause it lifts are the worker's, whose environment and private key may differ from a shell's.
   */
  readOnly?: boolean;
}

export interface AiRuntime {
  /** The extractor for the next message (AI_MODE and the environment alone until the first refresh). */
  readonly extractor: Extractor;
  /** What runs, without the key; null before the first refresh. */
  readonly current: AiDescription | null;
  /** Single-flight: concurrent drains share one refresh. */
  refresh(): Promise<void>;
}

export function createAiRuntime(d: AiRuntimeDeps): AiRuntime {
  let extractor: Extractor | null = d.fixedExtractor ?? null;
  let version: number | null = null;
  let current: AiDescription | null = null;
  let reported = "";
  let reportedAt = -Infinity;
  let inflight: Promise<void> | null = null;

  async function rebuild(now: Date): Promise<void> {
    const [settings, rows] = await Promise.all([loadAiSettings(d.db), loadAiProviders(d.db)]);
    const byProvider = new Map(rows.map((r) => [r.provider, r]));
    const envKeys = envKeysFrom(d.env, AI_KEY_ENV);
    const resolved = resolveAi({
      aiMode: d.config.AI_MODE,
      defaultModel: d.config.AI_MODEL,
      envKeys,
      selection: settings ? { provider: settings.provider, model: settings.model } : null,
      storedKey: (p) => {
        const sealed = byProvider.get(p)?.keySealed;
        return sealed ? openAiKey(p, sealed, d.privateKeys()) : null;
      },
    });
    if (!d.fixedExtractor) extractor = d.createExtractor(d.config, resolved);
    version = settings?.version ?? 0;
    current = describeAi(resolved);
    d.log.info({ ai: current, version }, "AI extractor ready");
    // AI can run again without a save in Admin → AI (an environment key restored, the private key fixed): the pause
    // the unavailable extractor set ends here. Any other pause (a rejected key, a code error) stays.
    if (d.readOnly) return;
    if (resolved.kind !== "unavailable" && (await clearUnavailablePause(d.db))) d.log.info({ ai: current }, "AI can run again: the global pause it caused is lifted");
    await syncKeys(envKeys, byProvider, now);
  }

  /**
   * Per provider: record the environment key's last four characters, and reload the model list of the key in use
   * (the environment's wins, as in resolveAi; else the stored one) when the key changed or the list is a day old.
   * modelsFrom names the key a list came from ("env:<last4>", "stored:<last4>"); "failed:<that>" marks a failed
   * listing, retried after MODELS_RETRY_MS. A list whose key is gone is dropped.
   * AI_MODE=mock is the kill switch: no provider is called at all, not even to list models.
   */
  async function syncKeys(envKeys: Partial<Record<AiProvider, string>>, rows: Map<AiProvider, AiProviderRow>, now: Date): Promise<void> {
    const mayCall = d.config.AI_MODE !== "mock";
    for (const p of AI_PROVIDERS) {
      const row = rows.get(p);
      const envKey = envKeys[p] ?? null;
      const envLast4 = envKey ? keyLast4(envKey) : null;
      const sealed = row?.keySealed && row.keyLast4 ? row.keySealed : null;
      const from = envKey ? `env:${envLast4}` : sealed ? `stored:${row!.keyLast4}` : null;
      const failedFrom = from ? `failed:${from}` : null;
      const tried = row?.modelsFrom ?? null;
      const age = now.getTime() - (row?.modelsListedAt?.getTime() ?? Number.NEGATIVE_INFINITY);
      const due = mayCall && !!from && (tried === from ? age >= MODELS_MAX_AGE_MS : tried === failedFrom ? age >= MODELS_RETRY_MS : true);

      let listed: Partial<typeof aiProviders.$inferInsert> = {};
      if (due) {
        let key: string | null = envKey;
        if (!key) {
          try {
            key = openAiKey(p, sealed!, d.privateKeys());
          } catch (err) {
            d.log.warn({ provider: p, code: errorCode(err) }, "could not open the stored AI key");
          }
        }
        if (key) {
          try {
            listed = { models: await d.listModels(p, key, { timeoutMs: LIST_TIMEOUT_MS }), modelsListedAt: now, modelsFrom: from };
          } catch (err) {
            d.log.warn({ provider: p, key: envKey ? "env" : "stored", code: err instanceof ModelListError ? err.code : errorCode(err) }, "could not list the models of the AI key");
            // Another key's list is no longer valid; this key's own older list stays.
            listed = { ...(tried === from || tried === failedFrom ? {} : { models: [] }), modelsListedAt: now, modelsFrom: failedFrom };
          }
        }
      } else if (!from && tried !== null) {
        listed = { models: [], modelsListedAt: null, modelsFrom: null };
      }
      if (Object.keys(listed).length === 0 && (row?.envLast4 ?? null) === envLast4) continue;
      await d.db
        .insert(aiProviders)
        .values({ provider: p, envLast4, updatedAt: now, ...listed })
        .onConflictDoUpdate({ target: aiProviders.provider, set: { envLast4, updatedAt: now, ...listed } });
    }
  }

  async function report(now: Date, force: boolean): Promise<void> {
    if (!current || d.readOnly) return;
    const key = JSON.stringify(current);
    if (!force && key === reported && now.getTime() - reportedAt < AI_REPORT_HEARTBEAT_MS) return;
    await writeWorkerReport(d.db, current, now);
    reported = key;
    reportedAt = now.getTime();
  }

  async function refreshOnce(): Promise<void> {
    const now = d.clock.now();
    const v = await aiSettingsVersion(d.db);
    const changed = version === null || v !== version;
    if (changed) await rebuild(now);
    else if (!d.readOnly && now.getTime() - reportedAt >= AI_REPORT_HEARTBEAT_MS) {
      // Heartbeat: also the moment to notice a model list getting old (a long-running worker).
      const rows = new Map((await loadAiProviders(d.db)).map((r) => [r.provider, r]));
      await syncKeys(envKeysFrom(d.env, AI_KEY_ENV), rows, now);
    }
    // After a change at once: Admin → AI shows "applies on the next run" until the report is newer than the save.
    await report(now, changed);
  }

  return {
    get extractor() {
      // Before the first refresh (CLI commands that never drain): AI_MODE and the environment alone.
      extractor ??= d.createExtractor(d.config, resolveAi({ aiMode: d.config.AI_MODE, defaultModel: d.config.AI_MODEL, envKeys: envKeysFrom(d.env, AI_KEY_ENV), selection: null, storedKey: () => null }));
      return extractor;
    },
    get current() {
      return current;
    },
    refresh() {
      inflight ??= refreshOnce().finally(() => {
        inflight = null;
      });
      return inflight;
    },
  };
}

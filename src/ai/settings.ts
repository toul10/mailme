import { and, eq, sql } from "drizzle-orm";
import type { DbOrTx } from "../db/client.js";
import { aiProviders, aiSettings, appState, type AiWorkerReport } from "../db/schema.js";
import { GLOBAL_PAUSE_KEY } from "../domain/types.js";
import { open, seal, type SealingKeys } from "../lib/sealed.js";
import type { AiProvider } from "./providers.js";
import { AI_UNAVAILABLE_ERROR_PREFIX } from "./resolve.js";

/**
 * Database side of Admin → AI, shared by the API (stores, never opens) and the worker (opens, reports).
 * Tables: ai_settings (one row, id "global") and ai_providers (one row per provider).
 */

export const AI_SETTINGS_ID = "global";

/** Additional data bound to a sealed AI key: a sealed key moved to another provider's row does not open. */
export const aiKeyAad = (provider: AiProvider) => `ai-key:${provider}`;

export function sealAiKey(provider: AiProvider, key: string, keys: Pick<SealingKeys, "kid" | "publicKey">): string {
  return seal(key, keys, aiKeyAad(provider));
}

export function openAiKey(provider: AiProvider, sealed: string, keys: SealingKeys): string {
  return open(sealed, keys, aiKeyAad(provider));
}

export type AiSettingsRow = typeof aiSettings.$inferSelect;
export type AiProviderRow = typeof aiProviders.$inferSelect;

export async function loadAiSettings(db: DbOrTx): Promise<AiSettingsRow | null> {
  const [row] = await db.select().from(aiSettings).where(eq(aiSettings.id, AI_SETTINGS_ID));
  return row ?? null;
}

export async function loadAiProviders(db: DbOrTx): Promise<AiProviderRow[]> {
  return db.select().from(aiProviders);
}

/** The cheap per-drain check: the settings version (0 before anything was saved). */
export async function aiSettingsVersion(db: DbOrTx): Promise<number> {
  const [row] = await db.select({ version: aiSettings.version }).from(aiSettings).where(eq(aiSettings.id, AI_SETTINGS_ID));
  return row?.version ?? 0;
}

/**
 * Bump the version (the worker rebuilds its extractor when it moves), optionally setting the choice.
 * Call inside the transaction that made the change.
 */
export async function bumpAiSettings(tx: DbOrTx, now: Date, by: string | null, choice?: { provider: string; model: string | null }): Promise<void> {
  const set = { version: sql`${aiSettings.version} + 1`, updatedAt: now, updatedBy: by, ...(choice ? { provider: choice.provider, model: choice.model } : {}) };
  await tx
    .insert(aiSettings)
    .values({ id: AI_SETTINGS_ID, version: 1, updatedAt: now, updatedBy: by, ...(choice ? { provider: choice.provider, model: choice.model } : {}) })
    .onConflictDoUpdate({ target: aiSettings.id, set });
}

/**
 * Clear the global AI pause when the extractor set it (a rejected key, billing, an unknown model): a new key or
 * choice is the fix. A pause after an internal error stays (`ai:resume` after the code is fixed).
 * Returns the cleared pause's error code, or null.
 */
export async function clearExtractorPause(tx: DbOrTx): Promise<{ error: string | null } | null> {
  const [row] = await tx.select({ value: appState.value }).from(appState).where(eq(appState.key, GLOBAL_PAUSE_KEY));
  const v = row?.value as { reason?: unknown; error?: unknown } | null | undefined;
  if (!row || v?.reason !== "extractor") return null;
  await tx.delete(appState).where(eq(appState.key, GLOBAL_PAUSE_KEY));
  return { error: typeof v.error === "string" ? v.error : null };
}

export async function writeWorkerReport(db: DbOrTx, report: AiWorkerReport, now: Date): Promise<void> {
  await db
    .insert(aiSettings)
    .values({ id: AI_SETTINGS_ID, workerReport: report, workerReportAt: now })
    .onConflictDoUpdate({ target: aiSettings.id, set: { workerReport: report, workerReportAt: now } });
}

/**
 * Lift the global pause an unavailable extractor set (src/ai/unavailable.ts), in one statement so a pause set since
 * for another reason stays. The worker calls it when AI can run again without anyone saving in Admin → AI (an
 * environment key restored, the private key fixed). Returns whether a pause was lifted.
 */
export async function clearUnavailablePause(db: DbOrTx): Promise<boolean> {
  const rows = await db
    .delete(appState)
    .where(and(eq(appState.key, GLOBAL_PAUSE_KEY), sql`${appState.value}->>'reason' = 'extractor'`, sql`starts_with(${appState.value}->>'error', ${AI_UNAVAILABLE_ERROR_PREFIX})`))
    .returning({ key: appState.key });
  return rows.length > 0;
}

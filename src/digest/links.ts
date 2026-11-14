import { createHash } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { actionNonces } from "../db/schema.js";
import { signActionToken, verifyActionToken, type ActionTokenPayload } from "../lib/crypto.js";
import type { LinkFactory } from "./model.js";

export interface LinkDeps {
  db: Db;
  baseUrl: string;
  linkSecret: string;
  now: Date;
  /** Link lifetime (default 7 days). */
  ttlDays?: number;
}

export type LinkAction = Parameters<LinkFactory["action"]>[1];
export const LINK_ACTIONS: readonly LinkAction[] = ["complete", "dismiss", "snooze", "confirm", "reopen", "still_valid"];
export const DEFAULT_LINK_TTL_DAYS = 7;
/** Hard ceiling: one-click links never live longer than 7 days. */
export const MAX_LINK_TTL_DAYS = 7;
const MAX_TOKEN_LENGTH = 2048;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Single-use key of a token. The token payload has no nonce field (contract: ActionTokenPayload), so the
 * nonce row is keyed by the hash of the whole signed token.
 */
export function tokenNonce(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("base64url");
}

export function appBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

export function createLinkFactory(deps: LinkDeps, userId: string, digestId: string | null): LinkFactory {
  const base = appBaseUrl(deps.baseUrl);
  const ttlDays = Math.min(Math.max(deps.ttlDays ?? DEFAULT_LINK_TTL_DAYS, 0), MAX_LINK_TTL_DAYS);
  const exp = Math.floor(deps.now.getTime() / 1000) + Math.floor(ttlDays * 86_400);
  const issued = new Map<string, Promise<string>>();

  return {
    action(taskId, action) {
      const key = `${taskId}|${action}`;
      const known = issued.get(key);
      if (known) return known;
      const p = (async () => {
        // "reopen" / "still_valid" are not in ActionTokenPayload["a"] yet (contract request); the signature covers any string.
        const payload: ActionTokenPayload = { t: taskId, a: action as ActionTokenPayload["a"], u: userId, exp };
        const token = signActionToken(payload, deps.linkSecret);
        await deps.db
          .insert(actionNonces)
          .values({ nonce: tokenNonce(token), userId, taskId, action, digestId, expiresAt: new Date(exp * 1000) })
          .onConflictDoNothing();
        return `${base}/a/${token}`;
      })();
      issued.set(key, p);
      p.catch(() => issued.delete(key));
      return p;
    },
    task: (taskId) => spaTaskUrl(base, taskId),
    list: (tab) => spaListUrl(base, tab),
  };
}

/** Links for previews (CLI `digest:preview`, dry runs): signed but never stored, so they cannot be redeemed. */
export function createPreviewLinkFactory(baseUrl: string): LinkFactory {
  const base = appBaseUrl(baseUrl);
  return {
    action: async (taskId, action) => `${base}/a/preview-${encodeURIComponent(action)}-${encodeURIComponent(taskId)}`,
    task: (taskId) => spaTaskUrl(base, taskId),
    list: (tab) => spaListUrl(base, tab),
  };
}

/** SPA routes (web/src hash router): #/tasks/:id and #/?tab=… (todo is the default tab). */
function spaTaskUrl(base: string, taskId: string): string {
  return `${base}/#/tasks/${encodeURIComponent(taskId)}`;
}

function spaListUrl(base: string, tab: "todo" | "waiting" | "all"): string {
  return tab === "todo" ? `${base}/#/` : `${base}/#/?tab=${encodeURIComponent(tab)}`;
}

/** Verify token + single-use nonce. Returns the payload or null (expired, used, forged). Marks used on success when consume=true. */
export async function redeemActionToken(db: Db, linkSecret: string, token: string, now: Date, consume: boolean): Promise<{ userId: string; taskId: string; action: string; nonce: string } | null> {
  if (typeof token !== "string" || !token || token.length > MAX_TOKEN_LENGTH) return null;
  const payload = verifyActionToken(token, linkSecret, Math.floor(now.getTime() / 1000));
  if (!payload) return null;
  const { t: taskId, u: userId, a: action } = payload as { t: unknown; u: unknown; a: unknown };
  if (typeof taskId !== "string" || typeof userId !== "string" || typeof action !== "string") return null;
  if (!UUID.test(taskId) || !UUID.test(userId) || !(LINK_ACTIONS as readonly string[]).includes(action)) return null;

  const nonce = tokenNonce(token);
  const match = and(
    eq(actionNonces.nonce, nonce),
    isNull(actionNonces.usedAt),
    gt(actionNonces.expiresAt, now),
    eq(actionNonces.userId, userId),
    eq(actionNonces.taskId, taskId),
    eq(actionNonces.action, action),
  );
  const rows = consume
    ? await db.update(actionNonces).set({ usedAt: now }).where(match).returning({ nonce: actionNonces.nonce })
    : await db.select({ nonce: actionNonces.nonce }).from(actionNonces).where(match);
  if (!rows.length) return null;
  return { userId, taskId, action, nonce };
}

import { and, eq, lt, or } from "drizzle-orm";
import type { FastifyReply } from "fastify";
import type { Db } from "../../db/client.js";
import { organizations, sessions, trustedDevices, users } from "../../db/schema.js";
import { randomToken } from "../../lib/crypto.js";
import { sha256Hex } from "../secrets.js";

/** Session lifetimes. A password-only (pre-MFA) session is short-lived and can only finish the MFA step. */
export const PRE_MFA_TTL_MS = 15 * 60_000;
export const SESSION_TTL_MS = 7 * 24 * 3600_000;
export const SESSION_IDLE_MS = 48 * 3600_000;
export const TRUSTED_DEVICE_TTL_MS = 30 * 24 * 3600_000;
/** lastSeenAt is written at most this often. */
const TOUCH_EVERY_MS = 5 * 60_000;

export interface CookieConfig {
  session: string;
  device: string;
  secure: boolean;
}

/**
 * `__Host-` cookies require Secure, so plain-http localhost development uses unprefixed names without Secure.
 * Any other base URL (https, or a non-local http host) gets Secure `__Host-` cookies.
 */
export function cookieConfig(appBaseUrl: string): CookieConfig {
  const url = new URL(appBaseUrl);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const secure = !(url.protocol === "http:" && local);
  return secure ? { session: "__Host-mm", device: "__Host-mm-td", secure } : { session: "mm", device: "mm-td", secure };
}

function cookieOptions(cfg: CookieConfig, maxAgeSec?: number) {
  return { path: "/", httpOnly: true, secure: cfg.secure, sameSite: "lax" as const, ...(maxAgeSec ? { maxAge: maxAgeSec } : {}) };
}

export function setSessionCookie(reply: FastifyReply, cfg: CookieConfig, token: string, ttlMs: number): void {
  reply.setCookie(cfg.session, token, cookieOptions(cfg, Math.floor(ttlMs / 1000)));
}

export function clearSessionCookie(reply: FastifyReply, cfg: CookieConfig): void {
  reply.clearCookie(cfg.session, cookieOptions(cfg));
}

export function setDeviceCookie(reply: FastifyReply, cfg: CookieConfig, token: string): void {
  reply.setCookie(cfg.device, token, cookieOptions(cfg, Math.floor(TRUSTED_DEVICE_TTL_MS / 1000)));
}

/** Authenticated request context (from the session cookie). */
export interface AuthContext {
  sessionId: string;
  userId: string;
  orgId: string;
  role: "admin" | "member";
  mfaVerified: boolean;
  csrfToken: string;
  timezone: string;
  holySpiritHoliday: boolean;
}

export interface NewSession {
  token: string;
  id: string;
  csrfToken: string;
  ttlMs: number;
}

/** Insert a session row. The cookie carries the token; the DB stores only sha256(token). */
export async function createSession(db: Db, userId: string, mfaVerified: boolean, now: Date, csrfToken = randomToken(24)): Promise<NewSession> {
  const token = randomToken(32);
  const id = sha256Hex(token);
  const ttlMs = mfaVerified ? SESSION_TTL_MS : PRE_MFA_TTL_MS;
  await db.insert(sessions).values({ id, userId, mfaVerified, csrfToken, expiresAt: new Date(now.getTime() + ttlMs), lastSeenAt: now, createdAt: now });
  return { token, id, csrfToken, ttlMs };
}

export async function deleteSessionByToken(db: Db, token: string | undefined): Promise<void> {
  if (token) await db.delete(sessions).where(eq(sessions.id, sha256Hex(token)));
}

/** Drop a user's expired/idle sessions (housekeeping on login; retention also purges). */
export async function purgeExpiredSessions(db: Db, userId: string, now: Date): Promise<void> {
  await db
    .delete(sessions)
    .where(and(eq(sessions.userId, userId), or(lt(sessions.expiresAt, now), lt(sessions.lastSeenAt, new Date(now.getTime() - SESSION_IDLE_MS)))));
}

/** Resolve a session token; null when unknown, expired, idle too long or the user is disabled. */
export async function loadSession(db: Db, token: string | undefined, now: Date): Promise<AuthContext | null> {
  if (!token || token.length > 200) return null;
  const id = sha256Hex(token);
  const [row] = await db
    .select({
      id: sessions.id,
      userId: sessions.userId,
      mfaVerified: sessions.mfaVerified,
      csrfToken: sessions.csrfToken,
      expiresAt: sessions.expiresAt,
      lastSeenAt: sessions.lastSeenAt,
      orgId: users.orgId,
      role: users.role,
      disabledAt: users.disabledAt,
      timezone: organizations.timezone,
      holySpiritHoliday: organizations.holySpiritHoliday,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .innerJoin(organizations, eq(organizations.id, users.orgId))
    .where(eq(sessions.id, id))
    .limit(1);
  if (!row) return null;
  const t = now.getTime();
  if (row.disabledAt || row.expiresAt.getTime() <= t || row.lastSeenAt.getTime() + SESSION_IDLE_MS <= t) {
    await db.delete(sessions).where(eq(sessions.id, id));
    return null;
  }
  if (t - row.lastSeenAt.getTime() >= TOUCH_EVERY_MS) {
    await db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, id));
  }
  return {
    sessionId: row.id,
    userId: row.userId,
    orgId: row.orgId,
    role: row.role,
    mfaVerified: row.mfaVerified,
    csrfToken: row.csrfToken,
    timezone: row.timezone,
    holySpiritHoliday: row.holySpiritHoliday,
  };
}

/**
 * Replace the session with a fresh id after privilege elevation (MFA passed). The CSRF token is carried over:
 * the SPA keeps the one it got at login.
 */
export async function elevateSession(db: Db, auth: AuthContext, now: Date): Promise<NewSession> {
  const next = await createSession(db, auth.userId, true, now, auth.csrfToken);
  await db.delete(sessions).where(eq(sessions.id, auth.sessionId));
  return next;
}

export async function createTrustedDevice(db: Db, userId: string, now: Date): Promise<string> {
  const token = randomToken(32);
  await db.insert(trustedDevices).values({ id: sha256Hex(token), userId, expiresAt: new Date(now.getTime() + TRUSTED_DEVICE_TTL_MS), createdAt: now });
  return token;
}

export async function isTrustedDevice(db: Db, token: string | undefined, userId: string, now: Date): Promise<boolean> {
  if (!token || token.length > 200) return false;
  const [row] = await db.select().from(trustedDevices).where(eq(trustedDevices.id, sha256Hex(token))).limit(1);
  return !!row && row.userId === userId && row.expiresAt.getTime() > now.getTime();
}

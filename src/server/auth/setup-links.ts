/**
 * One-time account setup links ("activation links"). A platform admin creates an account (or asks for a new
 * link when someone lost their password or phone) and sends the link to that person; nobody else ever chooses or
 * sees the password. Using the link sets the password, resets TOTP (enrolment again at the next step) and ends
 * every other session of the account.
 *
 * The token (256 bits, base64url) travels in the URL fragment (#/setup?t=…), so it never reaches server logs or a
 * Referer; the SPA posts it in a JSON body. Only its sha256 is stored, with an expiry.
 */
import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { users } from "../../db/schema.js";

export const SETUP_LINK_TTL_MS = 72 * 3_600_000;

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function hashSetupToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function setupUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/#/setup?t=${token}`;
}

/** Issues a fresh link for the account (any earlier link stops working). */
export async function issueSetupLink(db: Db, userId: string, now: Date, baseUrl: string): Promise<{ url: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + SETUP_LINK_TTL_MS);
  await db.update(users).set({ setupTokenHash: hashSetupToken(token), setupExpiresAt: expiresAt }).where(eq(users.id, userId));
  return { url: setupUrl(baseUrl, token), expiresAt };
}

/** The account a still-valid token belongs to (not expired, account not disabled), else null. */
export async function findBySetupToken(db: Db, token: string, now: Date) {
  if (!TOKEN_RE.test(token)) return null;
  const [user] = await db
    .select()
    .from(users)
    .where(and(eq(users.setupTokenHash, hashSetupToken(token)), gt(users.setupExpiresAt, now), isNull(users.disabledAt)))
    .limit(1);
  return user ?? null;
}

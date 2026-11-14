import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { mailboxes, organizations, users } from "../../db/schema.js";
import { CC_POLICIES, forbiddenMute, normalizeEntries, normalizeProfile, parseEntry, PREFERENCE_LIMITS } from "../../domain/preferences.js";
import type { Preferences } from "../api-types.js";
import { authOf, requireAuth } from "../auth/guard.js";
import type { AppContext } from "../context.js";
import { badRequest, notFound, parseWith } from "../http.js";

const Entry = z.string().max(PREFERENCE_LIMITS.entryChars * 2);

const PreferencesBody = z.object({
  important: z.array(Entry).max(PREFERENCE_LIMITS.entries * 2),
  muted: z.array(Entry).max(PREFERENCE_LIMITS.entries * 2),
  ccPolicy: z.enum(CC_POLICIES),
  profile: z.string().max(PREFERENCE_LIMITS.profileChars * 4).nullable(),
});

const MuteBody = z.object({ entry: Entry });

/**
 * "What matters to me" (src/domain/preferences.ts): the session user's own rules. They take effect on the next
 * message (muted, Cc policy, profile) or the next list load (important). Nothing here reaches other users.
 */
export function registerPreferenceRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx.deps;
  const full = { preHandler: requireAuth(ctx, "full") };

  async function own(userId: string, orgId: string): Promise<Preferences["own"]> {
    const [org] = await db.select({ internalDomains: organizations.internalDomains }).from(organizations).where(eq(organizations.id, orgId));
    const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
    const mbs = await db.select({ address: mailboxes.address, aliases: mailboxes.aliases }).from(mailboxes).where(eq(mailboxes.userId, userId));
    const addresses = [...new Set([user?.email ?? "", ...mbs.flatMap((m) => [m.address, ...m.aliases])].map((a) => a.trim().toLowerCase()).filter(Boolean))];
    return { internalDomains: (org?.internalDomains ?? []).map((d) => d.toLowerCase()), addresses };
  }

  async function load(userId: string, orgId: string): Promise<Preferences> {
    const [u] = await db
      .select({ important: users.importantSenders, muted: users.mutedSenders, ccPolicy: users.ccPolicy, profile: users.profileNote })
      .from(users)
      .where(eq(users.id, userId));
    if (!u) throw notFound();
    return { important: u.important, muted: u.muted, ccPolicy: u.ccPolicy, profile: u.profile, own: await own(userId, orgId) };
  }

  async function save(userId: string, orgId: string, next: { important: string[]; muted: string[]; ccPolicy: Preferences["ccPolicy"]; profile: string | null }): Promise<Preferences> {
    const important = normalizeEntries(next.important, "important");
    if (!important.ok) throw badRequest(`Important: “${important.entry.trim()}” — ${important.error}`);
    const muted = normalizeEntries(next.muted, "muted");
    if (!muted.ok) throw badRequest(`Ignore: “${muted.entry.trim()}” — ${muted.error}`);
    const bad = forbiddenMute(muted.values, await own(userId, orgId));
    if (bad) throw badRequest(`“${bad}” is your own address or your company's (colleagues): it can't be ignored.`);
    const profile = next.profile === null ? null : next.profile.trim();
    if (profile && profile.length > PREFERENCE_LIMITS.profileChars) throw badRequest(`The description can be at most ${PREFERENCE_LIMITS.profileChars} characters.`);
    await db
      .update(users)
      .set({ importantSenders: important.values, mutedSenders: muted.values, ccPolicy: next.ccPolicy, profileNote: normalizeProfile(profile) })
      .where(eq(users.id, userId));
    return load(userId, orgId);
  }

  app.get("/api/preferences", full, async (request) => {
    const auth = authOf(request);
    return load(auth.userId, auth.orgId);
  });

  app.put("/api/preferences", full, async (request) => {
    const auth = authOf(request);
    const body = parseWith(PreferencesBody, request.body);
    return save(auth.userId, auth.orgId, body);
  });

  // "Ignore email from …" straight from a dismissal: adds one entry, keeps everything else.
  app.post("/api/preferences/muted", full, async (request) => {
    const auth = authOf(request);
    const { entry } = parseWith(MuteBody, request.body);
    const parsed = parseEntry(entry, "muted");
    if (!parsed.ok) throw badRequest(parsed.error);
    const cur = await load(auth.userId, auth.orgId);
    if (cur.muted.includes(parsed.entry.value)) return cur;
    return save(auth.userId, auth.orgId, { important: cur.important, muted: [...cur.muted, parsed.entry.value], ccPolicy: cur.ccPolicy, profile: cur.profile });
  });
}

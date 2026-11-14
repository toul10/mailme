import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { users } from "../../db/schema.js";
import { normalizeRules } from "../../domain/rules.js";
import type { MailRulesView } from "../api-types.js";
import { authOf, requireAuth } from "../auth/guard.js";
import type { AppContext } from "../context.js";
import { notFound, parseWith } from "../http.js";

const ToggleBody = z.object({ enabled: z.boolean() });

/**
 * "Rules" (src/domain/rules.ts): the session user's own mail rules. The list itself is written by
 * `pnpm cli rules:import` (docs/rules/README.md); here it is read, and single rules are switched on or off.
 * Kept apart from /api/preferences, whose PUT replaces that whole object.
 */
export function registerRuleRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx.deps;
  const full = { preHandler: requireAuth(ctx, "full") };

  async function stored(userId: string): Promise<unknown[]> {
    const [u] = await db.select({ mailRules: users.mailRules }).from(users).where(eq(users.id, userId));
    if (!u) throw notFound();
    return Array.isArray(u.mailRules) ? (u.mailRules as unknown[]) : [];
  }

  app.get("/api/rules", full, async (request): Promise<MailRulesView> => normalizeRules(await stored(authOf(request).userId)));

  app.patch<{ Params: { id: string } }>("/api/rules/:id", full, async (request): Promise<MailRulesView> => {
    const auth = authOf(request);
    const { enabled } = parseWith(ToggleBody, request.body);
    const raw = await stored(auth.userId);
    const id = request.params.id.trim().toLowerCase();
    if (!normalizeRules(raw).rules.some((r) => r.id === id)) throw notFound();
    // Only that rule's flag changes; the stored list (unusable rules included) is otherwise kept as imported.
    const next = raw.map((r) => (r && typeof r === "object" && String((r as { id?: unknown }).id ?? "").trim().toLowerCase() === id ? { ...(r as object), enabled } : r));
    await db.update(users).set({ mailRules: next as never }).where(eq(users.id, auth.userId));
    return normalizeRules(next);
  });
}

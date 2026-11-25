import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { mailboxes, organizations, users } from "../../db/schema.js";
import { normalizeRules } from "../../domain/rules.js";
import { removeSupplier, upsertSuppliers } from "../../domain/suppliers.js";
import type { MailRulesView } from "../api-types.js";
import { authOf, requireAuth } from "../auth/guard.js";
import type { AppContext } from "../context.js";
import { badRequest, notFound, parseWith } from "../http.js";
import { SuppliersBody } from "../validation.js";

const ToggleBody = z.object({ enabled: z.boolean() });

/**
 * "Rules" (src/domain/rules.ts): the session user's own mail rules. The list itself is written by
 * `pnpm cli rules:import` (docs/rules/README.md); here it is read, and single rules are switched on or off.
 * The suppliers ("Suppliers", kind "supplier") are the one kind the user also writes here: added, given other
 * senders, removed. Every other stored rule stays exactly as imported.
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

  /**
   * Reads the user's stored list, rewrites it and saves it as one step, with the user's row locked: two changes made
   * at once (two tabs, a double click) cannot lose one another. `change` refuses by throwing; nothing is saved then.
   */
  async function rewrite(userId: string, change: (list: unknown[]) => unknown[]): Promise<MailRulesView> {
    const next = await db.transaction(async (tx) => {
      const [u] = await tx.select({ mailRules: users.mailRules }).from(users).where(eq(users.id, userId)).for("update");
      if (!u) throw notFound();
      const list = change(Array.isArray(u.mailRules) ? (u.mailRules as unknown[]) : []);
      await tx.update(users).set({ mailRules: list as never }).where(eq(users.id, userId));
      return list;
    });
    return normalizeRules(next);
  }

  app.get("/api/rules", full, async (request): Promise<MailRulesView> => normalizeRules(await stored(authOf(request).userId)));

  app.patch<{ Params: { id: string } }>("/api/rules/:id", full, async (request): Promise<MailRulesView> => {
    const auth = authOf(request);
    const { enabled } = parseWith(ToggleBody, request.body);
    const id = request.params.id.trim().toLowerCase();
    return rewrite(auth.userId, (raw) => {
      if (!normalizeRules(raw).rules.some((r) => r.id === id)) throw notFound();
      // Only that rule's flag changes; the stored list (unusable rules included) is otherwise kept as imported.
      return raw.map((r) => (r && typeof r === "object" && String((r as { id?: unknown }).id ?? "").trim().toLowerCase() === id ? { ...(r as object), enabled } : r));
    });
  });

  /** The user's own addresses and the organization's domains: none of them can be a supplier's sender. */
  async function own(userId: string, orgId: string): Promise<{ addresses: string[]; internalDomains: string[] }> {
    const [org] = await db.select({ internalDomains: organizations.internalDomains }).from(organizations).where(eq(organizations.id, orgId));
    const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
    const mbs = await db.select({ address: mailboxes.address, aliases: mailboxes.aliases }).from(mailboxes).where(eq(mailboxes.userId, userId));
    const addresses = [...new Set([user?.email ?? "", ...mbs.flatMap((m) => [m.address, ...m.aliases])].map((a) => a.trim().toLowerCase()).filter(Boolean))];
    return { addresses, internalDomains: (org?.internalDomains ?? []).map((d) => d.toLowerCase()) };
  }

  // "Suppliers": write suppliers into the user's own list (a new one, or other senders for one that exists).
  app.put("/api/rules/suppliers", full, async (request): Promise<MailRulesView> => {
    const auth = authOf(request);
    const body = parseWith(SuppliersBody, request.body);
    const mine = await own(auth.userId, auth.orgId);
    return rewrite(auth.userId, (raw) => {
      const res = upsertSuppliers(raw, body.suppliers, { mode: body.mode, own: mine });
      if (!res.ok) throw badRequest(res.error);
      return res.next;
    });
  });

  app.delete<{ Params: { id: string } }>("/api/rules/suppliers/:id", full, async (request): Promise<MailRulesView> => {
    const auth = authOf(request);
    return rewrite(auth.userId, (raw) => {
      const next = removeSupplier(raw, request.params.id);
      if (!next) throw notFound();
      return next;
    });
  });
}

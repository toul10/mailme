import { asc, eq, inArray, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { IANAZone } from "luxon";
import { z } from "zod";
import { companyDomains, mailboxes, organizations, sessions, trustedDevices, users } from "../../db/schema.js";
import { purgeAccount, stopAccount } from "../../ops/delete-account.js";
import type { AdminMailbox, AdminOrg, AdminOverview, AdminSetupLink, AdminUser, AdminUserCreated, AdminUserDeleted } from "../api-types.js";
import { audit } from "../audit.js";
import { authOf, requireAuth } from "../auth/guard.js";
import { issueSetupLink } from "../auth/setup-links.js";
import type { AppContext } from "../context.js";
import { badRequest, conflict, forbidden, notFound, parseWith, uuidParam } from "../http.js";

const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const Domains = z.array(z.string().max(253)).max(20);
const OrgCreate = z.object({ name: z.string().trim().min(1).max(120), domains: Domains, timezone: z.string().max(64).optional() });
const OrgUpdate = z.object({ name: z.string().trim().min(1).max(120).optional(), domains: Domains.optional(), timezone: z.string().max(64).optional() });
const UserDelete = z.object({ confirmEmail: z.string().trim().max(320) });
const UserCreate = z.object({
  orgId: z.string(),
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().max(320),
  role: z.enum(["admin", "member"]),
});
const UserUpdate = z.object({
  orgId: z.string().optional(),
  name: z.string().trim().min(1).max(120).optional(),
  role: z.enum(["admin", "member"]).optional(),
  platformAdmin: z.boolean().optional(),
  disabled: z.boolean().optional(),
  digestEnabled: z.boolean().optional(),
  digestTime: z.string().optional(),
});

function cleanDomains(raw: string[]): string[] {
  const out = [...new Set(raw.map((d) => d.trim().toLowerCase().replace(/^@/, "")).filter(Boolean))];
  for (const d of out) if (!DOMAIN_RE.test(d)) throw badRequest(`Invalid domain: ${d}`);
  return out;
}

function checkZone(zone: string): string {
  if (!IANAZone.isValidZone(zone)) throw badRequest(`Unknown time zone: ${zone}`);
  return zone;
}

/**
 * Platform administration (#/admin): organizations and accounts of every organization. Configuration and health
 * only — nothing here reads a task, a message or a mailbox password. Every change is written to security_audit.
 * Accounts get a one-time setup link (src/server/auth/setup-links.ts): the admin never chooses or sees a password.
 */
export function registerAdminRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, clock, config } = ctx.deps;

  async function requirePlatformAdmin(request: FastifyRequest): Promise<void> {
    const [u] = await db.select({ platformAdmin: users.platformAdmin }).from(users).where(eq(users.id, authOf(request).userId));
    if (!u?.platformAdmin) throw forbidden("Admins only");
  }
  const admin = { preHandler: [requireAuth(ctx, "full"), requirePlatformAdmin] };

  async function orgViews(ids?: string[]): Promise<AdminOrg[]> {
    const rows = await db
      .select({
        org: organizations,
        // Correlated to the outer row: written out, since an interpolated column renders unqualified here.
        users: sql<number>`(select count(*)::int from users u where u.org_id = "organizations"."id")`,
        mailboxes: sql<number>`(select count(*)::int from mailboxes m where m.org_id = "organizations"."id")`,
      })
      .from(organizations)
      .where(ids ? inArray(organizations.id, ids) : undefined)
      .orderBy(asc(organizations.name));
    return rows.map((r) => ({
      id: r.org.id,
      name: r.org.name,
      internalDomains: r.org.internalDomains,
      timezone: r.org.timezone,
      users: Number(r.users),
      mailboxes: Number(r.mailboxes),
      createdAt: r.org.createdAt.toISOString(),
    }));
  }

  async function userViews(ids?: string[]): Promise<AdminUser[]> {
    const rows = await db
      .select()
      .from(users)
      .where(ids ? inArray(users.id, ids) : undefined)
      .orderBy(asc(users.name));
    const boxes = rows.length
      ? await db
          .select({ id: mailboxes.id, userId: mailboxes.userId, address: mailboxes.address, status: mailboxes.status, lastSyncAt: mailboxes.lastSyncAt })
          .from(mailboxes)
          .where(inArray(mailboxes.userId, rows.map((u) => u.id)))
          .orderBy(asc(mailboxes.address))
      : [];
    const now = clock.now();
    return rows.map((u) => ({
      id: u.id,
      orgId: u.orgId,
      name: u.name,
      email: u.email,
      role: u.role,
      platformAdmin: u.platformAdmin,
      state: u.disabledAt ? "disabled" : u.passwordHash ? "active" : "invited",
      mfa: u.totpEnabled,
      setupExpiresAt: u.setupTokenHash && u.setupExpiresAt && u.setupExpiresAt > now ? u.setupExpiresAt.toISOString() : null,
      digestEnabled: u.digestEnabled,
      digestTime: u.digestTime,
      mailboxes: boxes
        .filter((b) => b.userId === u.id)
        .map((b): AdminMailbox => ({ id: b.id, address: b.address, status: b.status, lastSyncAt: b.lastSyncAt?.toISOString() ?? null })),
      createdAt: u.createdAt.toISOString(),
    }));
  }

  async function nameTaken(name: string, exceptId?: string): Promise<boolean> {
    const rows = await db.select({ id: organizations.id }).from(organizations).where(sql`lower(${organizations.name}) = ${name.toLowerCase()}`);
    return rows.some((r) => r.id !== exceptId);
  }

  async function link(userId: string, orgId: string, request: FastifyRequest): Promise<AdminSetupLink> {
    const l = await issueSetupLink(db, userId, clock.now(), config.APP_BASE_URL);
    await audit(db, { orgId, userId: authOf(request).userId, event: "admin.setup_link", detail: { target: userId }, ip: request.ip });
    return { url: l.url, expiresAt: l.expiresAt.toISOString() };
  }

  app.get("/api/admin/overview", admin, async (request) => {
    const res: AdminOverview = { me: authOf(request).userId, orgs: await orgViews(), users: await userViews() };
    return res;
  });

  app.post("/api/admin/orgs", admin, async (request) => {
    const body = parseWith(OrgCreate, request.body);
    if (await nameTaken(body.name)) throw badRequest("An organization with this name already exists.");
    const [org] = await db
      .insert(organizations)
      .values({ name: body.name, internalDomains: cleanDomains(body.domains), timezone: checkZone(body.timezone ?? config.DEFAULT_TIMEZONE) })
      .returning({ id: organizations.id });
    await audit(db, { orgId: org!.id, userId: authOf(request).userId, event: "admin.org_create", ip: request.ip });
    return (await orgViews([org!.id]))[0]!;
  });

  app.patch("/api/admin/orgs/:id", admin, async (request) => {
    const id = uuidParam((request.params as { id: string }).id);
    const body = parseWith(OrgUpdate, request.body);
    const [cur] = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, id));
    if (!cur) throw notFound();
    if (body.name !== undefined && (await nameTaken(body.name, id))) throw badRequest("An organization with this name already exists.");
    const set: Partial<typeof organizations.$inferInsert> = {};
    if (body.name !== undefined) set.name = body.name;
    if (body.domains !== undefined) set.internalDomains = cleanDomains(body.domains);
    if (body.timezone !== undefined) set.timezone = checkZone(body.timezone);
    if (Object.keys(set).length) await db.update(organizations).set(set).where(eq(organizations.id, id));
    await audit(db, { orgId: id, userId: authOf(request).userId, event: "admin.org_update", detail: { fields: Object.keys(set) }, ip: request.ip });
    return (await orgViews([id]))[0]!;
  });

  app.post("/api/admin/users", admin, async (request) => {
    const body = parseWith(UserCreate, request.body);
    const orgId = uuidParam(body.orgId);
    const [org] = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, orgId));
    if (!org) throw badRequest("Choose an organization.");
    const email = body.email.toLowerCase();
    if (!EMAIL_RE.test(email)) throw badRequest("Invalid email.");
    const exists = await db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${email}`);
    if (exists.length) throw badRequest("An account with this email already exists.");
    // The report starts off: it is the one thing MailMe writes into a mailbox (APPEND), so it is switched on
    // deliberately, from here, once the mailbox has been checked read-only.
    const [u] = await db
      .insert(users)
      .values({ orgId, name: body.name, email, role: body.role, passwordHash: null, digestEnabled: false })
      .returning({ id: users.id });
    await audit(db, { orgId, userId: authOf(request).userId, event: "admin.user_create", detail: { target: u!.id, role: body.role }, ip: request.ip });
    const l = await link(u!.id, orgId, request);
    const res: AdminUserCreated = { user: (await userViews([u!.id]))[0]!, link: l };
    return res;
  });

  app.patch("/api/admin/users/:id", admin, async (request) => {
    const id = uuidParam((request.params as { id: string }).id);
    const body = parseWith(UserUpdate, request.body);
    const self = authOf(request).userId;
    const [cur] = await db.select().from(users).where(eq(users.id, id));
    if (!cur) throw notFound();
    if (id === self && (body.disabled === true || body.platformAdmin === false)) {
      throw badRequest("You can't disable your own account or remove its admin rights.");
    }
    if (body.digestTime !== undefined && !HHMM_RE.test(body.digestTime)) throw badRequest("The time must be in HH:MM format (e.g. 07:30).");
    const set: Partial<typeof users.$inferInsert> = {};
    if (body.orgId !== undefined && body.orgId !== cur.orgId) {
      const orgId = uuidParam(body.orgId);
      const [org] = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, orgId));
      if (!org) throw badRequest("Choose an organization.");
      // Mail, threads and tasks carry their organization: an account moves only before it has any.
      const [held] = await db.execute(
        sql`select (select count(*) from mailboxes where user_id = ${id})::int as mailboxes, (select count(*) from tasks where user_id = ${id})::int as tasks`,
      ).then((r) => r.rows as Array<{ mailboxes: number; tasks: number }>);
      if (Number(held?.mailboxes) > 0 || Number(held?.tasks) > 0) {
        throw badRequest("Only an account without a mailbox and tasks can be moved. For an account in use: delete it and create a new account in the right organization.");
      }
      set.orgId = orgId;
    }
    if (body.name !== undefined) set.name = body.name;
    if (body.role !== undefined) set.role = body.role;
    if (body.platformAdmin !== undefined) set.platformAdmin = body.platformAdmin;
    if (body.digestEnabled !== undefined) set.digestEnabled = body.digestEnabled;
    if (body.digestTime !== undefined) set.digestTime = body.digestTime;
    if (body.disabled !== undefined) set.disabledAt = body.disabled ? (cur.disabledAt ?? clock.now()) : null;
    if (Object.keys(set).length) await db.update(users).set(set).where(eq(users.id, id));
    if (body.disabled === true) {
      // Out at once: no session or remembered device survives a disable.
      await db.delete(sessions).where(eq(sessions.userId, id));
      await db.delete(trustedDevices).where(eq(trustedDevices.userId, id));
    }
    await audit(db, { orgId: cur.orgId, userId: self, event: "admin.user_update", detail: { target: id, fields: Object.keys(set) }, ip: request.ip });
    return (await userViews([id]))[0]!;
  });

  app.delete("/api/admin/users/:id", admin, async (request) => {
    const id = uuidParam((request.params as { id: string }).id);
    const { confirmEmail } = parseWith(UserDelete, request.body ?? {});
    const self = authOf(request).userId;
    if (id === self) throw badRequest("You can't delete your own account.");
    const [cur] = await db.select({ orgId: users.orgId, email: users.email, platformAdmin: users.platformAdmin }).from(users).where(eq(users.id, id));
    if (!cur) throw notFound();
    if (confirmEmail.toLowerCase() !== cur.email.toLowerCase()) throw badRequest("To confirm, type the account's email exactly.");
    if (cur.platformAdmin) {
      const [{ n } = { n: 0 }] = (await db.execute(sql`select count(*)::int as n from users where platform_admin and disabled_at is null`)).rows as Array<{ n: number }>;
      if (Number(n) <= 1) throw badRequest("This is the last platform admin.");
    }
    await stopAccount(db, id, clock.now());
    const r = await purgeAccount(db, id);
    if (!r.ok) {
      await audit(db, { orgId: cur.orgId, userId: self, event: "admin.user_delete", detail: { target: id, stage: "stopped" }, ip: request.ip });
      throw conflict("The account is disabled and its sync is stopping. Press “Delete” again in a minute.");
    }
    await audit(db, { orgId: cur.orgId, userId: self, event: "admin.user_delete", detail: { target: id, ...r.deleted }, ip: request.ip });
    const res: AdminUserDeleted = { deleted: r.deleted };
    return res;
  });

  app.delete("/api/admin/orgs/:id", admin, async (request) => {
    const id = uuidParam((request.params as { id: string }).id);
    const [org] = await orgViews([id]);
    if (!org) throw notFound();
    if (org.users > 0 || org.mailboxes > 0) throw badRequest("Only an empty organization can be deleted: delete or move its accounts first.");
    await db.transaction(async (tx) => {
      await tx.delete(companyDomains).where(eq(companyDomains.orgId, id));
      await tx.delete(organizations).where(eq(organizations.id, id));
    });
    await audit(db, { orgId: id, userId: authOf(request).userId, event: "admin.org_delete", ip: request.ip });
    return { ok: true as const };
  });

  app.post("/api/admin/users/:id/setup-link", admin, async (request) => {
    const id = uuidParam((request.params as { id: string }).id);
    const [cur] = await db.select({ orgId: users.orgId, disabledAt: users.disabledAt }).from(users).where(eq(users.id, id));
    if (!cur) throw notFound();
    if (cur.disabledAt) throw badRequest("The account is disabled: enable it first.");
    return link(id, cur.orgId, request);
  });
}

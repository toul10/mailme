import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as s from "../../src/db/schema.js";
import type { AdminOrg, AdminOverview, AdminUser, AdminUserCreated, LoginResponse, SetupCheck } from "../../src/server/api-types.js";
import { hashSetupToken, SETUP_LINK_TTL_MS } from "../../src/server/auth/setup-links.js";
import { insertMessage, insertTask, insertThread } from "../helpers/db.js";
import { addUser, api, cookiesFrom, makeHarness, PASSWORD, sessionFor, setCredentials, type Harness, type Session } from "./helpers.js";

const NEW_PASSWORD = "a long enough new password";

/** Platform administration (#/admin) and the one-time setup link. */
describe("platform admin", () => {
  let h: Harness;
  let root: Session;
  let rootId: string;
  beforeEach(async () => {
    h = await makeHarness();
    const [adminOrg] = await h.t.db.insert(s.organizations).values({ name: "MailMe", internalDomains: [] }).returning();
    const u = await addUser(h, { email: "admin@example.com", orgId: adminOrg!.id });
    await h.t.db.update(s.users).set({ platformAdmin: true }).where(eq(s.users.id, u.id));
    rootId = u.id;
    root = await sessionFor(h, u.id);
  });
  afterEach(async () => {
    await h.close();
  });

  const tokenOf = (url: string) => new URL(url.replace("/#/", "/")).searchParams.get("t")!;
  const setup = (token: string, password = NEW_PASSWORD, cookies: Record<string, string> = {}) =>
    h.app.inject({ method: "POST", url: "/api/auth/setup", payload: { token, password }, cookies });

  it("is only for platform admins (an org admin or a member gets 403, a half session 401)", async () => {
    const orgAdmin = await addUser(h, { email: "boss@contoso.example", role: "admin" });
    expect((await api(h, await sessionFor(h, orgAdmin.id), "GET", "/api/admin/overview")).statusCode).toBe(403);
    expect((await api(h, await sessionFor(h, h.seed.user.id), "GET", "/api/admin/overview")).statusCode).toBe(403);
    expect((await api(h, await sessionFor(h, rootId, false), "GET", "/api/admin/overview")).statusCode).toBe(401);
    const me = (await api(h, root, "GET", "/api/me")).json() as { platformAdmin: boolean };
    expect(me.platformAdmin).toBe(true);
  });

  it("lists organizations and accounts with health only, never content", async () => {
    const res = await api(h, root, "GET", "/api/admin/overview");
    expect(res.statusCode).toBe(200);
    const o = res.json() as AdminOverview;
    expect(o.me).toBe(rootId);
    expect(o.orgs.map((x) => [x.name, x.users, x.mailboxes])).toEqual([
      ["Contoso", 1, 1],
      ["MailMe", 1, 0],
    ]);
    const owner = o.users.find((u) => u.email === "owner@contoso.example")!;
    expect(owner.mailboxes).toEqual([{ id: h.seed.mailbox.id, address: "owner@contoso.example", status: "active", lastSyncAt: null }]);
    expect(Object.keys(owner).sort()).toEqual(["createdAt", "digestEnabled", "digestTime", "email", "id", "mailboxes", "mfa", "name", "orgId", "platformAdmin", "role", "setupExpiresAt", "state"]);
  });

  it("creates and edits organizations, with validated domains, zone and a unique name", async () => {
    const created = await api(h, root, "POST", "/api/admin/orgs", { name: "Alfa Ήχος", domains: ["@Alfa-gr.example", "alfa-sound.example"] });
    expect(created.statusCode).toBe(200);
    const org = created.json() as AdminOrg;
    expect(org).toMatchObject({ name: "Alfa Ήχος", internalDomains: ["alfa-gr.example", "alfa-sound.example"], timezone: "Europe/Athens", users: 0 });
    expect((await api(h, root, "POST", "/api/admin/orgs", { name: "alfa ήχος", domains: [] })).statusCode).toBe(400);
    expect((await api(h, root, "POST", "/api/admin/orgs", { name: "Beta", domains: ["not a domain"] })).statusCode).toBe(400);
    expect((await api(h, root, "POST", "/api/admin/orgs", { name: "Beta", domains: [], timezone: "Mars/Olympus" })).statusCode).toBe(400);
    const edited = await api(h, root, "PATCH", `/api/admin/orgs/${org.id}`, { domains: ["alfa-gr.example"], name: "Alfa" });
    expect(edited.json()).toMatchObject({ name: "Alfa", internalDomains: ["alfa-gr.example"] });
    const events = (await h.t.db.select().from(s.securityAudit)).map((r) => r.event);
    expect(events).toEqual(expect.arrayContaining(["admin.org_create", "admin.org_update"]));
  });

  it("creates an account with a one-time link; the person sets their own password, then TOTP", async () => {
    const res = await api(h, root, "POST", "/api/admin/users", { orgId: h.seed.org.id, name: "Μαρία Κ.", email: "Maria@Contoso.example", role: "member" });
    expect(res.statusCode).toBe(200);
    const { user, link } = res.json() as AdminUserCreated;
    expect(user).toMatchObject({ email: "maria@contoso.example", state: "invited", mfa: false, setupExpiresAt: link.expiresAt, digestEnabled: false });
    expect(link.url).toMatch(/^http:\/\/localhost:3000\/#\/setup\?t=[A-Za-z0-9_-]{43}$/);
    expect(new Date(link.expiresAt).getTime() - h.clock.now().getTime()).toBe(SETUP_LINK_TTL_MS);
    const token = tokenOf(link.url);
    const [row] = await h.t.db.select().from(s.users).where(eq(s.users.id, user.id));
    expect(row!.setupTokenHash).toBe(hashSetupToken(token)); // only the hash is stored
    expect(row!.passwordHash).toBeNull();

    const check = await h.app.inject({ method: "POST", url: "/api/auth/setup/check", payload: { token } });
    expect(check.json()).toMatchObject({ name: "Μαρία Κ.", email: "maria@contoso.example", minPassword: 12 } satisfies Partial<SetupCheck>);

    expect((await setup(token, "short")).statusCode).toBe(400);
    const done = await setup(token);
    expect(done.statusCode).toBe(200);
    expect((done.json() as LoginResponse).next).toBe("totp_enroll");
    // The session it opened can only enrol TOTP, not read tasks.
    const half = { cookies: cookiesFrom(done), csrf: (done.json() as LoginResponse).csrfToken };
    expect((await api(h, half, "GET", "/api/today")).statusCode).toBe(401);
    expect((await api(h, half, "POST", "/api/auth/totp/enroll")).statusCode).toBe(200);

    // Single use.
    expect((await setup(token)).statusCode).toBe(404);
    expect((await h.app.inject({ method: "POST", url: "/api/auth/setup/check", payload: { token } })).statusCode).toBe(404);
    const login = await h.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "maria@contoso.example", password: NEW_PASSWORD } });
    expect(login.statusCode).toBe(200);
  });

  it("a new link resets access: new password, TOTP again, every old session out; expired links fail", async () => {
    await setCredentials(h, h.seed.user.id, { totpSecret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP" });
    const firstRes = await api(h, root, "POST", `/api/admin/users/${h.seed.user.id}/setup-link`);
    expect(firstRes.body).toContain("url");
    const first = firstRes.json() as { url: string };
    h.clock.advance(SETUP_LINK_TTL_MS + 1000);
    expect((await setup(tokenOf(first.url))).statusCode).toBe(404);
    root = await sessionFor(h, rootId); // the admin's own session expired meanwhile too
    const oldSession = await sessionFor(h, h.seed.user.id);
    expect((await api(h, oldSession, "GET", "/api/today")).statusCode).toBe(200);

    const second = (await api(h, root, "POST", `/api/admin/users/${h.seed.user.id}/setup-link`)).json() as { url: string };
    expect((await setup(tokenOf(second.url))).statusCode).toBe(200);
    const [u] = await h.t.db.select().from(s.users).where(eq(s.users.id, h.seed.user.id));
    expect(u).toMatchObject({ totpEnabled: false, totpSecretEnc: null, setupTokenHash: null });
    expect((await api(h, oldSession, "GET", "/api/today")).statusCode).toBe(401);
    const oldPassword = await h.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "owner@contoso.example", password: PASSWORD } });
    expect(oldPassword.statusCode).toBe(401);
  });

  it("disables an account at once, changes role and report settings, and never locks the admin out", async () => {
    const victim = await sessionFor(h, h.seed.user.id);
    const off = await api(h, root, "PATCH", `/api/admin/users/${h.seed.user.id}`, { disabled: true, digestEnabled: false, digestTime: "08:15", role: "admin" });
    expect(off.json()).toMatchObject({ state: "disabled", digestEnabled: false, digestTime: "08:15", role: "admin" } satisfies Partial<AdminUser>);
    expect((await api(h, victim, "GET", "/api/today")).statusCode).toBe(401);
    expect((await api(h, root, "POST", `/api/admin/users/${h.seed.user.id}/setup-link`)).statusCode).toBe(400);
    expect((await api(h, root, "PATCH", `/api/admin/users/${h.seed.user.id}`, { disabled: false })).json()).toMatchObject({ state: "invited" });

    expect((await api(h, root, "PATCH", `/api/admin/users/${rootId}`, { disabled: true })).statusCode).toBe(400);
    expect((await api(h, root, "PATCH", `/api/admin/users/${rootId}`, { platformAdmin: false })).statusCode).toBe(400);
    expect((await api(h, root, "PATCH", `/api/admin/users/${h.seed.user.id}`, { digestTime: "7:30" })).statusCode).toBe(400);
    expect((await api(h, root, "POST", "/api/admin/users", { orgId: h.seed.org.id, name: "Dup", email: "OWNER@contoso.example", role: "member" })).statusCode).toBe(400);
  });

  const del = (id: string, confirmEmail: string) =>
    h.app.inject({ method: "DELETE", url: `/api/admin/users/${id}`, payload: { confirmEmail }, cookies: root.cookies, headers: { "x-csrf-token": root.csrf } });

  it("deletes an account with all its data, after typing its email; never itself", async () => {
    const seed = { orgId: h.seed.org.id, userId: h.seed.user.id, mailboxId: h.seed.mailbox.id };
    const thread = await insertThread(h.t.db, h.seed.mailbox.id);
    await insertMessage(h.t.db, { mailboxId: h.seed.mailbox.id, threadId: thread.id, from: "client@abc-gr.example", to: ["owner@contoso.example"] });
    await insertTask(h.t.db, { ...seed, title: "Προσφορά" });
    await h.t.db.insert(s.digests).values({ userId: h.seed.user.id, localDate: "2026-09-10", messageIdHeader: "<d@x>", status: "delivered", deliveredVia: "append" });
    await h.t.db.update(s.mailboxes).set({ credentialsSealed: "sealed", credentialsKid: "k1" }).where(eq(s.mailboxes.id, h.seed.mailbox.id));
    const victim = await sessionFor(h, h.seed.user.id);

    expect((await del(h.seed.user.id, "someone@else.example")).statusCode).toBe(400);
    expect((await h.t.db.select().from(s.users).where(eq(s.users.id, h.seed.user.id))).length).toBe(1);
    expect((await del(rootId, "admin@example.com")).statusCode).toBe(400);

    const res = await del(h.seed.user.id, "OWNER@contoso.example");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: { mailboxes: 1, messages: 1, tasks: 1 } });
    for (const table of [s.users, s.mailboxes, s.messages, s.threads, s.tasks, s.digests, s.mailboxFolders] as const) {
      const rows = await h.t.db.select().from(table);
      expect(rows.filter((r) => ("userId" in r ? r.userId === h.seed.user.id : "mailboxId" in r ? r.mailboxId === h.seed.mailbox.id : r.id === h.seed.user.id))).toEqual([]);
    }
    expect((await api(h, victim, "GET", "/api/today")).statusCode).toBe(401);
    const audit = (await h.t.db.select().from(s.securityAudit)).find((r) => r.event === "admin.user_delete");
    expect(audit?.detail).toEqual({ target: h.seed.user.id, mailboxes: 1, messages: 1, tasks: 1 });
    expect((await del(h.seed.user.id, "owner@contoso.example")).statusCode).toBe(404);
  });

  it("moves an account to another organization only before it has a mailbox or tasks", async () => {
    const [other] = await h.t.db.insert(s.organizations).values({ name: "Alfa", internalDomains: ["alfa-gr.example"] }).returning();
    const fresh = await api(h, root, "POST", "/api/admin/users", { orgId: h.seed.org.id, name: "Νέος", email: "new@alfa-gr.example", role: "member" });
    const id = (fresh.json() as AdminUserCreated).user.id;
    const moved = await api(h, root, "PATCH", `/api/admin/users/${id}`, { orgId: other!.id });
    expect(moved.json()).toMatchObject({ orgId: other!.id });
    const busy = await api(h, root, "PATCH", `/api/admin/users/${h.seed.user.id}`, { orgId: other!.id });
    expect(busy.statusCode).toBe(400);
    expect(busy.json().error).toContain("without a mailbox");
  });

  it("deletes only an empty organization", async () => {
    const created = (await api(h, root, "POST", "/api/admin/orgs", { name: "Κενός", domains: ["kenos.example"] })).json() as AdminOrg;
    const remove = (id: string) => h.app.inject({ method: "DELETE", url: `/api/admin/orgs/${id}`, payload: {}, cookies: root.cookies, headers: { "x-csrf-token": root.csrf } });
    expect((await remove(h.seed.org.id)).statusCode).toBe(400);
    expect((await remove(created.id)).statusCode).toBe(200);
    expect((await api(h, root, "GET", "/api/admin/overview")).json().orgs.map((o: AdminOrg) => o.name)).toEqual(["Contoso", "MailMe"]);
  });
});

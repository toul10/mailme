import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as s from "../../src/db/schema.js";
import type { MailRulesView, SuppliersResponse, TaskDetail, TaskListResponse, TodayResponse } from "../../src/server/api-types.js";
import { SUPPLIER_GROUP_CAP } from "../../src/server/queries.js";
import { insertTask } from "../helpers/db.js";
import { addUser, api, makeHarness, sessionFor, type Harness, type Session } from "./helpers.js";

/**
 * Suppliers: a user's own supplier rules (PUT/DELETE /api/rules/suppliers), the supplier a task is tagged with,
 * the list narrowed to one (`supplier=`), the open tasks supplier by supplier (GET /api/suppliers) and the counts
 * of the day (GET /api/today).
 */
describe("suppliers", () => {
  let h: Harness;
  let me: Session;
  beforeEach(async () => {
    h = await makeHarness();
    me = await sessionFor(h, h.seed.user.id);
  });
  afterEach(async () => {
    await h.close();
  });

  const NORTHWIND = { name: "NORTHWIND", senders: ["@Northwind-ro.example"] };
  const FABRIKAM = { name: "Fabrikam", senders: ["orders@fabrikam.example"] };
  const put = (suppliers: Array<{ name: string; senders: string[] }>, mode?: "add" | "replace", sess: Session = me) => api(h, sess, "PUT", "/api/rules/suppliers", { suppliers, ...(mode ? { mode } : {}) });
  const del = (id: string, sess: Session = me) => h.app.inject({ method: "DELETE", url: `/api/rules/suppliers/${id}`, payload: {}, cookies: sess.cookies, headers: { "x-csrf-token": sess.csrf } });
  const storedRules = async (userId = h.seed.user.id) => (await h.t.db.select().from(s.users).where(eq(s.users.id, userId)))[0]!.mailRules as unknown[];
  const task = (title: string, counterparty: string | null, o: { status?: (typeof s.tasks.$inferInsert)["status"]; userId?: string; mailboxId?: string } = {}) =>
    insertTask(h.t.db, { orgId: h.seed.org.id, userId: o.userId ?? h.seed.user.id, mailboxId: o.mailboxId ?? h.seed.mailbox.id, title, counterparty: counterparty ?? undefined, status: o.status }).then(async (t) => {
      if (counterparty === null) await h.t.db.update(s.tasks).set({ counterpartyAddress: null }).where(eq(s.tasks.id, t.id));
      return t;
    });
  const list = async (query: string, sess: Session = me) => (await api(h, sess, "GET", `/api/tasks?${query}`)).json() as TaskListResponse;
  const titles = (res: TaskListResponse) => res.items.map((i) => i.title).sort();

  describe("writing the rules", () => {
    it("adds suppliers to the session user's own list and to nobody else's", async () => {
      const other = await addUser(h, { email: "colleague@contoso.example" });
      const imported = [{ id: "webinars", kind: "ignore", enabled: true, text: "Webinar: ignore", topics: ["webinar"] }];
      await h.t.db.update(s.users).set({ mailRules: imported as never }).where(eq(s.users.id, h.seed.user.id));

      const res = await put([NORTHWIND, FABRIKAM]);
      expect(res.statusCode).toBe(200);
      const northwind = { id: "supplier-northwind", kind: "supplier", enabled: true, text: "NORTHWIND", name: "NORTHWIND", senders: ["@northwind-ro.example"] };
      const fabrikam = { id: "supplier-fabrikam", kind: "supplier", enabled: true, text: "Fabrikam", name: "Fabrikam", senders: ["orders@fabrikam.example"] };
      expect(res.json() as MailRulesView).toEqual({ rules: [imported[0], northwind, fabrikam], skipped: [] });
      expect(await storedRules()).toEqual([imported[0], northwind, fabrikam]);
      expect(await storedRules(other.id)).toEqual([]);
      expect(((await api(h, me, "GET", "/api/rules")).json() as MailRulesView).rules.map((r) => r.id)).toEqual(["webinars", "supplier-northwind", "supplier-fabrikam"]);
      // The colleague sees none of it, and names their own.
      const theirs = await sessionFor(h, other.id);
      expect(((await api(h, theirs, "GET", "/api/rules")).json() as MailRulesView).rules).toEqual([]);
      expect((await put([{ name: "Northwind", senders: ["@northwind-ro.example"] }], undefined, theirs)).statusCode).toBe(200);
      expect((await storedRules()).length).toBe(3);
    });

    it("“add” joins senders to a supplier that exists, “replace” sets them, the switch turns it off, DELETE removes it", async () => {
      await put([NORTHWIND]);
      expect(((await put([{ name: "northwind", senders: ["sales@nw-parts.example"] }])).json() as MailRulesView).rules).toMatchObject([{ id: "supplier-northwind", name: "NORTHWIND", senders: ["@northwind-ro.example", "sales@nw-parts.example"] }]);
      expect(((await put([{ name: "Northwind", senders: ["sales@nw-parts.example"] }], "replace")).json() as MailRulesView).rules).toMatchObject([{ id: "supplier-northwind", name: "Northwind", senders: ["sales@nw-parts.example"] }]);
      expect(((await api(h, me, "PATCH", "/api/rules/supplier-northwind", { enabled: false })).json() as MailRulesView).rules).toMatchObject([{ id: "supplier-northwind", enabled: false }]);

      const gone = await del("supplier-northwind");
      expect(gone.statusCode).toBe(200);
      expect(gone.json()).toEqual({ rules: [], skipped: [] });
      expect(await storedRules()).toEqual([]);
      expect((await del("supplier-northwind")).statusCode).toBe(404);
    });

    it("DELETE takes suppliers only: another kind of rule, or another user's supplier, stays", async () => {
      const other = await addUser(h, { email: "colleague@contoso.example" });
      const theirs = await sessionFor(h, other.id);
      await put([NORTHWIND], undefined, theirs);
      await h.t.db.update(s.users).set({ mailRules: [{ id: "webinars", kind: "ignore", enabled: true, text: "Webinar: ignore", topics: ["webinar"] }] as never }).where(eq(s.users.id, h.seed.user.id));
      expect((await del("webinars")).statusCode).toBe(404);
      expect((await del("supplier-northwind")).statusCode).toBe(404);
      expect((await storedRules()).length).toBe(1);
      expect((await storedRules(other.id)).length).toBe(1);
    });

    it("refuses what cannot be a supplier's sender with the reason, and writes nothing", async () => {
      await put([NORTHWIND]);
      const before = await storedRules();
      const refused = async (suppliers: Array<{ name: string; senders: string[] }>) => {
        const res = await put(suppliers);
        expect(res.statusCode).toBe(400);
        return (res.json() as { error: string }).error;
      };
      expect(await refused([{ name: "Fabrikam", senders: ["ion@eu.northwind-ro.example"] }])).toBe("“ion@eu.northwind-ro.example” already belongs to the supplier NORTHWIND.");
      // The organization's domain, the user's own address and a whole public mail service.
      expect(await refused([{ name: "Us", senders: ["@contoso.example"] }])).toContain("is your own address or your organization's");
      expect(await refused([{ name: "Me", senders: ["owner@contoso.example"] }])).toContain("is your own address or your organization's");
      expect(await refused([{ name: "Everyone", senders: ["@gmail.com"] }])).toContain("is a public mail service");
      // One bad entry refuses the whole request.
      expect(await refused([FABRIKAM, { name: "Bad", senders: ["not a domain"] }])).toContain("Bad: “not a domain”");
      expect(await storedRules()).toEqual(before);
      for (const body of [{}, { suppliers: [] }, { suppliers: [{ name: "A" }] }, { suppliers: [{ name: "A", senders: ["@a.example"] }], mode: "merge" }, { suppliers: "x" }]) {
        expect((await api(h, me, "PUT", "/api/rules/suppliers", body)).statusCode).toBe(400);
      }
      expect(await storedRules()).toEqual(before);
    });

    it("changes made at the same moment all land: none overwrites the list another one just saved", async () => {
      await h.t.db.update(s.users).set({ mailRules: [{ id: "webinars", kind: "ignore", enabled: true, text: "Webinar: ignore", topics: ["webinar"] }] as never }).where(eq(s.users.id, h.seed.user.id));
      const names = ["Adatum", "Litware", "Wingtip", "Proseware", "Tailspin"];
      const results = await Promise.all([
        ...names.map((name) => put([{ name, senders: [`@${name.toLowerCase()}.example`] }])),
        api(h, me, "PATCH", "/api/rules/webinars", { enabled: false }),
      ]);
      expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200, 200, 200, 200]);
      const stored = (await storedRules()) as Array<{ id: string; enabled: boolean }>;
      expect(stored.map((r) => r.id).sort()).toEqual(["supplier-adatum", "supplier-litware", "supplier-proseware", "supplier-tailspin", "supplier-wingtip", "webinars"]);
      expect(stored.find((r) => r.id === "webinars")!.enabled).toBe(false);
    });

    it("needs a session, and its CSRF token for a change", async () => {
      expect((await api(h, null, "GET", "/api/suppliers")).statusCode).toBe(401);
      expect((await api(h, null, "PUT", "/api/rules/suppliers", { suppliers: [NORTHWIND] })).statusCode).toBe(401);
      expect((await h.app.inject({ method: "PUT", url: "/api/rules/suppliers", payload: { suppliers: [NORTHWIND] }, cookies: me.cookies })).statusCode).toBe(403);
      expect((await h.app.inject({ method: "DELETE", url: "/api/rules/suppliers/supplier-northwind", payload: {}, cookies: me.cookies })).statusCode).toBe(403);
      expect(await storedRules()).toEqual([]);
    });
  });

  describe("the tasks of a supplier", () => {
    beforeEach(async () => {
      await put([NORTHWIND, FABRIKAM]);
      await task("Northwind — price list", "ion@northwind-ro.example");
      await task("Northwind — spare parts", "Maria@EU.Northwind-ro.example ", { status: "WAITING_FOR_OTHER" });
      await task("Northwind — closed order", "ion@northwind-ro.example", { status: "COMPLETED" });
      await task("Fabrikam — invoice", "orders@fabrikam.example", { status: "WAITING_FOR_ME" });
      // Not a supplier's: a look-alike domain, the supplier's name inside another domain, another address of an
      // address-only supplier, a customer, nobody.
      await task("Lookalike", "x@notnorthwind-ro.example");
      await task("Inside another", "x@northwind-ro.example.evil.example");
      await task("Fabrikam sales", "sales@fabrikam.example");
      await task("Customer", "client@abc-gr.example");
      await task("Nobody", null);
    });

    it("every row says whose it is, in the lists and on the task's page", async () => {
      const all = await list("tab=all&limit=100");
      const tagged = Object.fromEntries(all.items.map((i) => [i.title, i.supplier]));
      expect(tagged).toEqual({
        "Northwind — price list": { id: "supplier-northwind", name: "NORTHWIND" },
        "Northwind — spare parts": { id: "supplier-northwind", name: "NORTHWIND" },
        "Fabrikam — invoice": { id: "supplier-fabrikam", name: "Fabrikam" },
        Lookalike: null,
        "Inside another": null,
        "Fabrikam sales": null,
        Customer: null,
        Nobody: null,
      });
      const row = all.items.find((i) => i.title === "Northwind — price list")!;
      expect(((await api(h, me, "GET", `/api/tasks/${row.id}`)).json() as TaskDetail).supplier).toEqual({ id: "supplier-northwind", name: "NORTHWIND" });
    });

    it("supplier= narrows the list and its counts to that supplier, in every tab", async () => {
      const open = await list("tab=all&supplier=supplier-northwind");
      expect(titles(open)).toEqual(["Northwind — price list", "Northwind — spare parts"]);
      expect(open.counts).toMatchObject({ all: 2, todo: 1, waiting: 1, closed: 1 });
      expect(titles(await list("tab=closed&supplier=supplier-northwind"))).toEqual(["Northwind — closed order"]);
      expect(titles(await list("tab=waiting&supplier=supplier-northwind"))).toEqual(["Northwind — spare parts"]);
      expect(titles(await list("tab=all&supplier=supplier-fabrikam"))).toEqual(["Fabrikam — invoice"]);
      // With the other filters, not instead of them.
      expect(titles(await list("tab=all&supplier=supplier-northwind&q=spare"))).toEqual(["Northwind — spare parts"]);
      expect(titles(await list("tab=all&supplier=SUPPLIER-Northwind"))).toEqual(["Northwind — price list", "Northwind — spare parts"]);
    });

    it("an id that is not one of the user's suppliers in use matches nothing; a malformed one is refused", async () => {
      expect((await list("tab=all&supplier=supplier-nobody")).items).toEqual([]);
      expect((await list("tab=all&supplier=supplier-nobody")).counts.all).toBe(0);
      expect((await api(h, me, "GET", "/api/tasks?tab=all&supplier=%27%20or%201%3D1")).statusCode).toBe(400);
      expect((await api(h, me, "GET", `/api/tasks?tab=all&supplier=${"a".repeat(61)}`)).statusCode).toBe(400);
      // Another kind of rule is no supplier.
      const rules = await storedRules();
      await h.t.db.update(s.users).set({ mailRules: [...rules, { id: "webinars", kind: "ignore", enabled: true, text: "Webinar: ignore", topics: ["webinar"] }] as never }).where(eq(s.users.id, h.seed.user.id));
      expect((await list("tab=all&supplier=webinars")).items).toEqual([]);
    });

    it("lists the open tasks supplier by supplier: asked first, then promised, then awaited; the day counts them", async () => {
      const res = (await api(h, me, "GET", "/api/suppliers")).json() as SuppliersResponse;
      expect(res.suppliers.map((g) => ({ id: g.id, name: g.name, senders: g.senders, open: g.open, items: g.items.map((i) => i.title) }))).toEqual([
        { id: "supplier-northwind", name: "NORTHWIND", senders: ["@northwind-ro.example"], open: 2, items: ["Northwind — price list", "Northwind — spare parts"] },
        { id: "supplier-fabrikam", name: "Fabrikam", senders: ["orders@fabrikam.example"], open: 1, items: ["Fabrikam — invoice"] },
      ]);
      expect(res.suppliers[0]!.items[0]!.supplier).toEqual({ id: "supplier-northwind", name: "NORTHWIND" });
      const today = (await api(h, me, "GET", "/api/today")).json() as TodayResponse;
      expect(today.suppliers).toEqual([
        { id: "supplier-northwind", name: "NORTHWIND", open: 2 },
        { id: "supplier-fabrikam", name: "Fabrikam", open: 1 },
      ]);
      expect(today.counts.suppliers).toBe(3);
      // The group's number is the “Open” count of the list narrowed to it.
      expect((await list("tab=all&supplier=supplier-northwind")).counts.all).toBe(2);
    });

    it("a supplier with nothing open comes last; one switched off names no task and is not listed", async () => {
      await put([{ name: "Tailspin", senders: ["@tailspin.example"] }]);
      await h.t.db.update(s.tasks).set({ status: "COMPLETED", closedAt: new Date() }).where(eq(s.tasks.title, "Fabrikam — invoice"));
      const groups = async () => ((await api(h, me, "GET", "/api/suppliers")).json() as SuppliersResponse).suppliers.map((g) => `${g.name}:${g.open}`);
      expect(await groups()).toEqual(["NORTHWIND:2", "Fabrikam:0", "Tailspin:0"]);

      expect((await api(h, me, "PATCH", "/api/rules/supplier-northwind", { enabled: false })).statusCode).toBe(200);
      expect(await groups()).toEqual(["Fabrikam:0", "Tailspin:0"]);
      expect((await list("tab=all&limit=100")).items.filter((i) => i.supplier)).toEqual([]);
      expect((await list("tab=all&supplier=supplier-northwind")).items).toEqual([]);
      const today = (await api(h, me, "GET", "/api/today")).json() as TodayResponse;
      expect(today.suppliers.map((x) => x.id)).toEqual(["supplier-fabrikam", "supplier-tailspin"]);
      expect(today.counts.suppliers).toBe(0);
    });

    it("a user without suppliers gets an empty answer, and rows without a supplier", async () => {
      const other = await addUser(h, { email: "colleague@contoso.example" });
      const theirs = await sessionFor(h, other.id);
      const [box] = await h.t.db.insert(s.mailboxes).values({ orgId: h.seed.org.id, userId: other.id, address: "colleague@contoso.example", imapHost: "mail.contoso.example" }).returning();
      await task("Theirs from Northwind", "ion@northwind-ro.example", { userId: other.id, mailboxId: box!.id });
      expect((await api(h, theirs, "GET", "/api/suppliers")).json()).toEqual({ suppliers: [] });
      const mine = await list("tab=all&limit=100", theirs);
      expect(mine.items.map((i) => [i.title, i.supplier])).toEqual([["Theirs from Northwind", null]]);
      // My supplier's id is nothing to them, and their task is never in my supplier's list.
      expect((await list("tab=all&supplier=supplier-northwind", theirs)).items).toEqual([]);
      expect(titles(await list("tab=all&supplier=supplier-northwind"))).toEqual(["Northwind — price list", "Northwind — spare parts"]);
      const today = (await api(h, theirs, "GET", "/api/today")).json() as TodayResponse;
      expect(today.suppliers).toEqual([]);
      expect(today.counts.suppliers).toBe(0);
    });

    it("follows the per-mailbox view: the groups, the counts and the list are of that one mailbox", async () => {
      const [second] = await h.t.db.insert(s.mailboxes).values({ orgId: h.seed.org.id, userId: h.seed.user.id, address: "purchasing@contoso.example", imapHost: "mail.contoso.example" }).returning();
      await task("Northwind — container", "port@northwind-ro.example", { mailboxId: second!.id });
      const groups = async (view: string) => ((await api(h, me, "GET", `/api/suppliers${view}`)).json() as SuppliersResponse).suppliers.map((g) => `${g.name}:${g.open}`);
      expect(await groups("")).toEqual(["NORTHWIND:3", "Fabrikam:1"]);
      expect(await groups(`?mailbox=${second!.id}`)).toEqual(["NORTHWIND:1", "Fabrikam:0"]);
      expect(await groups(`?mailbox=${h.seed.mailbox.id}`)).toEqual(["NORTHWIND:2", "Fabrikam:1"]);
      expect(titles(await list(`tab=all&supplier=supplier-northwind&mailbox=${second!.id}`))).toEqual(["Northwind — container"]);
      const today = (await api(h, me, "GET", `/api/today?mailbox=${second!.id}`)).json() as TodayResponse;
      expect(today.suppliers).toEqual([
        { id: "supplier-northwind", name: "NORTHWIND", open: 1 },
        { id: "supplier-fabrikam", name: "Fabrikam", open: 0 },
      ]);
      expect(today.counts.suppliers).toBe(1);
      // A mailbox that is not the user's own is no view.
      const other = await addUser(h, { email: "colleague@contoso.example" });
      const [foreign] = await h.t.db.insert(s.mailboxes).values({ orgId: h.seed.org.id, userId: other.id, address: "colleague@contoso.example", imapHost: "mail.contoso.example" }).returning();
      expect((await api(h, me, "GET", `/api/suppliers?mailbox=${foreign!.id}`)).statusCode).toBe(404);
    });
  });

  it("a supplier with more open tasks than a group carries says how many there are", async () => {
    await put([NORTHWIND]);
    for (let i = 0; i < SUPPLIER_GROUP_CAP + 2; i++) await task(`Northwind ${i}`, `p${i}@northwind-ro.example`);
    const [group] = ((await api(h, me, "GET", "/api/suppliers")).json() as SuppliersResponse).suppliers;
    expect(group!.open).toBe(SUPPLIER_GROUP_CAP + 2);
    expect(group!.items).toHaveLength(SUPPLIER_GROUP_CAP);
    expect(((await api(h, me, "GET", "/api/today")).json() as TodayResponse).counts.suppliers).toBe(SUPPLIER_GROUP_CAP + 2);
  });
});

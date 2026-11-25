import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as s from "../../src/db/schema.js";
import type { TaskDetail, TaskListResponse, TodayResponse } from "../../src/server/api-types.js";
import { insertMessage, insertTask } from "../helpers/db.js";
import { addUser, api, makeHarness, sessionFor, type Harness, type Session } from "./helpers.js";

/**
 * The per-mailbox view (`?mailbox=`): a user with two mailboxes sees everything together, or the tasks, the AI's
 * questions and the counts of one mailbox. It only ever names one of the user's own mailboxes.
 */

type TaskRow = typeof s.tasks.$inferSelect;

let h: Harness;
let me: Session;
let colleague: Session;
let admin: Session;
let main: string;
let purchasing: string;
let theirs: string;
let foreign: string;
const T: Record<string, TaskRow> = {};

async function seedTask(name: string, mailboxId: string, o: { status?: TaskRow["status"]; company?: string; userId?: string; orgId?: string }, patch: Partial<typeof s.tasks.$inferInsert> = {}) {
  const row = await insertTask(h.t.db, { orgId: o.orgId ?? h.seed.org.id, userId: o.userId ?? h.seed.user.id, mailboxId, title: name, company: o.company ?? "ABC", status: o.status });
  const [updated] = await h.t.db
    .update(s.tasks)
    .set({ lastActivityAt: new Date("2026-09-14T08:00:00Z"), createdAt: new Date("2026-09-10T08:00:00Z"), ...patch })
    .where(eq(s.tasks.id, row.id))
    .returning();
  T[name] = updated!;
  return updated!;
}

beforeAll(async () => {
  h = await makeHarness(); // clock: 2026-09-15 07:00Z
  me = await sessionFor(h, h.seed.user.id);
  main = h.seed.mailbox.id;
  await h.t.db.update(s.mailboxes).set({ createdAt: new Date("2026-01-01T00:00:00Z") }).where(eq(s.mailboxes.id, main));
  const [second] = await h.t.db
    .insert(s.mailboxes)
    .values({ orgId: h.seed.org.id, userId: h.seed.user.id, address: "purchasing@contoso.example", displayName: "Αγορές", imapHost: "mail.contoso.example", status: "active", createdAt: new Date("2026-06-01T00:00:00Z") })
    .returning();
  purchasing = second!.id;

  await seedTask("M-ask παραγγελία ηχείων", main, {});
  await seedTask("M-promise", main, { status: "WAITING_FOR_ME" }, { waitingSince: new Date("2026-09-11T08:00:00Z") });
  await seedTask("M-wait", main, { status: "WAITING_FOR_OTHER" }, { ownerKind: "EXTERNAL", waitingSince: new Date("2026-09-11T08:00:00Z") });
  await seedTask("M-review", main, {}, { needsReview: true, reviewReasons: ["fuzzy_grounding"] });
  await seedTask("M-closed", main, { status: "COMPLETED" }, { closedAt: new Date("2026-09-12T08:00:00Z"), closedBy: "user" });

  await seedTask("P-ask παραγγελία καλωδίων", purchasing, { company: "Κίνα ΕΠΕ" });
  await seedTask("P-wait", purchasing, { status: "WAITING_FOR_OTHER", company: "Κίνα ΕΠΕ" }, { ownerKind: "EXTERNAL", waitingSince: new Date("2026-09-11T08:00:00Z") });
  await seedTask("P-suggest", purchasing, { company: "Λιμάνι ΑΕ" });
  await seedTask("P-colleague", purchasing, { company: "Λιμάνι ΑΕ" }, { ownerKind: "INTERNAL", ownerName: "Συνάδελφος" });
  await h.t.db.insert(s.taskEvents).values({ taskId: T["P-suggest"]!.id, userId: h.seed.user.id, mailboxId: purchasing, actor: "ai", op: "COMPLETE", applied: false, suggestionState: "pending", createdAt: new Date("2026-09-14T09:00:00Z") });

  // Entered by hand while the user had two mailboxes: it belongs to neither.
  await seedTask("N-manual", main, {}, { mailboxId: null, origin: "manual" });

  // A colleague in the same organization, an admin, and a mailbox of another organization.
  const colleagueUser = await addUser(h, { email: "colleague@contoso.example" });
  colleague = await sessionFor(h, colleagueUser.id);
  const [mbC] = await h.t.db.insert(s.mailboxes).values({ orgId: h.seed.org.id, userId: colleagueUser.id, address: "colleague@contoso.example", status: "active" }).returning();
  theirs = mbC!.id;
  await seedTask("C-secret", theirs, { userId: colleagueUser.id });
  admin = await sessionFor(h, (await addUser(h, { email: "admin@contoso.example", role: "admin" })).id);
  const [org2] = await h.t.db.insert(s.organizations).values({ name: "Other" }).returning();
  const stranger = await addUser(h, { email: "b@other-gr.example", orgId: org2!.id });
  const [mbF] = await h.t.db.insert(s.mailboxes).values({ orgId: org2!.id, userId: stranger.id, address: "b@other-gr.example" }).returning();
  foreign = mbF!.id;
});

afterAll(async () => {
  await h.close();
});

const get = (sess: Session | null, url: string) => api(h, sess, "GET", url);
async function list(qs: string, sess: Session = me): Promise<TaskListResponse> {
  const res = await get(sess, `/api/tasks?${qs}`);
  expect(res.statusCode).toBe(200);
  return res.json() as TaskListResponse;
}
async function today(qs = "", sess: Session = me): Promise<TodayResponse> {
  const res = await get(sess, `/api/today${qs}`);
  expect(res.statusCode).toBe(200);
  return res.json() as TodayResponse;
}
const titles = (items: Array<{ title: string }>) => items.map((i) => i.title).sort();
const MAIN_OPEN = ["M-ask παραγγελία ηχείων", "M-promise", "M-review", "M-wait"];
const PURCHASING_OPEN = ["P-ask παραγγελία καλωδίων", "P-colleague", "P-suggest", "P-wait"];

describe("GET /api/tasks?mailbox=", () => {
  it("without a mailbox lists everything of the user, each row naming its mailbox", async () => {
    const all = await list("tab=all");
    expect(titles(all.items)).toEqual([...PURCHASING_OPEN, "N-manual", ...MAIN_OPEN].sort());
    expect(all.counts).toMatchObject({ all: 9, closed: 1, others: 1 });
    const byTitle = new Map(all.items.map((i) => [i.title, i.mailboxId]));
    expect(byTitle.get("M-promise")).toBe(main);
    expect(byTitle.get("P-wait")).toBe(purchasing);
    expect(byTitle.get("N-manual")).toBeNull();
    // An empty value is no view at all.
    expect(titles((await list("tab=all&mailbox=")).items)).toEqual(titles(all.items));
  });

  it("with a mailbox lists and counts only that mailbox's tasks, in every tab", async () => {
    const i = await list(`tab=all&mailbox=${purchasing}`);
    expect(titles(i.items)).toEqual(PURCHASING_OPEN);
    expect(i.items.every((x) => x.mailboxId === purchasing)).toBe(true);
    expect(i.counts).toEqual({ todo: 2, waiting: 1, all: 4, others: 1, review: 1, closed: 0, earlier: 0 });

    const so = await list(`tab=all&mailbox=${main}`);
    expect(titles(so.items)).toEqual(MAIN_OPEN);
    expect(so.counts).toEqual({ todo: 3, waiting: 1, all: 4, others: 0, review: 1, closed: 1, earlier: 0 });

    expect(titles((await list(`tab=closed&mailbox=${main}`)).items)).toEqual(["M-closed"]);
    expect((await list(`tab=closed&mailbox=${purchasing}`)).items).toEqual([]);
    expect(titles((await list(`tab=review&mailbox=${purchasing}`)).items)).toEqual(["P-suggest"]);
    expect(titles((await list(`tab=review&mailbox=${main}`)).items)).toEqual(["M-review"]);
    expect(titles((await list(`tab=others&mailbox=${purchasing}`)).items)).toEqual(["P-colleague"]);
    expect(titles((await list(`tab=waiting&mailbox=${main}`)).items)).toEqual(["M-wait"]);
    // The id is matched whatever its case.
    expect(titles((await list(`tab=all&mailbox=${purchasing.toUpperCase()}`)).items)).toEqual(PURCHASING_OPEN);
  });

  it("combines with search, company and paging", async () => {
    expect(titles((await list(`tab=all&q=${encodeURIComponent("παραγγελία")}`)).items)).toEqual(["M-ask παραγγελία ηχείων", "P-ask παραγγελία καλωδίων"]);
    const found = await list(`tab=all&mailbox=${purchasing}&q=${encodeURIComponent("παραγγελία")}`);
    expect(titles(found.items)).toEqual(["P-ask παραγγελία καλωδίων"]);
    expect(found.counts.all).toBe(1);
    expect((await list(`tab=all&mailbox=${purchasing}&company=ABC`)).items).toEqual([]);
    expect(titles((await list(`tab=all&mailbox=${purchasing}&company=${encodeURIComponent("Λιμάνι ΑΕ")}`)).items)).toEqual(["P-colleague", "P-suggest"]);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const r: TaskListResponse = await list(`tab=all&mailbox=${purchasing}&limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      seen.push(...r.items.map((x) => x.title));
      cursor = r.nextCursor;
      if (!cursor) break;
    }
    expect(seen.sort()).toEqual(PURCHASING_OPEN);
  });
});

describe("GET /api/today?mailbox=", () => {
  it("always names every mailbox of the user, oldest first, and never anyone else's", async () => {
    const own = [
      { id: main, address: "owner@contoso.example", displayName: null },
      { id: purchasing, address: "purchasing@contoso.example", displayName: "Αγορές" },
    ];
    expect((await today()).mailboxes).toEqual(own);
    expect((await today(`?mailbox=${purchasing}`)).mailboxes).toEqual(own);
    expect((await today("", colleague)).mailboxes).toEqual([{ id: theirs, address: "colleague@contoso.example", displayName: null }]);
    expect((await today("", admin)).mailboxes).toEqual([]);
  });

  it("without a mailbox shows the sections and the AI's questions of all of them", async () => {
    const t = await today();
    expect(titles(t.doNow)).toEqual(["M-ask παραγγελία ηχείων", "M-review", "N-manual", "P-ask παραγγελία καλωδίων", "P-suggest"]);
    expect(titles(t.promised)).toEqual(["M-promise"]);
    expect(titles(t.waiting)).toEqual(["M-wait", "P-wait"]);
    expect(t.triage.map((x) => [x.kind, x.task.title])).toEqual([
      ["suggestion", "P-suggest"],
      ["review", "M-review"],
    ]);
    expect(t.counts).toEqual({ triage: 2, doNow: 5, promised: 1, waiting: 2, snoozed: 0, others: 1, earlier: 0, suppliers: 0 });
  });

  it("with a mailbox shows only its tasks, its questions and its counts", async () => {
    const i = await today(`?mailbox=${purchasing}`);
    expect(titles(i.doNow)).toEqual(["P-ask παραγγελία καλωδίων", "P-suggest"]);
    expect(i.promised).toEqual([]);
    expect(titles(i.waiting)).toEqual(["P-wait"]);
    expect(i.triage.map((x) => [x.kind, x.task.title, x.task.mailboxId])).toEqual([["suggestion", "P-suggest", purchasing]]);
    expect(i.counts).toEqual({ triage: 1, doNow: 2, promised: 0, waiting: 1, snoozed: 0, others: 1, earlier: 0, suppliers: 0 });

    const so = await today(`?mailbox=${main}`);
    expect(titles(so.doNow)).toEqual(["M-ask παραγγελία ηχείων", "M-review"]);
    expect(titles(so.promised)).toEqual(["M-promise"]);
    expect(titles(so.waiting)).toEqual(["M-wait"]);
    expect(so.triage.map((x) => [x.kind, x.task.title])).toEqual([["review", "M-review"]]);
    expect(so.counts).toEqual({ triage: 1, doNow: 2, promised: 1, waiting: 1, snoozed: 0, others: 0, earlier: 0, suppliers: 0 });
    expect(JSON.stringify(so)).not.toContain("P-");
    expect(JSON.stringify(so)).not.toContain("N-manual");
  });
});

describe("GET /api/companies?mailbox=", () => {
  const companies = async (qs = "") => ((await get(me, `/api/companies${qs}`)).json() as { companies: Array<{ name: string; open: number }> }).companies;

  it("counts the open tasks of every mailbox, or of one", async () => {
    expect(await companies()).toEqual([
      { name: "ABC", open: 5 },
      { name: "Κίνα ΕΠΕ", open: 2 },
      { name: "Λιμάνι ΑΕ", open: 2 },
    ]);
    expect(await companies(`?mailbox=${purchasing}`)).toEqual([
      { name: "Κίνα ΕΠΕ", open: 2 },
      { name: "Λιμάνι ΑΕ", open: 2 },
    ]);
    expect(await companies(`?mailbox=${main}`)).toEqual([{ name: "ABC", open: 4 }]);
  });
});

describe("a mailbox that is not the user's own", () => {
  it("is not found: a colleague's, another organization's, one that does not exist, or no id at all", async () => {
    for (const id of [theirs, foreign, "00000000-0000-4000-8000-000000000000", "not-a-uuid", "1' or '1'='1"]) {
      for (const url of [`/api/tasks?tab=all&mailbox=${encodeURIComponent(id)}`, `/api/today?mailbox=${encodeURIComponent(id)}`, `/api/companies?mailbox=${encodeURIComponent(id)}`]) {
        const res = await get(me, url);
        expect(res.statusCode, url).toBe(404);
        expect(res.body).not.toContain("C-secret");
        expect(res.body).not.toContain("M-ask");
      }
    }
    expect((await get(me, `/api/tasks?tab=all&mailbox=${"x".repeat(65)}`)).statusCode).toBe(400);
  });

  it("gives nobody else a view of the user's mailbox — not a colleague, not the organization's admin", async () => {
    for (const sess of [colleague, admin]) {
      for (const url of [`/api/tasks?tab=all&mailbox=${main}`, `/api/today?mailbox=${main}`, `/api/companies?mailbox=${purchasing}`]) {
        const res = await get(sess, url);
        expect(res.statusCode, url).toBe(404);
        expect(res.body).not.toContain("M-");
      }
    }
    expect(titles((await list(`tab=all&mailbox=${theirs}`, colleague)).items)).toEqual(["C-secret"]);
    expect((await get(null, `/api/today?mailbox=${main}`)).statusCode).toBe(401);
  });
});

describe("POST /api/tasks with a mailbox", () => {
  const create = (body: object, sess: Session = me) => api(h, sess, "POST", "/api/tasks", { title: "Χειροκίνητη", status: "ACTION_REQUIRED", ...body });
  const mailboxOf = async (res: Awaited<ReturnType<typeof create>>) => {
    expect(res.statusCode).toBe(200);
    return ((await get(me, `/api/tasks/${(res.json() as { id: string }).id}`)).json() as TaskDetail).mailboxId;
  };

  it("puts a task entered by hand in the mailbox the user chose; without one it belongs to none of two", async () => {
    expect(await mailboxOf(await create({ mailboxId: purchasing }))).toBe(purchasing);
    expect(await mailboxOf(await create({ mailboxId: main }))).toBe(main);
    expect(await mailboxOf(await create({}))).toBeNull();
    expect(await mailboxOf(await create({ mailboxId: null }))).toBeNull();
    // The new one is in its mailbox's view.
    expect(titles((await list(`tab=all&mailbox=${purchasing}&q=${encodeURIComponent("Χειροκίνητη")}`)).items)).toEqual(["Χειροκίνητη"]);
  });

  it("a task from a message belongs to that message's mailbox, whatever was chosen", async () => {
    const m = await insertMessage(h.t.db, { mailboxId: main, subject: "Χαμένο μήνυμα" });
    expect(await mailboxOf(await create({ fromMessageId: m.id, mailboxId: purchasing }))).toBe(main);
  });

  it("refuses a mailbox that is not the user's own, and creates nothing", async () => {
    const before = (await h.t.db.select({ id: s.tasks.id }).from(s.tasks)).length;
    for (const mailboxId of [theirs, foreign, "00000000-0000-4000-8000-000000000000", "nope"]) expect((await create({ mailboxId })).statusCode).toBe(404);
    expect((await h.t.db.select({ id: s.tasks.id }).from(s.tasks)).length).toBe(before);
  });
});

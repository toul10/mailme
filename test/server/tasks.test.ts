import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as s from "../../src/db/schema.js";
import * as ua from "../../src/engine/user-actions.js";
import type { TaskDetail, TaskListResponse, TaskTab } from "../../src/server/api-types.js";
import { insertMessage, insertTask, insertThread } from "../helpers/db.js";
import { addUser, api, makeHarness, sessionFor, type Harness, type Session } from "./helpers.js";

vi.mock("../../src/engine/user-actions.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../src/engine/user-actions.js")>();
  return {
    ...orig,
    completeTask: vi.fn(async () => {}),
    dismissTask: vi.fn(async () => {}),
    reopenTask: vi.fn(async () => {}),
    snoozeTask: vi.fn(async () => {}),
    unsnoozeTask: vi.fn(async () => {}),
    editTask: vi.fn(async () => {}),
    mergeTasks: vi.fn(async () => {}),
    confirmTask: vi.fn(async () => {}),
    markStillValid: vi.fn(async () => {}),
    markWouldHaveMissed: vi.fn(async () => {}),
    resolveSuggestion: vi.fn(async () => {}),
    createManualTask: vi.fn(async () => ({ id: "11111111-1111-4111-8111-111111111111", ref: 99 })),
  };
});

type TaskRow = typeof s.tasks.$inferSelect;

let h: Harness;
let me: Session;
let other: Session;
let admin: Session;
const T: Record<string, TaskRow> = {};
let otherTask: TaskRow;
let otherMessageId: string;
let suggestionEventId: string;

async function seedTask(name: string, patch: Partial<typeof s.tasks.$inferInsert>, base: { title: string; company: string; status?: TaskRow["status"] }) {
  const row = await insertTask(h.t.db, { orgId: h.seed.org.id, userId: h.seed.user.id, mailboxId: h.seed.mailbox.id, title: base.title, company: base.company, status: base.status });
  const [updated] = await h.t.db.update(s.tasks).set(patch).where(eq(s.tasks.id, row.id)).returning();
  T[name] = updated!;
  return updated!;
}

beforeAll(async () => {
  h = await makeHarness(); // clock: 2026-09-15 07:00Z = Tuesday 10:00 Athens
  const at = (iso: string) => new Date(iso);
  await seedTask("overdue", { dueDate: "2026-09-10", lastActivityAt: at("2026-09-10T08:00:00Z"), createdAt: at("2026-09-08T08:00:00Z") }, { title: "ABC — Αποστολή προσφοράς", company: "ABC" });
  await seedTask("promise", { status: "WAITING_FOR_ME", dueDate: "2026-09-20", lastActivityAt: at("2026-09-11T08:00:00Z"), waitingSince: at("2026-09-11T08:00:00Z") }, { title: "Δέλτα — Παράδοση ηχείων", company: "Δέλτα" });
  await seedTask(
    "waiting",
    { status: "WAITING_FOR_OTHER", ownerKind: "EXTERNAL", expectReplyBy: "2026-09-18", waitingSince: at("2026-09-10T08:00:00Z"), lastActivityAt: at("2026-09-10T09:00:00Z") },
    { title: "ABC — Επιβεβαίωση παραγγελίας", company: "ABC" },
  );
  await seedTask("snoozed", { snoozedUntil: "2026-09-20", snoozeMode: "until_date" }, { title: "Γάμμα — Κλήση", company: "Γάμμα" });
  await seedTask("internal", { ownerKind: "INTERNAL", ownerName: "Συνάδελφος" }, { title: "Γάμμα — Έλεγχος αποθήκης", company: "Γάμμα" });
  await seedTask("closed", { closedAt: at("2026-09-12T08:00:00Z"), closedBy: "user" }, { title: "ABC — Τιμολόγηση", company: "ABC", status: "COMPLETED" });
  await seedTask("oldClosed", { closedAt: at("2026-07-01T08:00:00Z") }, { title: "ABC — Παλιό", company: "ABC", status: "DISMISSED" });
  await seedTask("review", { needsReview: true, reviewReasons: ["fuzzy_grounding"], priority: "HIGH" }, { title: "Ωμέγα — Προσφορά καλωδίων", company: "Ωμέγα" });
  await seedTask("untilReply", { status: "WAITING_FOR_OTHER", snoozeMode: "until_reply", snoozedUntil: null }, { title: "Δέλτα — Απάντηση για δείγματα", company: "Δέλτα" });
  await seedTask("unknownOwner", { ownerKind: "UNKNOWN" }, { title: "ABC — Ερώτηση για εγγύηση", company: "ABC" });

  // Linked messages + events for the detail view.
  const th = await insertThread(h.t.db, h.seed.mailbox.id);
  const longNew = "Καλημέρα, μπορείτε να μου στείλετε την προσφορά; ".repeat(20);
  const m1 = await insertMessage(h.t.db, {
    mailboxId: h.seed.mailbox.id,
    threadId: th.id,
    subject: "Προσφορά ηχοσυστήματος",
    fromName: "Πελάτης ABC",
    sortTs: at("2026-09-08T08:00:00Z"),
    segments: [
      { id: "S1", kind: "NEW", text: longNew, author: null, date: null, truncated: false },
      { id: "S2", kind: "QUOTED", text: "ΠΑΛΙΟ ΚΕΙΜΕΝΟ ΠΟΥ ΔΕΝ ΠΡΕΠΕΙ ΝΑ ΦΑΝΕΙ", author: "x", date: null, truncated: false },
    ],
    attachments: [{ filename: "Prosfora_ABC.pdf" }],
  });
  const m2 = await insertMessage(h.t.db, { mailboxId: h.seed.mailbox.id, threadId: th.id, direction: "OUTBOUND", subject: "RE: Προσφορά ηχοσυστήματος", text: "Θα σας στείλω αύριο.", sortTs: at("2026-09-09T08:00:00Z") });
  await h.t.db.insert(s.taskLinks).values([
    { taskId: T.overdue!.id, threadId: th.id, messageId: m1.id, role: "origin" },
    { taskId: T.overdue!.id, threadId: th.id, messageId: m1.id, role: "reference" },
    { taskId: T.overdue!.id, threadId: th.id, messageId: m2.id, role: "update" },
  ]);
  const m3 = await insertMessage(h.t.db, { mailboxId: h.seed.mailbox.id, subject: "Τιμολόγιο 4521", sortTs: at("2026-09-10T08:00:00Z") });
  await h.t.db.insert(s.taskLinks).values({ taskId: T.waiting!.id, messageId: m3.id, role: "origin" });

  await h.t.db.insert(s.taskEvents).values([
    { taskId: T.overdue!.id, userId: h.seed.user.id, actor: "ai", op: "CREATE", applied: true, tier: "auto", evidenceSource: "NEW", evidenceQuote: "μπορείτε να μου στείλετε την προσφορά;", createdAt: at("2026-09-08T08:01:00Z") },
    { taskId: T.overdue!.id, userId: h.seed.user.id, actor: "user", op: "USER_SNOOZE", applied: true, after: { snoozedUntil: "2026-09-09", snoozeMode: "until_date" }, createdAt: at("2026-09-08T09:00:00Z") },
  ]);
  const [sugg] = await h.t.db
    .insert(s.taskEvents)
    .values({
      taskId: T.overdue!.id,
      userId: h.seed.user.id,
      actor: "ai",
      op: "UPDATE",
      applied: false,
      tier: "review",
      suggestionState: "pending",
      after: { dueDate: "2026-09-20" },
      reasons: ["locked_field"],
      createdAt: at("2026-09-09T08:01:00Z"),
    })
    .returning();
  suggestionEventId = sugg!.id;
  await h.t.db.insert(s.taskEvents).values({ taskId: T.unknownOwner!.id, userId: h.seed.user.id, actor: "ai", op: "COMPLETE", applied: false, suggestionState: "pending" });

  // A second user in another org, and an admin in the same org.
  const [org2] = await h.t.db.insert(s.organizations).values({ name: "Other" }).returning();
  const userB = await addUser(h, { email: "b@other-gr.example", orgId: org2!.id });
  const [mbB] = await h.t.db.insert(s.mailboxes).values({ orgId: org2!.id, userId: userB.id, address: "b@other-gr.example" }).returning();
  otherTask = await insertTask(h.t.db, { orgId: org2!.id, userId: userB.id, mailboxId: mbB!.id, title: "Other — secret", company: "ABC" });
  const mB = await insertMessage(h.t.db, { mailboxId: mbB!.id, subject: "Μυστικό θέμα", text: "ΜΥΣΤΙΚΟ ΚΕΙΜΕΝΟ" });
  otherMessageId = mB.id;
  // A bad link from A's task to B's message must never surface B's content.
  await h.t.db.insert(s.taskLinks).values({ taskId: T.overdue!.id, messageId: mB.id, role: "reference" });
  const adminUser = await addUser(h, { email: "admin@contoso.example", role: "admin" });

  me = await sessionFor(h, h.seed.user.id);
  other = await sessionFor(h, userB.id);
  admin = await sessionFor(h, adminUser.id);
});

afterAll(async () => {
  await h.close();
});

beforeEach(() => {
  vi.clearAllMocks();
});

async function list(sess: Session, query: string): Promise<TaskListResponse> {
  const res = await api(h, sess, "GET", `/api/tasks?${query}`);
  expect(res.statusCode).toBe(200);
  return res.json() as TaskListResponse;
}

const idsOf = (r: TaskListResponse) => r.items.map((i) => i.id);
const names = (...keys: string[]) => keys.map((k) => T[k]!.id);

describe("task lists", () => {
  it("puts each task in the right tabs and counts them", async () => {
    const todo = await list(me, "tab=todo");
    // Deadline first (overdue, then promise), then undated by priority.
    expect(idsOf(todo)).toEqual(names("overdue", "promise", "review", "unknownOwner"));
    expect(todo.counts).toEqual({ todo: 4, waiting: 1, all: 8, others: 1, review: 3, closed: 1, earlier: 0 } satisfies Record<TaskTab, number>);
    expect(idsOf(await list(me, "tab=waiting"))).toEqual(names("waiting"));
    expect(new Set(idsOf(await list(me, "tab=all")))).toEqual(new Set(names("overdue", "promise", "waiting", "snoozed", "internal", "review", "untilReply", "unknownOwner")));
    expect(idsOf(await list(me, "tab=others"))).toEqual(names("internal"));
    // needs_review, or a pending suggestion (overdue has one).
    expect(new Set(idsOf(await list(me, "tab=review")))).toEqual(new Set(names("review", "unknownOwner", "overdue")));
    expect(idsOf(await list(me, "tab=closed"))).toEqual(names("closed"));
    expect(idsOf(await list(me, "tab=earlier"))).toEqual([]);
    // review=1 narrows any tab.
    expect(new Set(idsOf(await list(me, "tab=todo&review=1")))).toEqual(new Set(names("review", "unknownOwner", "overdue")));
    expect(idsOf(await list(me, "tab=waiting&review=1"))).toEqual([]);
  });

  it("computes overdue, days open and business days waiting in the org timezone", async () => {
    const todo = await list(me, "tab=todo");
    const overdue = todo.items.find((i) => i.id === T.overdue!.id)!;
    expect(overdue).toMatchObject({ overdue: true, daysOpen: 7, businessDaysWaiting: null, company: "ABC", dueDate: "2026-09-10", status: "ACTION_REQUIRED" });
    const promise = todo.items.find((i) => i.id === T.promise!.id)!;
    // Fri 11 → Tue 15: Mon + Tue = 2 business days.
    expect(promise).toMatchObject({ overdue: false, businessDaysWaiting: 2 });
    const waiting = (await list(me, "tab=waiting")).items[0]!;
    expect(waiting).toMatchObject({ businessDaysWaiting: 3, expectReplyBy: "2026-09-18", ownerKind: "EXTERNAL" });
    const unknown = todo.items.find((i) => i.id === T.unknownOwner!.id)!;
    expect(unknown.pendingSuggestions).toBe(1);
  });

  it("filters by company and searches titles (accent-insensitive) and linked subjects", async () => {
    expect(new Set(idsOf(await list(me, `tab=all&company=${encodeURIComponent("Δέλτα")}`)))).toEqual(new Set(names("promise", "untilReply")));
    const byCompany = await list(me, "tab=todo&company=ABC");
    expect(byCompany.counts.todo).toBe(2);
    expect(idsOf(await list(me, `tab=all&q=${encodeURIComponent("ΠΡΟΣΦΟΡΑΣ")}`))).toEqual(names("overdue"));
    expect(new Set(idsOf(await list(me, `tab=all&q=${encodeURIComponent("προσφορ")}`)))).toEqual(new Set(names("overdue", "review")));
    expect(idsOf(await list(me, "tab=all&q=4521"))).toEqual(names("waiting"));
    expect(idsOf(await list(me, `tab=all&q=${encodeURIComponent("ηχοσυστήματος")}`))).toEqual(names("overdue"));
    const none = await list(me, `tab=all&q=${encodeURIComponent("100%_")}`);
    expect(none.items).toEqual([]);
    expect(none.counts.all).toBe(0);
    // Another user's subjects are not searchable.
    expect((await list(me, `tab=all&q=${encodeURIComponent("Μυστικό")}`)).items).toEqual([]);
  });

  it("pages with a keyset cursor without gaps or duplicates", async () => {
    for (const [tab, limit] of [
      ["all", 1],
      ["todo", 3],
      ["all", 3],
    ] as const) {
      const full = idsOf(await list(me, `tab=${tab}&limit=100`));
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 20; i++) {
        const page: TaskListResponse = await list(me, `tab=${tab}&limit=${limit}${cursor ? `&cursor=${cursor}` : ""}`);
        seen.push(...idsOf(page));
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      expect(seen).toEqual(full);
    }
    const bad = await api(h, me, "GET", "/api/tasks?tab=todo&cursor=garbage");
    expect(bad.statusCode).toBe(400);
    const page1 = await list(me, "tab=all&limit=1");
    expect((await api(h, me, "GET", `/api/tasks?tab=todo&cursor=${page1.nextCursor}`)).statusCode).toBe(400);
  });

  it("lists companies with open counts", async () => {
    const res = await api(h, me, "GET", "/api/companies");
    expect(res.json()).toEqual({
      companies: [
        { name: "ABC", open: 3 },
        { name: "Γάμμα", open: 2 },
        { name: "Δέλτα", open: 2 },
        { name: "Ωμέγα", open: 1 },
      ],
    });
  });
});

describe("task detail", () => {
  it("returns linked messages with NEW-segment excerpts, events with readable summaries, and pending suggestions", async () => {
    const res = await api(h, me, "GET", `/api/tasks/${T.overdue!.id}`);
    expect(res.statusCode).toBe(200);
    const d = res.json() as TaskDetail;
    expect(d.messages).toHaveLength(2);
    const [origin, reply] = d.messages;
    expect(origin!.role).toBe("origin");
    expect(origin!.excerpt.length).toBeLessThanOrEqual(500);
    expect(origin!.excerpt.startsWith("Καλημέρα")).toBe(true);
    expect(origin!.excerpt).not.toContain("ΠΑΛΙΟ");
    expect(origin!.attachments).toEqual(["Prosfora_ABC.pdf"]);
    expect(reply).toMatchObject({ role: "update", direction: "OUTBOUND", excerpt: "Θα σας στείλω αύριο." });
    expect(JSON.stringify(d)).not.toContain("ΜΥΣΤΙΚΟ");
    // B's message (linked by mistake, and later than m2) is never the "last message" either.
    expect(JSON.stringify(d)).not.toContain("Μυστικό");
    expect(d.lastMessage).toMatchObject({ subject: "RE: Προσφορά ηχοσυστήματος", direction: "OUTBOUND", author: { isOwner: true } });
    expect(d.evidence).toMatchObject({ quote: "μπορείτε να μου στείλετε την προσφορά;", source: "NEW", messageId: null, author: null });
    expect(d.events.map((e) => e.summary)).toEqual(["Created from email", "Snoozed until 9 Sep 2026", "Suggestion: Due date → 20 Sep 2026"]);
    expect(d.events[0]).toMatchObject({ actor: "ai", tier: "auto", evidenceSource: "NEW", evidenceQuote: "μπορείτε να μου στείλετε την προσφορά;" });
    expect(d.suggestions.map((e) => e.id)).toEqual([suggestionEventId]);
    expect(d.suggestions[0]!.reasons).toEqual(["You changed this field yourself"]);
    expect(d.pendingSuggestions).toBe(1);
    expect(d.createdAt).toBe("2026-09-08T08:00:00.000Z");
  });

  it("404s for malformed and unknown ids", async () => {
    expect((await api(h, me, "GET", "/api/tasks/not-a-uuid")).statusCode).toBe(404);
    expect((await api(h, me, "GET", "/api/tasks/00000000-0000-4000-8000-000000000000")).json().code).toBe("not_found");
  });
});

describe("tenant isolation", () => {
  it("another user can't see, change or reference someone else's tasks", async () => {
    const bList = await list(other, "tab=all");
    expect(idsOf(bList)).toEqual([otherTask.id]);
    expect(bList.counts.all).toBe(1);
    expect((await api(h, other, "GET", `/api/tasks/${T.overdue!.id}`)).statusCode).toBe(404);
    expect((await api(h, other, "PATCH", `/api/tasks/${T.overdue!.id}`, { version: 1, nextAction: "x" })).statusCode).toBe(404);
    expect((await api(h, other, "POST", `/api/tasks/${T.overdue!.id}/actions`, { action: "complete" })).statusCode).toBe(404);
    expect((await api(h, other, "POST", `/api/suggestions/${suggestionEventId}`, { decision: "accept" })).statusCode).toBe(404);
    expect((await api(h, other, "POST", "/api/tasks/merge", { survivorId: otherTask.id, mergedId: T.overdue!.id })).statusCode).toBe(404);
    const bulk = await api(h, other, "POST", "/api/tasks/bulk", { ids: [T.overdue!.id], action: { action: "complete" } });
    expect(bulk.json()).toEqual({ done: 0, conflicts: [T.overdue!.id] });
    expect((await api(h, me, "POST", "/api/tasks", { title: "x", status: "ACTION_REQUIRED", fromMessageId: otherMessageId })).statusCode).toBe(404);
    expect(vi.mocked(ua.editTask)).not.toHaveBeenCalled();
    expect(vi.mocked(ua.completeTask)).not.toHaveBeenCalled();
    expect(vi.mocked(ua.resolveSuggestion)).not.toHaveBeenCalled();
    expect(vi.mocked(ua.mergeTasks)).not.toHaveBeenCalled();
    expect(vi.mocked(ua.createManualTask)).not.toHaveBeenCalled();
  });

  it("the admin role gets no access to other users' task content", async () => {
    expect((await api(h, admin, "GET", `/api/tasks/${T.overdue!.id}`)).statusCode).toBe(404);
    const adminList = await list(admin, "tab=all");
    expect(adminList.items).toEqual([]);
    expect(adminList.counts.all).toBe(0);
    expect((await api(h, admin, "GET", "/api/companies")).json()).toEqual({ companies: [] });
  });
});

describe("task mutations", () => {
  it("dispatches each action to user-actions with the session user, version and via=web", async () => {
    const id = T.overdue!.id;
    const cases: Array<[object, () => void]> = [
      [{ action: "complete", version: 3 }, () => expect(vi.mocked(ua.completeTask)).toHaveBeenCalledWith(expect.objectContaining({ userId: h.seed.user.id, expectedVersion: 3, via: "web" }), id)],
      [{ action: "dismiss", kind: "handled_by_other" }, () => expect(vi.mocked(ua.dismissTask)).toHaveBeenCalledWith(expect.anything(), id, "handled_by_other")],
      [{ action: "reopen" }, () => expect(vi.mocked(ua.reopenTask)).toHaveBeenCalledWith(expect.anything(), id)],
      [{ action: "snooze", mode: "until_date", until: "2026-09-22" }, () => expect(vi.mocked(ua.snoozeTask)).toHaveBeenCalledWith(expect.anything(), id, "until_date", "2026-09-22")],
      [{ action: "snooze", mode: "until_reply", until: null }, () => expect(vi.mocked(ua.snoozeTask)).toHaveBeenCalledWith(expect.anything(), id, "until_reply", null)],
      [{ action: "unsnooze" }, () => expect(vi.mocked(ua.unsnoozeTask)).toHaveBeenCalledWith(expect.anything(), id)],
      [{ action: "confirm" }, () => expect(vi.mocked(ua.confirmTask)).toHaveBeenCalledWith(expect.anything(), id)],
      [{ action: "still_valid" }, () => expect(vi.mocked(ua.markStillValid)).toHaveBeenCalledWith(expect.anything(), id)],
      [{ action: "would_have_missed" }, () => expect(vi.mocked(ua.markWouldHaveMissed)).toHaveBeenCalledWith(expect.anything(), id)],
    ];
    for (const [payload, check] of cases) {
      const res = await api(h, me, "POST", `/api/tasks/${id}/actions`, payload);
      expect(res.statusCode).toBe(200);
      expect((res.json() as TaskDetail).id).toBe(id);
      check();
    }
    const ctx = vi.mocked(ua.reopenTask).mock.calls[0]![0];
    expect(ctx.expectedVersion).toBeUndefined();
  });

  it("validates action payloads", async () => {
    const id = T.overdue!.id;
    for (const bad of [{ action: "explode" }, { action: "snooze", mode: "until_date", until: null }, { action: "snooze", mode: "until_date", until: "2026-02-30" }, { action: "dismiss", kind: "whatever" }, {}]) {
      const res = await api(h, me, "POST", `/api/tasks/${id}/actions`, bad);
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe("invalid");
    }
    expect(vi.mocked(ua.snoozeTask)).not.toHaveBeenCalled();
  });

  it("maps ConflictError to 409 and NotFoundError to 404", async () => {
    vi.mocked(ua.completeTask).mockRejectedValueOnce(new ua.ConflictError("version"));
    const conflict = await api(h, me, "POST", `/api/tasks/${T.overdue!.id}/actions`, { action: "complete", version: 1 });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe("conflict");
    vi.mocked(ua.editTask).mockRejectedValueOnce(new ua.NotFoundError("gone"));
    const nf = await api(h, me, "PATCH", `/api/tasks/${T.overdue!.id}`, { version: 1, priority: "HIGH" });
    expect(nf.statusCode).toBe(404);
  });

  it("edits only the provided fields with the expected version", async () => {
    const res = await api(h, me, "PATCH", `/api/tasks/${T.overdue!.id}`, { version: 4, nextAction: "  Τηλεφώνησε  ", dueDate: null, counterpartyAddress: "Client@abc-gr.example" });
    expect(res.statusCode).toBe(200);
    expect(vi.mocked(ua.editTask)).toHaveBeenCalledWith(expect.objectContaining({ expectedVersion: 4, userId: h.seed.user.id }), T.overdue!.id, {
      nextAction: "Τηλεφώνησε",
      dueDate: null,
      counterpartyAddress: "client@abc-gr.example",
    });
    expect((await api(h, me, "PATCH", `/api/tasks/${T.overdue!.id}`, { version: 4 })).statusCode).toBe(400);
    expect((await api(h, me, "PATCH", `/api/tasks/${T.overdue!.id}`, { nextAction: "x" })).statusCode).toBe(400);
    expect((await api(h, me, "PATCH", `/api/tasks/${T.overdue!.id}`, { version: 4, status: "COMPLETED" })).statusCode).toBe(400);
  });

  it("creates manual tasks, merges and resolves suggestions", async () => {
    const created = await api(h, me, "POST", "/api/tasks", { title: "  Νέα εκκρεμότητα ", status: "ACTION_REQUIRED", dueDate: "2026-09-30", fromMessageId: null });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toEqual({ id: "11111111-1111-4111-8111-111111111111", ref: 99 });
    expect(vi.mocked(ua.createManualTask)).toHaveBeenCalledWith(expect.objectContaining({ userId: h.seed.user.id, via: "web" }), {
      title: "Νέα εκκρεμότητα",
      status: "ACTION_REQUIRED",
      dueDate: "2026-09-30",
      fromMessageId: null,
      mailboxId: null,
    });
    expect((await api(h, me, "POST", "/api/tasks", { status: "ACTION_REQUIRED" })).statusCode).toBe(400);

    const merged = await api(h, me, "POST", "/api/tasks/merge", { survivorId: T.overdue!.id, mergedId: T.review!.id });
    expect(merged.statusCode).toBe(200);
    expect((merged.json() as TaskDetail).id).toBe(T.overdue!.id);
    expect(vi.mocked(ua.mergeTasks)).toHaveBeenCalledWith(expect.anything(), T.overdue!.id, T.review!.id);
    expect((await api(h, me, "POST", "/api/tasks/merge", { survivorId: T.overdue!.id, mergedId: T.overdue!.id })).statusCode).toBe(400);

    const sugg = await api(h, me, "POST", `/api/suggestions/${suggestionEventId}`, { decision: "reject" });
    expect(sugg.statusCode).toBe(200);
    expect((sugg.json() as TaskDetail).id).toBe(T.overdue!.id);
    expect(vi.mocked(ua.resolveSuggestion)).toHaveBeenCalledWith(expect.objectContaining({ userId: h.seed.user.id }), suggestionEventId, "reject");
    expect((await api(h, me, "POST", `/api/suggestions/${suggestionEventId}`, { decision: "maybe" })).statusCode).toBe(400);
  });

  it("bulk actions report done and conflicts", async () => {
    vi.mocked(ua.completeTask).mockImplementation(async (_ctx, taskId) => {
      if (taskId === T.promise!.id) throw new ua.ConflictError("closed");
    });
    const res = await api(h, me, "POST", "/api/tasks/bulk", { ids: [T.overdue!.id, T.promise!.id, otherTask.id, "garbage"], action: { action: "complete" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ done: 1, conflicts: [T.promise!.id, otherTask.id, "garbage"] });
    expect(vi.mocked(ua.completeTask)).toHaveBeenCalledTimes(2);
    vi.mocked(ua.completeTask).mockReset();
  });

  it("requires a full session and CSRF for mutations", async () => {
    const pre = await sessionFor(h, h.seed.user.id, false);
    expect((await api(h, pre, "GET", "/api/tasks")).json().code).toBe("mfa_required");
    const noCsrf = await h.app.inject({ method: "POST", url: `/api/tasks/${T.overdue!.id}/actions`, cookies: me.cookies, payload: { action: "complete" } });
    expect(noCsrf.statusCode).toBe(403);
    expect((await api(h, null, "GET", "/api/tasks")).statusCode).toBe(401);
    expect(vi.mocked(ua.completeTask)).not.toHaveBeenCalled();
  });
});

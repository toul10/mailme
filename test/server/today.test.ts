import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as s from "../../src/db/schema.js";
import type { PersonRef, TaskDetail, TaskListItem, TaskListResponse, TodayResponse } from "../../src/server/api-types.js";
import { clipQuote, personOf } from "../../src/server/queries.js";
import { TRIAGE_CAP } from "../../src/server/today.js";
import { insertMessage, insertTask, insertThread } from "../helpers/db.js";
import { addUser, api, makeHarness, sessionFor, type Harness, type Session } from "./helpers.js";

type TaskRow = typeof s.tasks.$inferSelect;
type MessageRow = typeof s.messages.$inferSelect;

let h: Harness;
let me: Session;
let userB: Session;
let userC: Session;
let userD: Session;
let admin: Session;
const T: Record<string, TaskRow> = {};
const M: Record<string, MessageRow> = {};
const E: Record<string, string> = {};
let bTask: TaskRow;

const at = (iso: string) => new Date(iso);
/** A body marker: message bodies must never reach /api/today (only evidence quotes and subjects do). */
const BODY = "ΚΕΙΜΕΝΟΣΩΜΑΤΟΣ";
const LONG_QUOTE =
  "Καλησπέρα σας, μπορείτε να μας στείλετε αντίγραφο του τιμολογίου 2026-1187 μέχρι την Τρίτη; " +
  "Το λογιστήριο το χρειάζεται για το κλείσιμο του μήνα και δεν το βρίσκουμε στα αρχεία μας, " +
  "οπότε θα βοηθούσε πολύ αν το στέλνατε και σε μορφή PDF μαζί με το δελτίο αποστολής της παραγγελίας.";

async function task(name: string, patch: Partial<typeof s.tasks.$inferInsert>, opts: { userId?: string; mailboxId?: string; orgId?: string } = {}) {
  const row = await insertTask(h.t.db, {
    orgId: opts.orgId ?? h.seed.org.id,
    userId: opts.userId ?? h.seed.user.id,
    mailboxId: opts.mailboxId ?? h.seed.mailbox.id,
    title: `Εργασία ${name}`,
    company: "ABC",
  });
  const [updated] = await h.t.db
    .update(s.tasks)
    .set({ createdAt: at("2026-09-05T08:00:00Z"), lastActivityAt: at("2026-09-10T08:00:00Z"), ...patch })
    .where(eq(s.tasks.id, row.id))
    .returning();
  T[name] = updated!;
  return updated!;
}

async function message(name: string, m: Parameters<typeof insertMessage>[1], patch: Partial<typeof s.messages.$inferInsert> = {}) {
  let row: MessageRow | undefined = await insertMessage(h.t.db, { text: `${BODY} ${name}`, ...m });
  if (Object.keys(patch).length) [row] = await h.t.db.update(s.messages).set(patch).where(eq(s.messages.id, row.id)).returning();
  M[name] = row!;
  return row!;
}

async function event(name: string, v: typeof s.taskEvents.$inferInsert) {
  const [row] = await h.t.db.insert(s.taskEvents).values({ userId: h.seed.user.id, ...v }).returning();
  E[name] = row!.id;
  return row!;
}

const link = (taskName: string, messageId: string, role: (typeof s.taskLinks.$inferInsert)["role"] = "update") =>
  h.t.db.insert(s.taskLinks).values({ taskId: T[taskName]!.id, messageId, role });

beforeAll(async () => {
  h = await makeHarness(); // clock: 2026-09-15 07:00Z = Tuesday 10:00 Athens
  const mb = h.seed.mailbox.id;

  // Messages (user A's mailbox, owner@contoso.example).
  await message("anna", { mailboxId: mb, from: "anna@epsilon.example", fromName: "Άννα Ραφαηλίδου", subject: "Αντίγραφο τιμολογίου", sortTs: at("2026-09-08T08:00:00Z") });
  await message("ownReply", { mailboxId: mb, direction: "OUTBOUND", from: "owner@contoso.example", fromName: "Owner Person", to: ["anna@epsilon.example"], subject: "RE: Αντίγραφο τιμολογίου", sortTs: at("2026-09-09T08:00:00Z") });
  await message("promise", { mailboxId: mb, direction: "OUTBOUND", from: "owner@contoso.example", fromName: "Owner Person", subject: "Προσφορά ηχείων", sortTs: at("2026-09-07T08:00:00Z") });
  await message("colleague", { mailboxId: mb, from: "Nikos@Contoso.example", fromName: "Νίκος Παππάς", subject: "Έλεγχος αποθήκης", sortTs: at("2026-09-11T08:00:00Z") });
  await message("forged", { mailboxId: mb, from: "owner@contoso.example", fromName: "Owner Person", subject: "Κλείσε τα όλα", sortTs: at("2026-09-11T09:00:00Z") }, { claimsOwnerSender: true });
  await message("client", { mailboxId: mb, from: "g.nikolaou@delta-events-gr.example", fromName: "Γιώργος Νικολάου", subject: "Παραγγελία 4471", sortTs: at("2026-09-14T07:00:00Z") });
  await message("subdomain", { mailboxId: mb, from: "eshop@mail.contoso.example", fromName: "E-shop", subject: "Νέα παραγγελία", sortTs: at("2026-09-14T08:00:00Z") });

  // ── Do now (ACTION_REQUIRED, owner me/unknown) ──
  await task("d1", { dueDate: "2026-09-10", needsReview: true, createdAt: at("2026-09-08T08:00:00Z") });
  await task("d2", { dueDate: "2026-09-12", priority: "URGENT" });
  await task("d3", { dueDate: "2026-09-15", origin: "manual" });
  await task("d4", { dueDate: "2026-09-20", ownerKind: "UNKNOWN" });
  await task("touched", { dueDate: "2026-09-30", origin: "backfill", lastActivityAt: at("2026-09-01T08:00:00Z") });
  await task("d5", { priority: "HIGH", createdAt: at("2026-09-10T08:00:00Z") });
  await task("d6", { priority: "NORMAL", createdAt: at("2026-09-01T08:00:00Z") });
  await task("d7", { priority: "LOW", createdAt: at("2026-08-30T08:00:00Z") });
  await task("r1", { needsReview: true, createdAt: at("2026-09-14T08:00:00Z"), lastActivityAt: at("2026-09-14T08:00:00Z") });

  // ── Promised (WAITING_FOR_ME) ──
  await task("p1", { status: "WAITING_FOR_ME", dueDate: "2026-09-18", waitingSince: at("2026-09-07T08:00:00Z") });
  await task("p2", { status: "WAITING_FOR_ME", dueDate: "2026-09-16", waitingSince: at("2026-09-07T08:00:00Z") });
  await task("p3", { status: "WAITING_FOR_ME", waitingSince: at("2026-09-07T08:00:00Z") });

  // ── Waiting (WAITING_FOR_OTHER) ──
  const w = { status: "WAITING_FOR_OTHER" as const, ownerKind: "EXTERNAL" as const };
  await task("w1", { ...w, expectReplyBy: "2026-09-18", waitingSince: at("2026-09-01T08:00:00Z") });
  await task("w2", { ...w, expectReplyBy: "2026-09-15", waitingSince: at("2026-09-11T08:00:00Z") });
  await task("w3", { ...w, expectReplyBy: "2026-09-14", waitingSince: at("2026-09-08T08:00:00Z") });
  await task("w4", { ...w, expectReplyBy: null, waitingSince: at("2026-09-10T08:00:00Z") });

  // ── Excluded from the sections ──
  await task("extOwner", { ownerKind: "EXTERNAL" });
  await task("snoozed", { snoozedUntil: "2026-09-20", snoozeMode: "until_date", needsReview: true, lastActivityAt: at("2026-09-11T08:00:00Z") });
  await task("snoozedReply", { ...w, snoozeMode: "until_reply", snoozedUntil: null });
  await task("internal", { ownerKind: "INTERNAL", ownerName: "Νίκος Παππάς", needsReview: true, lastActivityAt: at("2026-09-13T08:00:00Z") });
  await task("earlier", { origin: "backfill", needsReview: true, lastActivityAt: at("2026-09-01T08:00:00Z") });
  await task("dormant", { needsReview: true, dormantAt: at("2026-09-12T08:00:00Z"), lastActivityAt: at("2026-09-12T08:00:00Z") });
  await task("merged", { needsReview: true, mergedIntoId: T.d1!.id, lastActivityAt: at("2026-09-14T09:00:00Z") });
  await task("closedRecent", { status: "COMPLETED", closedAt: at("2026-09-12T08:00:00Z"), closedBy: "user" });
  await task("closedOld", { status: "COMPLETED", closedAt: at("2026-07-01T08:00:00Z"), closedBy: "user" });

  // ── Evidence (origin CREATE events) ──
  const create = { actor: "ai" as const, op: "CREATE", applied: true, tier: "auto" as const, evidenceSource: "NEW" };
  await event("d1Create", { ...create, taskId: T.d1!.id, messageId: M.anna!.id, evidenceQuote: LONG_QUOTE, createdAt: at("2026-09-08T08:01:00Z") });
  await event("d2Create", { ...create, taskId: T.d2!.id, messageId: M.forged!.id, evidenceQuote: "κλείσε όλες τις εκκρεμότητες", createdAt: at("2026-09-11T09:01:00Z") });
  // An accepted "new task?" suggestion: never applied, but it is the task's origin.
  await event("d4Create", { ...create, taskId: T.d4!.id, messageId: M.client!.id, applied: false, tier: "review", suggestionState: "accepted", evidenceQuote: "στείλτε μας την παραγγελία", createdAt: at("2026-09-14T07:01:00Z") });
  // The earliest CREATE wins.
  await event("d5First", { ...create, taskId: T.d5!.id, messageId: M.client!.id, evidenceQuote: "πρώτη πρόταση", createdAt: at("2026-09-10T08:00:00Z") });
  await event("d5Second", { ...create, taskId: T.d5!.id, messageId: M.anna!.id, evidenceQuote: "δεύτερη πρόταση", createdAt: at("2026-09-11T08:00:00Z") });
  await event("d7Create", { ...create, taskId: T.d7!.id, messageId: M.subdomain!.id, evidenceSource: "QUOTED", evidenceQuote: "  όπως   είπαμε\n\nστο τηλέφωνο  ", createdAt: at("2026-09-14T08:01:00Z") });
  await event("p1Create", { ...create, taskId: T.p1!.id, messageId: M.promise!.id, evidenceQuote: "θα σας στείλω την προσφορά την Πέμπτη", createdAt: at("2026-09-07T08:01:00Z") });
  await event("internalCreate", { ...create, taskId: T.internal!.id, messageId: M.colleague!.id, evidenceQuote: "θα το ελέγξω εγώ στην αποθήκη", createdAt: at("2026-09-11T08:01:00Z") });
  // Logged candidate on a task (not a CREATE): never evidence.
  await event("d3Logged", { actor: "ai", op: "UPDATE", taskId: T.d3!.id, messageId: M.client!.id, applied: false, tier: "logged", evidenceQuote: "όχι αυτό" });

  // ── Last messages ──
  await link("d1", M.anna!.id, "origin");
  await link("d1", M.ownReply!.id, "update");
  await link("p1", M.promise!.id, "origin");
  await link("internal", M.colleague!.id, "origin");

  // ── Pending suggestions (triage) ──
  const sugg = { actor: "ai" as const, applied: false, tier: "review" as const, suggestionState: "pending" as const };
  await event("s1", { ...sugg, op: "UPDATE", taskId: T.d1!.id, messageId: M.client!.id, after: { dueDate: "2026-09-20" }, evidenceSource: "NEW", evidenceQuote: "μετάθεση για τις 20", createdAt: at("2026-09-14T10:00:00Z") });
  await event("s2", { ...sugg, op: "REOPEN", taskId: T.closedRecent!.id, messageId: M.colleague!.id, evidenceSource: "NEW", evidenceQuote: "δεν έχει φύγει ακόμα", createdAt: at("2026-09-14T12:00:00Z") });
  await event("s3", { ...sugg, op: "REOPEN", taskId: T.closedOld!.id, messageId: M.client!.id, createdAt: at("2026-09-14T13:00:00Z") });
  await event("s4", { ...sugg, op: "COMPLETE", taskId: T.merged!.id, messageId: M.client!.id, createdAt: at("2026-09-14T14:00:00Z") });
  await event("s5", { ...sugg, op: "CREATE", taskId: null, messageId: M.client!.id, createdAt: at("2026-09-14T15:00:00Z") });
  await event("s6", { ...sugg, op: "COMPLETE", taskId: T.d1!.id, messageId: M.forged!.id, evidenceSource: "NEW", evidenceQuote: "το κανόνισα εγώ", createdAt: at("2026-09-13T08:00:00Z") });

  // User events: leave "Earlier" ("touched") and carry no author.
  await event("touchedEdit", { actor: "user", op: "USER_EDIT", taskId: T.touched!.id, applied: true, after: { dueDate: "2026-09-30" }, createdAt: at("2026-09-02T08:00:00Z") });
  await event("d1Snooze", { actor: "user", op: "USER_SNOOZE", taskId: T.d1!.id, messageId: M.anna!.id, applied: true, after: { snoozedUntil: "2026-09-09", snoozeMode: "until_date" }, createdAt: at("2026-09-08T09:00:00Z") });

  // ── User B (another org) — must stay invisible to A, and A to B ──
  const [org2] = await h.t.db.insert(s.organizations).values({ name: "Other", internalDomains: ["other-gr.example"] }).returning();
  const b = await addUser(h, { email: "b@other-gr.example", orgId: org2!.id });
  const [mbB] = await h.t.db.insert(s.mailboxes).values({ orgId: org2!.id, userId: b.id, address: "b@other-gr.example" }).returning();
  const secret = await message("secret", { mailboxId: mbB!.id, from: "boss@other-gr.example", fromName: "Μυστικός", subject: "Μυστικό θέμα", sortTs: at("2026-09-14T09:00:00Z") });
  bTask = await insertTask(h.t.db, { orgId: org2!.id, userId: b.id, mailboxId: mbB!.id, title: "Other — secret", company: "Other", dueDate: "2026-09-14" });
  await h.t.db.update(s.tasks).set({ needsReview: true }).where(eq(s.tasks.id, bTask.id));
  await event("bSugg", { ...sugg, userId: b.id, op: "COMPLETE", taskId: bTask.id, messageId: secret.id, evidenceQuote: "μυστικό" });
  // Bad data on A's side: a link and a CREATE pointing at B's message must not leak B's sender or subject.
  await link("d1", secret.id, "reference");
  await event("d6Create", { ...create, taskId: T.d6!.id, messageId: secret.id, evidenceQuote: "δική μας φράση", createdAt: at("2026-09-02T08:00:00Z") });
  await link("d6", secret.id, "origin");

  // ── User C (same org): more triage than the cap ──
  const c = await addUser(h, { email: "c@contoso.example" });
  const [mbC] = await h.t.db.insert(s.mailboxes).values({ orgId: h.seed.org.id, userId: c.id, address: "c@contoso.example" }).returning();
  for (let i = 0; i < 12; i++) {
    await task(`c${i}`, { needsReview: true, lastActivityAt: new Date(at("2026-09-01T08:00:00Z").getTime() + i * 3600_000) }, { userId: c.id, mailboxId: mbC!.id });
  }
  await event("cSugg", { ...sugg, userId: c.id, op: "COMPLETE", taskId: T.c0!.id, createdAt: at("2026-09-01T00:00:00Z") });

  // ── User D (same org): state evidence, forwarded authors, last message, bounces, colleagues ──
  const d = await addUser(h, { email: "d@contoso.example" });
  const [mbD] = await h.t.db.insert(s.mailboxes).values({ orgId: h.seed.org.id, userId: d.id, address: "d@contoso.example", aliases: [] }).returning();
  const onD = { userId: d.id, mailboxId: mbD!.id };
  const thD = await insertThread(h.t.db, mbD!.id, "προσφορα ηχειων");
  const mD = (name: string, m: Omit<Parameters<typeof insertMessage>[1], "mailboxId">, patch: Partial<typeof s.messages.$inferInsert> = {}) => message(name, { mailboxId: mbD!.id, ...m }, patch);
  await mD("dReq", { threadId: thD.id, from: "maria.p@abc-audio.example", fromName: "Μαρία Παπαδάκη", subject: "Προσφορά ηχείων", sortTs: at("2026-09-07T08:00:00Z") });
  await mD("dPromise", { threadId: thD.id, direction: "OUTBOUND", from: "d@contoso.example", fromName: "Demo", subject: "RE: Προσφορά ηχείων", sortTs: at("2026-09-08T08:00:00Z") });
  // A later reply that changed nothing on the task (no link), then an out-of-office (filtered): “who wrote last” is the reply.
  await mD("dReply", { threadId: thD.id, from: "maria.p@abc-audio.example", fromName: "Μαρία Παπαδάκη", subject: "RE: RE: Προσφορά ηχείων", sortTs: at("2026-09-10T08:00:00Z") }, { state: "applied" });
  await mD("dOoo", { threadId: thD.id, from: "maria.p@abc-audio.example", fromName: "Μαρία Παπαδάκη", subject: "Αυτόματη απάντηση", sortTs: at("2026-09-11T08:00:00Z") }, { state: "filtered", filterReason: "OUT_OF_OFFICE" });
  await mD("dFwd", {
    from: "maria@contoso.example",
    fromName: "Μαρία Σταύρου",
    subject: "ΠΡΘ: Πιστοποιητικά CE",
    sortTs: at("2026-09-09T09:00:00Z"),
    segments: [
      { id: "S1", kind: "NEW", text: "Ηλία, μπορείς να το αναλάβεις;", author: null, date: null, truncated: false },
      { id: "S2", kind: "FORWARDED", text: "μπορείτε να μας στείλετε τα πιστοποιητικά CE;", author: '"Άννα Κωστοπούλου" <Anna@hotelmare.example>', date: "2026-09-06T07:30:00.000Z", truncated: false },
      { id: "S3", kind: "QUOTED", text: "όπως είπαμε", author: null, date: null, truncated: false },
    ],
  });

  const dTask = (name: string, patch: Partial<typeof s.tasks.$inferInsert>) => task(name, patch, onD);
  const dEvent = (name: string, v: typeof s.taskEvents.$inferInsert) => event(name, { userId: d.id, ...v });
  // Promise: CREATE (a request) → applied UPDATE to WAITING_FOR_ME (P1's promise) → a later UPDATE without a status.
  await dTask("pw", { status: "WAITING_FOR_ME", dueDate: "2026-09-17", waitingSince: at("2026-09-08T08:00:00Z") });
  await dEvent("pwCreate", { ...create, taskId: T.pw!.id, messageId: M.dReq!.id, after: { status: "ACTION_REQUIRED" }, evidenceQuote: "μπορείτε να μου στείλετε προσφορά για 40 ηχεία οροφής;", createdAt: at("2026-09-07T08:01:00Z") });
  await dEvent("pwPromise", { ...create, op: "UPDATE", taskId: T.pw!.id, messageId: M.dPromise!.id, before: { status: "ACTION_REQUIRED" }, after: { status: "WAITING_FOR_ME", dueDate: "2026-09-17" }, evidenceQuote: "θα σας στείλω την προσφορά την Πέμπτη.", createdAt: at("2026-09-08T08:01:00Z") });
  await dEvent("pwLater", { ...create, op: "UPDATE", taskId: T.pw!.id, messageId: M.dReq!.id, after: { nextAction: "Στείλε την προσφορά" }, evidenceQuote: "άσχετη πρόταση", createdAt: at("2026-09-09T08:01:00Z") });
  await h.t.db.insert(s.taskLinks).values([
    { taskId: T.pw!.id, threadId: thD.id, messageId: M.dReq!.id, role: "origin" },
    { taskId: T.pw!.id, threadId: thD.id, messageId: M.dPromise!.id, role: "update" },
  ]);
  // Waiting: the status came from an accepted suggestion (its status lives in the payload); a rejected one never counts.
  await dTask("wa", { status: "WAITING_FOR_OTHER", ownerKind: "ME", expectReplyBy: "2026-09-18", waitingSince: at("2026-09-08T08:00:00Z") });
  await dEvent("waCreate", { ...create, taskId: T.wa!.id, messageId: M.dReq!.id, after: { status: "ACTION_REQUIRED" }, evidenceQuote: "πείτε μας τη διαθεσιμότητα", createdAt: at("2026-09-07T08:01:00Z") });
  const proposal = (status: string) => ({ kind: "suggestion", proposedType: "update", proposed: { type: "update", fields: { status } }, op: {} });
  await dEvent("waAccepted", { actor: "ai", op: "UPDATE", taskId: T.wa!.id, messageId: M.dPromise!.id, applied: false, tier: "review", suggestionState: "accepted", payload: proposal("WAITING_FOR_OTHER"), evidenceSource: "NEW", evidenceQuote: "σας ρώτησα για τον χρόνο παράδοσης", createdAt: at("2026-09-08T08:02:00Z") });
  await dEvent("waRejected", { actor: "ai", op: "UPDATE", taskId: T.wa!.id, messageId: M.dReq!.id, applied: false, tier: "review", suggestionState: "rejected", payload: proposal("WAITING_FOR_OTHER"), evidenceSource: "NEW", evidenceQuote: "απορρίφθηκε", createdAt: at("2026-09-09T08:02:00Z") });
  // Waiting since its CREATE: the CREATE is both the state and the origin.
  await dTask("wc", { status: "WAITING_FOR_OTHER", expectReplyBy: "2026-09-18", waitingSince: at("2026-09-08T08:00:00Z") });
  await dEvent("wcCreate", { ...create, taskId: T.wc!.id, messageId: M.dPromise!.id, after: { status: "WAITING_FOR_OTHER" }, evidenceQuote: "μπορείτε να μου πείτε αν έχετε 20 SM58;", createdAt: at("2026-09-08T08:01:00Z") });
  // Forwarded / quoted evidence.
  await dTask("fw", {});
  await dEvent("fwCreate", { ...create, taskId: T.fw!.id, messageId: M.dFwd!.id, evidenceSource: "FORWARDED", features: { segmentId: "S2" }, evidenceQuote: "μπορείτε να μας στείλετε τα πιστοποιητικά CE;", createdAt: at("2026-09-09T09:01:00Z") });
  await dEvent("fwSugg", { actor: "ai", op: "UPDATE", taskId: T.fw!.id, messageId: M.dFwd!.id, applied: false, tier: "review", suggestionState: "pending", features: { segmentId: "S2" }, evidenceSource: "FORWARDED", evidenceQuote: "τα πιστοποιητικά CE", createdAt: at("2026-09-09T09:02:00Z") });
  await dTask("fq", {});
  await dEvent("fqCreate", { ...create, taskId: T.fq!.id, messageId: M.dFwd!.id, evidenceSource: "QUOTED", features: { segmentId: "S3" }, evidenceQuote: "όπως είπαμε", createdAt: at("2026-09-09T09:01:00Z") });
  await dTask("fo", {});
  await dEvent("foCreate", { ...create, taskId: T.fo!.id, messageId: M.dFwd!.id, evidenceSource: "FORWARDED", evidenceQuote: "μπορείτε να μας στείλετε", createdAt: at("2026-09-09T09:01:00Z") });
  // Review: an open task, a recent bounce on a task the AI closed, an old bounce, a closed task reviewed for another reason.
  await dTask("rOpen", { needsReview: true, reviewReasons: ["low_confidence", "low_confidence"], lastActivityAt: at("2026-09-14T08:00:00Z") });
  await dTask("bounced", { status: "COMPLETED", closedBy: "ai", closedAt: at("2026-09-14T06:00:00Z"), needsReview: true, reviewReasons: ["bounce"], lastActivityAt: at("2026-09-12T08:00:00Z") });
  await dTask("bouncedOld", { status: "COMPLETED", closedBy: "ai", closedAt: at("2026-08-01T08:00:00Z"), needsReview: true, reviewReasons: ["bounce"] });
  await dTask("closedReview", { status: "COMPLETED", closedBy: "ai", closedAt: at("2026-09-14T06:00:00Z"), needsReview: true, reviewReasons: ["evidence_fuzzy"] });
  // Colleagues: named, address only, dormant (idle hand-over).
  await dTask("col", { ownerKind: "INTERNAL", ownerName: "Νίκος Παππάς", ownerAddress: "nikos@contoso.example" });
  await dTask("colAddr", { ownerKind: "INTERNAL", ownerName: null, ownerAddress: "Eleni@Contoso.example" });
  await dTask("colDormant", { ownerKind: "INTERNAL", ownerName: "Μαρία Σταύρου", dormantAt: at("2026-09-14T08:00:00Z") });

  const adminUser = await addUser(h, { email: "admin@contoso.example", role: "admin" });
  me = await sessionFor(h, h.seed.user.id);
  userB = await sessionFor(h, b.id);
  userC = await sessionFor(h, c.id);
  userD = await sessionFor(h, d.id);
  admin = await sessionFor(h, adminUser.id);
});

afterAll(async () => {
  await h.close();
});

async function today(sess: Session): Promise<TodayResponse> {
  const res = await api(h, sess, "GET", "/api/today");
  expect(res.statusCode).toBe(200);
  return res.json() as TodayResponse;
}

const ids = (items: TaskListItem[]) => items.map((i) => i.id);
const names = (...keys: string[]) => keys.map((k) => T[k]!.id);
const person = (p: Partial<PersonRef>): PersonRef => ({ name: null, address: null, isOwner: false, isInternal: false, ...p });

describe("GET /api/today — sections", () => {
  it("answers the three questions in the right order, leaving out snoozed, colleagues', “Earlier”, dormant and merged tasks", async () => {
    const r = await today(me);
    expect(r.date).toBe("2026-09-15");
    // Overdue (oldest due first) → due today → dated → undated: HIGH first, then oldest (NORMAL and LOW rank the same).
    expect(ids(r.doNow)).toEqual(names("d1", "d2", "d3", "d4", "touched", "d5", "d7", "d6", "r1"));
    expect(ids(r.promised)).toEqual(names("p2", "p1", "p3"));
    // Past the expected reply (today counts) first, then the longest wait in business days.
    expect(ids(r.waiting)).toEqual(names("w3", "w2", "w1", "w4"));
    expect(r.waiting.map((i) => i.businessDaysWaiting)).toEqual([5, 2, 10, 3]);
    expect(r.counts).toEqual({ triage: 6, doNow: 9, promised: 3, waiting: 4, snoozed: 2, others: 1, earlier: 1 });

    const everywhere = [...r.doNow, ...r.promised, ...r.waiting].map((i) => i.id);
    for (const k of ["extOwner", "snoozed", "snoozedReply", "internal", "earlier", "dormant", "merged", "closedRecent", "closedOld"]) {
      expect(everywhere).not.toContain(T[k]!.id);
    }
  });

  it("uses the same “Earlier” count as the tasks tab", async () => {
    const res = await api(h, me, "GET", "/api/tasks?tab=earlier");
    const list = res.json() as TaskListResponse;
    expect(ids(list.items)).toEqual(names("earlier"));
    expect(list.counts.earlier).toBe((await today(me)).counts.earlier);
  });
});

describe("GET /api/today — triage (“Needs a look”)", () => {
  it("lists pending suggestions newest first, then review tasks without one", async () => {
    const r = await today(me);
    expect(r.triage.map((t) => [t.kind, t.task.id, t.suggestion?.id ?? null])).toEqual([
      ["suggestion", T.closedRecent!.id, E.s2],
      ["suggestion", T.d1!.id, E.s1],
      ["suggestion", T.d1!.id, E.s6],
      // Review items: latest activity first; snoozed and colleagues' tasks are still asked about.
      ["review", T.r1!.id, null],
      ["review", T.internal!.id, null],
      ["review", T.snoozed!.id, null],
    ]);
    // Suggestions on old closed or merged tasks, and “new task?” suggestions without a task, are not triage.
    const shownEvents = r.triage.map((t) => t.suggestion?.id);
    for (const k of ["s3", "s4", "s5"]) expect(shownEvents).not.toContain(E[k]);
    expect(r.triage[0]!.task.status).toBe("COMPLETED");
    expect(r.triage[1]!.task.pendingSuggestions).toBe(2);
  });

  it("attributes each suggestion to the message it was read from", async () => {
    const r = await today(me);
    const [reopen, move, done] = r.triage;
    expect(reopen!.suggestion).toMatchObject({
      op: "REOPEN",
      summary: "Suggestion: reopen",
      evidenceQuote: "δεν έχει φύγει ακόμα",
      messageId: M.colleague!.id,
      messageAt: "2026-09-11T08:00:00.000Z",
      author: person({ name: "Νίκος Παππάς", address: "nikos@contoso.example", isInternal: true }),
    });
    expect(move!.suggestion!.author).toEqual(person({ name: "Γιώργος Νικολάου", address: "g.nikolaou@delta-events-gr.example" }));
    // A delivered "From: you" copy (claims_owner_sender) is neither "you" nor a colleague (the spoof borrows the domain).
    expect(done!.suggestion!.author).toEqual(person({ name: "Owner Person", address: "owner@contoso.example" }));
  });

  it("caps triage at 10 and still counts everything", async () => {
    const r = await today(userC);
    expect(r.triage).toHaveLength(TRIAGE_CAP);
    expect(r.counts.triage).toBe(12);
    expect(r.triage[0]).toMatchObject({ kind: "suggestion", task: { id: T.c0!.id } });
    // Then review tasks by latest activity (c0 has a pending suggestion, so it is not repeated).
    expect(r.triage.slice(1).map((t) => t.task.id)).toEqual(names("c11", "c10", "c9", "c8", "c7", "c6", "c5", "c4", "c3"));
  });
});

describe("evidence and last message", () => {
  it("quotes the origin sentence with its author and time", async () => {
    const r = await today(me);
    const item = (k: string) => [...r.doNow, ...r.promised, ...r.waiting, ...r.triage.map((t) => t.task)].find((i) => i.id === T[k]!.id)!;

    const d1 = item("d1").evidence!;
    expect(d1).toMatchObject({ source: "NEW", messageId: M.anna!.id, at: "2026-09-08T08:00:00.000Z" });
    expect(d1.author).toEqual(person({ name: "Άννα Ραφαηλίδου", address: "anna@epsilon.example" }));
    // Clipped at a word boundary with an ellipsis (…).
    expect(d1.quote.length).toBeLessThanOrEqual(221);
    expect(d1.quote.endsWith("…")).toBe(true);
    const kept = d1.quote.slice(0, -1);
    expect(LONG_QUOTE.startsWith(kept)).toBe(true);
    expect([" ", ",", ".", ";"]).toContain(LONG_QUOTE[kept.length]);

    // Your own sent mail is "you".
    expect(item("p1").evidence).toMatchObject({ quote: "θα σας στείλω την προσφορά την Πέμπτη", author: person({ name: "Owner Person", address: "owner@contoso.example", isOwner: true, isInternal: true }) });
    // A colleague (internal domain, address lower-cased).
    expect(item("internal").evidence!.author).toEqual(person({ name: "Νίκος Παππάς", address: "nikos@contoso.example", isInternal: true }));
    // A forged/delivered "From: owner" is not you, and not a colleague either.
    expect(item("d2").evidence!.author).toEqual(person({ name: "Owner Person", address: "owner@contoso.example" }));
    // An accepted "new task?" suggestion is the origin too.
    expect(item("d4").evidence).toMatchObject({ quote: "στείλτε μας την παραγγελία", messageId: M.client!.id });
    // The earliest CREATE wins.
    expect(item("d5").evidence!.quote).toBe("πρώτη πρόταση");
    // QUOTED evidence is kept (whitespace collapsed); with no quoted author it is not pinned on whoever quoted it,
    // but the message is kept for the in-thread highlight.
    expect(item("d7").evidence).toEqual({ quote: "όπως είπαμε στο τηλέφωνο", source: "QUOTED", messageId: M.subdomain!.id, author: null, at: null });
    // Without a later status-setting event the origin is the evidence, and there is no separate origin.
    expect(item("p1").originEvidence).toBeNull();
    expect(item("d1").originEvidence).toBeNull();
    // Manual tasks and tasks without an AI CREATE have none.
    expect(item("d3").evidence).toBeNull();
    expect(item("p2").evidence).toBeNull();
    // Evidence from a message outside the user's mailboxes keeps the quote but says nothing about the message.
    expect(item("d6").evidence).toEqual({ quote: "δική μας φράση", source: "NEW", messageId: null, author: null, at: null });
  });

  it("shows who wrote last, from the user's own mailboxes only", async () => {
    const r = await today(me);
    const d1 = r.doNow.find((i) => i.id === T.d1!.id)!;
    // B's later message linked by mistake is ignored.
    expect(d1.lastMessage).toEqual({
      author: person({ name: "Owner Person", address: "owner@contoso.example", isOwner: true, isInternal: true }),
      at: "2026-09-09T08:00:00.000Z",
      subject: "RE: Αντίγραφο τιμολογίου",
      direction: "OUTBOUND",
    });
    expect(r.promised.find((i) => i.id === T.p1!.id)!.lastMessage).toMatchObject({ subject: "Προσφορά ηχείων", direction: "OUTBOUND" });
    expect(r.doNow.find((i) => i.id === T.d6!.id)!.lastMessage).toBeNull();
    expect(r.doNow.find((i) => i.id === T.d3!.id)!.lastMessage).toBeNull();
    const json = JSON.stringify(r);
    expect(json).not.toContain("Μυστικ");
    expect(json).not.toContain("boss@other-gr.example");
    // No message bodies: only quotes and subjects.
    expect(json).not.toContain(BODY);
  });

  it("fills the task list and the task page the same way", async () => {
    const list = (await api(h, me, "GET", "/api/tasks?tab=todo")).json() as TaskListResponse;
    const row = list.items.find((i) => i.id === T.d1!.id)!;
    expect(row.evidence).toMatchObject({ messageId: M.anna!.id, author: { name: "Άννα Ραφαηλίδου" } });
    expect(row.lastMessage).toMatchObject({ subject: "RE: Αντίγραφο τιμολογίου" });
    expect(JSON.stringify(list)).not.toContain("Μυστικ");

    const res = await api(h, me, "GET", `/api/tasks/${T.d1!.id}`);
    expect(res.statusCode).toBe(200);
    const d = res.json() as TaskDetail;
    expect(d.evidence).toEqual(row.evidence);
    expect(d.lastMessage).toEqual(row.lastMessage);
    const ev = (id: string) => d.events.find((e) => e.id === id)!;
    expect(ev(E.d1Create!)).toMatchObject({ messageId: M.anna!.id, messageAt: "2026-09-08T08:00:00.000Z", author: { name: "Άννα Ραφαηλίδου", isOwner: false } });
    // The stored quote is untouched on the event itself.
    expect(ev(E.d1Create!).evidenceQuote).toBe(LONG_QUOTE);
    expect(ev(E.s1!).author).toEqual(person({ name: "Γιώργος Νικολάου", address: "g.nikolaou@delta-events-gr.example" }));
    // User events carry no message or author.
    expect(ev(E.d1Snooze!)).toMatchObject({ actor: "user", messageId: null, author: null, messageAt: null });
    expect(d.suggestions.map((e) => [e.id, e.author?.address])).toEqual([
      [E.s6, "owner@contoso.example"],
      [E.s1, "g.nikolaou@delta-events-gr.example"],
    ]);
    expect(d.suggestions[0]!.author!.isOwner).toBe(false);
  });
});

describe("state evidence, forwarded authors, last message, bounces and colleagues", () => {
  const all = (r: TodayResponse) => [...r.doNow, ...r.promised, ...r.waiting, ...r.triage.map((t) => t.task)];
  const itemOf = (r: TodayResponse, k: string) => all(r).find((i) => i.id === T[k]!.id)!;

  it("quotes the sentence that set a waiting status, with the request behind it as originEvidence", async () => {
    const r = await today(userD);
    const pw = itemOf(r, "pw");
    expect(pw.evidence).toEqual({
      quote: "θα σας στείλω την προσφορά την Πέμπτη.",
      source: "NEW",
      messageId: M.dPromise!.id,
      author: person({ name: "Demo", address: "d@contoso.example", isOwner: true, isInternal: true }),
      at: "2026-09-08T08:00:00.000Z",
    });
    expect(pw.originEvidence).toMatchObject({ quote: "μπορείτε να μου στείλετε προσφορά για 40 ηχεία οροφής;", messageId: M.dReq!.id, author: { name: "Μαρία Παπαδάκη", isOwner: false } });
    // An accepted suggestion that proposed the status counts; a rejected one never does.
    const wa = itemOf(r, "wa");
    expect(wa.evidence).toMatchObject({ quote: "σας ρώτησα για τον χρόνο παράδοσης", messageId: M.dPromise!.id, author: { isOwner: true } });
    expect(wa.originEvidence!.quote).toBe("πείτε μας τη διαθεσιμότητα");
    // The CREATE set the current status: one sentence, no separate origin.
    const wc = itemOf(r, "wc");
    expect(wc.evidence!.quote).toBe("μπορείτε να μου πείτε αν έχετε 20 SM58;");
    expect(wc.originEvidence).toBeNull();

    // Same on the task list and the task page.
    const list = (await api(h, userD, "GET", "/api/tasks?tab=all")).json() as TaskListResponse;
    const row = list.items.find((i) => i.id === T.pw!.id)!;
    expect(row.evidence).toEqual(pw.evidence);
    expect(row.originEvidence).toEqual(pw.originEvidence);
    const detail = (await api(h, userD, "GET", `/api/tasks/${T.pw!.id}`)).json() as TaskDetail;
    expect(detail.evidence).toEqual(pw.evidence);
    expect(detail.originEvidence).toEqual(pw.originEvidence);
  });

  it("attributes a forwarded sentence to the author of the forwarded mail, and says nothing when that is unknown", async () => {
    const r = await today(userD);
    expect(itemOf(r, "fw").evidence).toEqual({
      quote: "μπορείτε να μας στείλετε τα πιστοποιητικά CE;",
      source: "FORWARDED",
      messageId: M.dFwd!.id,
      author: person({ name: "Άννα Κωστοπούλου", address: "anna@hotelmare.example" }),
      at: "2026-09-06T07:30:00.000Z",
    });
    // A quoted segment without an author, and a forwarded quote without a segment id: never the forwarder (the From of dFwd).
    expect(itemOf(r, "fq").evidence).toEqual({ quote: "όπως είπαμε", source: "QUOTED", messageId: M.dFwd!.id, author: null, at: null });
    expect(itemOf(r, "fo").evidence).toMatchObject({ source: "FORWARDED", messageId: M.dFwd!.id, author: null, at: null });
    // Suggestions follow the same rule.
    const sugg = r.triage.find((t) => t.suggestion?.id === E.fwSugg)!;
    expect(sugg.suggestion).toMatchObject({ messageId: M.dFwd!.id, messageAt: "2026-09-06T07:30:00.000Z", author: person({ name: "Άννα Κωστοπούλου", address: "anna@hotelmare.example" }) });
    const detail = (await api(h, userD, "GET", `/api/tasks/${T.fw!.id}`)).json() as TaskDetail;
    expect(detail.events.find((e) => e.id === E.fwCreate)!.author).toMatchObject({ name: "Άννα Κωστοπούλου", isInternal: false });
    expect(JSON.stringify(r)).not.toContain("Ηλία, μπορείς");
  });

  it("shows the latest human message of the conversation as the last message, linked or not", async () => {
    const r = await today(userD);
    expect(itemOf(r, "pw").lastMessage).toEqual({
      author: person({ name: "Μαρία Παπαδάκη", address: "maria.p@abc-audio.example" }),
      at: "2026-09-10T08:00:00.000Z",
      subject: "RE: RE: Προσφορά ηχείων",
      direction: "INBOUND",
    });
    // No links at all → nothing.
    expect(itemOf(r, "wc").lastMessage).toBeNull();
  });

  it("asks about recently closed tasks whose mail bounced, before other review tasks, and returns raw review codes", async () => {
    const r = await today(userD);
    expect(r.triage.map((t) => [t.kind, t.task.id])).toEqual([
      ["suggestion", T.fw!.id],
      ["review", T.bounced!.id],
      ["review", T.rOpen!.id],
    ]);
    expect(r.counts.triage).toBe(3);
    expect(r.triage[1]!.task).toMatchObject({ status: "COMPLETED", needsReview: true, reviewCodes: ["bounce"] });
    expect(r.triage[2]!.task.reviewCodes).toEqual(["low_confidence"]);

    const review = (await api(h, userD, "GET", "/api/tasks?tab=review")).json() as TaskListResponse;
    expect(new Set(ids(review.items))).toEqual(new Set(names("fw", "bounced", "rOpen")));
    expect(review.counts.review).toBe(3);
    const detail = (await api(h, userD, "GET", `/api/tasks/${T.bounced!.id}`)).json() as TaskDetail;
    expect(detail.reviewCodes).toEqual(["bounce"]);
    expect(detail.reviewReasons).toEqual(["⚠️ Email not delivered"]);
  });

  it("labels colleagues' tasks and leaves dormant hand-overs out of “Colleagues”", async () => {
    const r = await today(userD);
    expect(r.counts.others).toBe(2);
    const others = (await api(h, userD, "GET", "/api/tasks?tab=others")).json() as TaskListResponse;
    expect(new Set(ids(others.items))).toEqual(new Set(names("col", "colAddr")));
    expect(others.counts.others).toBe(r.counts.others);
    const label = (k: string) => others.items.find((i) => i.id === T[k]!.id)!.ownerLabel;
    expect(label("col")).toBe("Νίκος Παππάς");
    expect(label("colAddr")).toBe("eleni@contoso.example");
    // Still listed under "all"; my own tasks carry no owner label.
    const everything = (await api(h, userD, "GET", "/api/tasks?tab=all&limit=100")).json() as TaskListResponse;
    expect(ids(everything.items)).toContain(T.colDormant!.id);
    expect(everything.items.find((i) => i.id === T.pw!.id)!.ownerLabel).toBeNull();
  });
});

describe("GET /api/today — access", () => {
  it("is scoped to the session user", async () => {
    const b = await today(userB);
    expect(ids(b.doNow)).toEqual([bTask.id]);
    expect(b.triage.map((t) => t.task.id)).toEqual([bTask.id]);
    expect(b.counts).toEqual({ triage: 1, doNow: 1, promised: 0, waiting: 0, snoozed: 0, others: 0, earlier: 0 });
    expect(b.triage[0]!.suggestion!.author).toEqual(person({ name: "Μυστικός", address: "boss@other-gr.example", isInternal: true }));
    const aIds = new Set(Object.values(T).filter((t) => t.userId === h.seed.user.id).map((t) => t.id));
    expect([...b.doNow, ...b.promised, ...b.waiting, ...b.triage.map((t) => t.task)].some((i) => aIds.has(i.id))).toBe(false);
    expect(JSON.stringify(b)).not.toContain("Άννα");

    const a = await today(me);
    expect(JSON.stringify(a)).not.toContain(bTask.id);
  });

  it("gives the admin role no task content", async () => {
    const r = await today(admin);
    expect(r).toEqual({ date: "2026-09-15", triage: [], doNow: [], promised: [], waiting: [], counts: { triage: 0, doNow: 0, promised: 0, waiting: 0, snoozed: 0, others: 0, earlier: 0 } });
  });

  it("requires a full (MFA) session", async () => {
    expect((await api(h, null, "GET", "/api/today")).statusCode).toBe(401);
    const pre = await sessionFor(h, h.seed.user.id, false);
    const res = await api(h, pre, "GET", "/api/today");
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("mfa_required");
  });
});

describe("clipQuote / personOf", () => {
  it("keeps short quotes, strips control and bidi characters, cuts long words hard", () => {
    expect(clipQuote("  μέχρι\n την   Τρίτη; ")).toBe("μέχρι την Τρίτη;");
    expect(clipQuote("abc‮def\u0007")).toBe("abcdef");
    expect(clipQuote(null)).toBe("");
    const word = "α".repeat(300);
    expect(clipQuote(word)).toBe("α".repeat(220) + "…");
    expect(clipQuote("λέξη, ".repeat(60), 40)).toBe("λέξη, λέξη, λέξη, λέξη, λέξη, λέξη…");
  });

  it("marks the owner only for sent mail or an unforged owner address (aliases included)", () => {
    const base = { fromName: "X", claimsOwnerSender: false, mailboxAddress: "owner@contoso.example", mailboxAliases: ["sales@contoso.example"], internalDomains: ["contoso.example"] };
    expect(personOf({ ...base, direction: "OUTBOUND", fromAddress: "owner@contoso.example" })).toMatchObject({ isOwner: true, isInternal: true });
    // Ingested without a direction decision (e.g. the Outlook agent): an alias is still you.
    expect(personOf({ ...base, direction: "INBOUND", fromAddress: "<Sales@Contoso.example>" })).toMatchObject({ address: "sales@contoso.example", isOwner: true });
    expect(personOf({ ...base, direction: "INBOUND", fromAddress: "sales@contoso.example", claimsOwnerSender: true })).toMatchObject({ isOwner: false, isInternal: false });
    // Internal subdomains are colleagues.
    expect(personOf({ ...base, direction: "INBOUND", fromAddress: "eshop@mail.contoso.example" })).toMatchObject({ isOwner: false, isInternal: true });
    expect(personOf({ ...base, direction: "INBOUND", fromAddress: "x@contoso.example.evil.com" })).toMatchObject({ isOwner: false, isInternal: false });
    expect(personOf({ ...base, direction: "INBOUND", fromAddress: null, fromName: "  " })).toEqual({ name: null, address: null, isOwner: false, isInternal: false });
  });
});

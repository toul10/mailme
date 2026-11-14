// Regression for review findings bounce-before-apply-lost, bounce-only-at-ingest and bounce-matched-only-at-ingest
// (one bug: a DSN was matched to the original's tasks only at ingest, and recordBounce's array binding threw 22P02).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import * as s from "../../../src/db/schema.js";
import type { FolderRole } from "../../../src/domain/types.js";
import { applyExtraction, applyExtractionWith } from "../../../src/engine/apply.js";
import { nullLogger } from "../../../src/lib/log.js";
import { ingestMessage, type IngestDeps } from "../../../src/mail/ingest.js";
import { createTestDb, insertFolder, insertTask, seedOrgUserMailbox, type TestDb } from "../../helpers/db.js";
import { createOp, fakePlanner, handleMapFor, insertExtraction, output, simpleOp } from "../../engine-db/fixtures.js";
import { fixture } from "../../mail-core/helpers.js";

let t: TestDb;
let ctx: Awaited<ReturnType<typeof seedOrgUserMailbox>>;
let inbox: { id: string };
let sent: { id: string };
let deps: IngestDeps;
const clock = { now: () => new Date("2026-09-08T13:00:00Z") };

beforeEach(async () => {
  t = await createTestDb();
  ctx = await seedOrgUserMailbox(t.db);
  inbox = await insertFolder(t.db, ctx.mailbox.id, "INBOX", "inbox");
  sent = await insertFolder(t.db, ctx.mailbox.id, "Sent", "sent");
  deps = { db: t.db, clock, log: nullLogger, platformMailDomain: "mailme.local", lateDiscoveryMaxDays: 7 };
});
afterEach(() => t.close());

const ingestAt = (name: string, folder: { id: string }, role: FolderRole, uid: number, internalDate: string, seenAt: string) =>
  ingestMessage(deps, {
    mailboxId: ctx.mailbox.id,
    source: { kind: "mime", raw: fixture(name) },
    location: { folderId: folder.id, folderRole: role, uid, internalDate: new Date(internalDate), flags: [] },
    seenAt: new Date(seenAt),
    via: "imap",
  });

/** Sent copy of the offer (owner-offer-1) → CREATE WAITING_FOR_OTHER applied through the fake planner. */
async function ingestAndApplyOffer(seenAt: string) {
  const o = await ingestAt("outbound-offer.eml", sent, "sent", 1, "2026-09-08T12:45:03Z", seenAt);
  expect(o).toMatchObject({ state: "pending", direction: "OUTBOUND" });
  const out = output([createOp({ status: "WAITING_FOR_OTHER", evidence: { source: "NEW", segment_id: "S1", quote: "Σας επισυνάπτω την προσφορά" } })]);
  const ext = await insertExtraction(t.db, { id: o.messageId, mailboxId: ctx.mailbox.id }, out, handleMapFor({ client: "g.georgiou@alfa-ilektroniki.example" }));
  const r = await applyExtractionWith(t.db, o.messageId, ext.id, clock, { planOperations: fakePlanner().planner });
  expect(r.created).toHaveLength(1);
  return r.created[0]!;
}

const bounceEvents = () => t.db.select().from(s.taskEvents).where(eq(s.taskEvents.op, "SYSTEM_BOUNCE"));
const taskRow = async (id: string) => (await t.db.select().from(s.tasks).where(eq(s.tasks.id, id)))[0]!;

describe("bounce-before-apply-lost", () => {
  it("DSN ingested AFTER the original was applied flags the task (the ingest transaction no longer throws 22P02)", async () => {
    const taskId = await ingestAndApplyOffer("2026-09-08T12:45:05Z");
    // The DSN ingest transaction must not fail (sync would stall INBOX and poison-skip the DSN after 5 tries).
    const b = await ingestAt("bounce-postfix.eml", inbox, "inbox", 1, "2026-09-08T12:45:10Z", "2026-09-08T12:55:00Z");
    expect(b).toMatchObject({ state: "filtered", filterReason: "BOUNCE" });
    expect(await bounceEvents()).toHaveLength(1);
    const row = await taskRow(taskId);
    expect(row.needsReview).toBe(true);
    expect(row.reviewReasons).toEqual(["bounce"]);
  });

  it("DSN ingested (IDLE) BEFORE the Sent copy is ingested/applied: task must still get “Not delivered”", async () => {
    // Realistic order: the DSN arrives 7 s after sending (fixture dates) and IDLE ingests it at once;
    // the Sent copy is only picked up by the next full cycle and applied after the settle window.
    const b = await ingestAt("bounce-postfix.eml", inbox, "inbox", 1, "2026-09-08T12:45:10Z", "2026-09-08T12:45:11Z");
    expect(b).toMatchObject({ state: "filtered", filterReason: "BOUNCE" });
    const taskId = await ingestAndApplyOffer("2026-09-08T12:50:00Z");
    const events = await bounceEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ taskId, messageId: b.messageId, actor: "system", applied: true });
    expect((await taskRow(taskId)).needsReview).toBe(true);
    expect((await taskRow(taskId)).reviewReasons).toContain("bounce");
  });

  it("Sent copy pending when the DSN arrives: task must still get “Not delivered” after apply", async () => {
    const o = await ingestAt("outbound-offer.eml", sent, "sent", 1, "2026-09-08T12:45:03Z", "2026-09-08T12:45:05Z");
    expect(o.state).toBe("pending");
    const b = await ingestAt("bounce-postfix.eml", inbox, "inbox", 1, "2026-09-08T12:45:10Z", "2026-09-08T12:45:11Z");
    expect(b).toMatchObject({ state: "filtered", filterReason: "BOUNCE" });
    const out = output([createOp({ status: "WAITING_FOR_OTHER", evidence: { source: "NEW", segment_id: "S1", quote: "Σας επισυνάπτω την προσφορά" } })]);
    const ext = await insertExtraction(t.db, { id: o.messageId, mailboxId: ctx.mailbox.id }, out, handleMapFor({ client: "g.georgiou@alfa-ilektroniki.example" }));
    const r = await applyExtractionWith(t.db, o.messageId, ext.id, clock, { planOperations: fakePlanner().planner });
    expect(r.created).toHaveLength(1);
    expect(await bounceEvents()).toHaveLength(1);
    expect((await taskRow(r.created[0]!)).needsReview).toBe(true);
  });

  it("an AI-completed task (real reconciler) whose completing mail bounced goes to review, once", async () => {
    // From bounce-only-at-ingest: the DSN is stored first; the Sent copy then COMPLETEs an open task.
    const b = await ingestAt("bounce-postfix.eml", inbox, "inbox", 1, "2026-09-08T12:45:10Z", "2026-09-08T12:45:11Z");
    expect(b).toMatchObject({ state: "filtered", filterReason: "BOUNCE" });
    const o = await ingestAt("outbound-offer.eml", sent, "sent", 1, "2026-09-08T12:45:03Z", "2026-09-08T12:50:00Z");
    const task = await insertTask(t.db, { orgId: ctx.org.id, userId: ctx.user.id, mailboxId: ctx.mailbox.id, threadId: o.threadId, counterparty: "g.georgiou@alfa-ilektroniki.example" });
    const out = output([simpleOp("COMPLETE", "K1", "Σας επισυνάπτω την προσφορά για τα 20 ηχεία οροφής.")]);
    const ext = await insertExtraction(t.db, { id: o.messageId, mailboxId: ctx.mailbox.id }, out, handleMapFor({ tasks: { K1: task.id }, client: "g.georgiou@alfa-ilektroniki.example" }));
    const r = await applyExtraction(t.db, o.messageId, ext.id, clock);
    expect(r.completed).toEqual([task.id]);

    const row = await taskRow(task.id);
    expect(row.status).toBe("COMPLETED");
    expect(row.needsReview).toBe(true);
    expect(row.reviewReasons).toContain("bounce");
    const events = await t.db.select().from(s.taskEvents).where(and(eq(s.taskEvents.taskId, task.id), eq(s.taskEvents.op, "SYSTEM_BOUNCE")));
    expect(events).toHaveLength(1);

    // Idempotent per (task, bounce message): the same DSN seen again (another folder copy) adds nothing.
    const again = await ingestAt("bounce-postfix.eml", inbox, "inbox", 2, "2026-09-08T12:45:10Z", "2026-09-08T12:56:00Z");
    expect(again.created).toBe(false);
    expect(await bounceEvents()).toHaveLength(1);
    expect((await taskRow(task.id)).reviewReasons.filter((x) => x === "bounce")).toHaveLength(1);
  });

  it("an applied message with no stored bounce is untouched", async () => {
    const taskId = await ingestAndApplyOffer("2026-09-08T12:45:05Z");
    expect(await bounceEvents()).toHaveLength(0);
    expect((await taskRow(taskId)).needsReview).toBe(false);
  });
});

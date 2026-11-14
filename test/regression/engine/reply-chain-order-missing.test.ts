// Regression for review finding reply-chain-order-missing («inside a thread, reply-chain order wins»).
// The fix is in the drain: a queued reply whose In-Reply-To parent is still queued waits for it, whatever the
// sort_ts. (The repro asserted an ingest-time sort_ts adjustment; the behaviour that matters is the processing
// order and that the reply is analysed with the offer's task in context, which is what is asserted here. The skewed
// pairs are seeded directly, so the test does not depend on how ingest derives sort_ts.)
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "../../../src/db/schema.js";
import type { ExtractionInput } from "../../../src/domain/types.js";
import { drainMailbox } from "../../../src/engine/pipeline.js";
import { nullLogger } from "../../../src/lib/log.js";
import { ingestMessage, type IngestDeps } from "../../../src/mail/ingest.js";
import { createTestDb, insertFolder, insertMessage, insertThread, seedOrgUserMailbox, type TestDb } from "../../helpers/db.js";
import { createOp, fakeExtractor, okResult, output, pipelineDeps, testClock } from "../../engine-db/fixtures.js";
import { parsedMail } from "../../mail-core/helpers.js";

let t: TestDb;
let ctx: Awaited<ReturnType<typeof seedOrgUserMailbox>>;
beforeEach(async () => {
  t = await createTestDb();
  ctx = await seedOrgUserMailbox(t.db);
});
afterEach(() => t.close());

const OFFER_TITLE = "Προσφορά ηχείων";
const OFFER_TEXT = "Σας επισυνάπτω την προσφορά.";
const msgRow = async (id: string) => (await t.db.select().from(s.messages).where(eq(s.messages.id, id)))[0]!;

/** OUTBOUND → the offer's WAITING_FOR_OTHER task; INBOUND → FYI. Records the order and the inputs. */
function recordingExtractor() {
  const order: string[] = [];
  const inputs: ExtractionInput[] = [];
  const ex = fakeExtractor((input) => {
    order.push(input.message.direction);
    inputs.push(input);
    if (input.message.direction === "OUTBOUND") {
      return okResult(output([createOp({ title: OFFER_TITLE, status: "WAITING_FOR_OTHER", evidence: { source: "NEW", segment_id: "S1", quote: OFFER_TEXT } })]));
    }
    return okResult(output([], "FYI"));
  });
  return { ex, order, inputs };
}

async function drainAt(iso: string, ex: ReturnType<typeof recordingExtractor>["ex"]) {
  const clock = testClock(iso);
  return drainMailbox(pipelineDeps(t, ex, clock), ctx.mailbox.id, { fullCycleAt: clock.now() });
}

/** The owner's offer and the customer's reply to it (In-Reply-To = offer) in one thread, with the given sort_ts/first-seen times. */
async function seedPair(o: { sortTs: string; firstSeenAt: string }, r: { sortTs: string; firstSeenAt: string }) {
  const thread = await insertThread(t.db, ctx.mailbox.id, "προσφορα ηχειων");
  const offer = await insertMessage(t.db, {
    mailboxId: ctx.mailbox.id,
    threadId: thread.id,
    messageIdHeader: "offer-1@contoso.example",
    direction: "OUTBOUND",
    from: "owner@contoso.example",
    to: ["client@abc-gr.example"],
    subject: "Προσφορά ηχείων",
    text: OFFER_TEXT,
    sortTs: new Date(o.sortTs),
  });
  const reply = await insertMessage(t.db, {
    mailboxId: ctx.mailbox.id,
    threadId: thread.id,
    messageIdHeader: "reply-1@abc-gr.example",
    inReplyTo: "offer-1@contoso.example",
    references: ["offer-1@contoso.example"],
    subject: "ΑΠ: Προσφορά ηχείων",
    text: "Το λάβαμε, ευχαριστούμε.",
    sortTs: new Date(r.sortTs),
  });
  await t.db.update(s.messages).set({ firstSeenAt: new Date(o.firstSeenAt) }).where(eq(s.messages.id, offer.id));
  await t.db.update(s.messages).set({ firstSeenAt: new Date(r.firstSeenAt) }).where(eq(s.messages.id, reply.id));
  return { offer, reply };
}

describe("reply-chain-order-missing", () => {
  it("control (through ingest, normal clocks): the offer is processed before the reply to it", async () => {
    const inbox = await insertFolder(t.db, ctx.mailbox.id, "INBOX", "inbox");
    const sent = await insertFolder(t.db, ctx.mailbox.id, "Sent", "sent");
    const deps: IngestDeps = { db: t.db, clock: { now: () => new Date("2026-09-24T12:00:00Z") }, log: nullLogger, platformMailDomain: "mailme.local", lateDiscoveryMaxDays: 7 };
    const owner = { address: "owner@contoso.example", name: "Owner" };
    const client = { address: "client@alfa-ilektroniki.example", name: "Client" };
    const o = await ingestMessage(deps, {
      mailboxId: ctx.mailbox.id,
      source: { kind: "parsed", parsed: parsedMail({ messageIdHeader: "offer-1@contoso.example", from: owner, to: [client], subject: "Προσφορά ηχείων", dateHeader: new Date("2026-09-24T10:00:00Z"), hasDeliveryTrace: false, textPlain: OFFER_TEXT }) },
      location: { folderId: sent.id, folderRole: "sent", uid: 1, internalDate: new Date("2026-09-24T10:00:02Z"), flags: ["\\Seen"] },
      seenAt: new Date("2026-09-24T10:03:00Z"),
      via: "imap",
    });
    const r = await ingestMessage(deps, {
      mailboxId: ctx.mailbox.id,
      source: {
        kind: "parsed",
        parsed: parsedMail({ messageIdHeader: "reply-1@alfa.example", from: client, subject: "ΑΠ: Προσφορά ηχείων", dateHeader: new Date("2026-09-24T10:05:00Z"), inReplyTo: "offer-1@contoso.example", references: ["offer-1@contoso.example"], textPlain: "Το λάβαμε, ευχαριστούμε." }),
      },
      location: { folderId: inbox.id, folderRole: "inbox", uid: 1, internalDate: new Date("2026-09-24T10:05:00Z"), flags: [] },
      seenAt: new Date("2026-09-24T10:05:00Z"),
      via: "imap",
    });
    const rec = recordingExtractor();
    await drainAt("2026-09-24T10:30:00Z", rec.ex);
    expect(rec.order).toEqual(["OUTBOUND", "INBOUND"]);
    expect((await msgRow(o.messageId)).state).toBe("applied");
    expect((await msgRow(r.messageId)).state).toBe("applied");
  });

  it("offer with a 20-min-fast PC clock (sort_ts after its reply's): the reply is processed after the offer, with its task in context", async () => {
    const { offer, reply } = await seedPair({ sortTs: "2026-09-24T10:20:00Z", firstSeenAt: "2026-09-24T10:25:00Z" }, { sortTs: "2026-09-24T10:05:00Z", firstSeenAt: "2026-09-24T10:05:00Z" });
    const rec = recordingExtractor();
    const report = await drainAt("2026-09-24T10:30:00Z", rec.ex);
    expect(report).toMatchObject({ processed: 2, applied: 2 });
    expect(rec.order).toEqual(["OUTBOUND", "INBOUND"]);
    expect((await msgRow(offer.id)).state).toBe("applied");
    expect((await msgRow(reply.id)).state).toBe("applied");
    const replyInput = rec.inputs[1]!;
    expect(replyInput.taskCards.map((c) => [c.title, c.scope])).toContainEqual([OFFER_TITLE, "THREAD_OPEN"]);
    // The parent is part of the reply's thread digest even though its sort_ts is later.
    expect(replyInput.threadDigest.map((d) => d.newText).join("\n")).toContain(OFFER_TEXT);
  });

  it("a Sent copy that sorts weeks after its (still queued) reply: the offer goes first", async () => {
    await seedPair({ sortTs: "2026-09-23T11:00:00Z", firstSeenAt: "2026-09-24T11:05:00Z" }, { sortTs: "2026-09-02T10:05:00Z", firstSeenAt: "2026-09-24T11:05:00Z" });
    const rec = recordingExtractor();
    await drainAt("2026-09-24T11:30:00Z", rec.ex);
    expect(rec.order).toEqual(["OUTBOUND", "INBOUND"]);
  });

  it("a reply waits while its parent is still settling (head-of-line applies to the parent)", async () => {
    await seedPair({ sortTs: "2026-09-24T10:20:00Z", firstSeenAt: "2026-09-24T10:25:00Z" }, { sortTs: "2026-09-24T10:05:00Z", firstSeenAt: "2026-09-24T10:05:00Z" });
    const rec = recordingExtractor();
    // 10:26: the reply is settled, the offer (first seen 10:25) is not → nothing is processed yet.
    const report = await drainAt("2026-09-24T10:26:00Z", rec.ex);
    expect(report.processed).toBe(0);
    expect(rec.order).toEqual([]);
  });

  it("a parent that is no longer queued (parked) does not hold the reply back; a reply cycle is bounded", async () => {
    const thread = await insertThread(t.db, ctx.mailbox.id);
    await insertMessage(t.db, { mailboxId: ctx.mailbox.id, threadId: thread.id, messageIdHeader: "p@x.test", state: "failed", sortTs: new Date("2026-09-24T09:00:00Z") });
    const child = await insertMessage(t.db, { mailboxId: ctx.mailbox.id, threadId: thread.id, messageIdHeader: "c@x.test", inReplyTo: "p@x.test", sortTs: new Date("2026-09-24T09:10:00Z") });
    // Two queued messages that claim to reply to each other (broken headers) must not loop.
    const a = await insertMessage(t.db, { mailboxId: ctx.mailbox.id, threadId: thread.id, messageIdHeader: "a@x.test", inReplyTo: "b@x.test", sortTs: new Date("2026-09-24T09:20:00Z") });
    const b = await insertMessage(t.db, { mailboxId: ctx.mailbox.id, threadId: thread.id, messageIdHeader: "b@x.test", inReplyTo: "a@x.test", sortTs: new Date("2026-09-24T09:30:00Z") });
    const rec = recordingExtractor();
    const report = await drainAt("2026-09-24T10:30:00Z", rec.ex);
    expect(report.processed).toBe(3);
    for (const m of [child, a, b]) expect((await msgRow(m.id)).state).toBe("applied");
  });
});

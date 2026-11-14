import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "../../src/db/schema.js";
import { buildExtractionContext, parseAuthor, queryTokens } from "../../src/engine/context.js";
import { insertMessage, insertTask, insertThread, seedOrgUserMailbox, type TestDb } from "../helpers/db.js";
import { sharedTestDb } from "./fixtures.js";

const shared = sharedTestDb();
let t: TestDb;
let seed: Awaited<ReturnType<typeof seedOrgUserMailbox>>;
let thread: Awaited<ReturnType<typeof insertThread>>;

beforeEach(async () => {
  t = shared();
  seed = await seedOrgUserMailbox(t.db, { aliases: ["sales@contoso.example"] });
  thread = await insertThread(t.db, seed.mailbox.id);
});

const ids = () => ({ orgId: seed.org.id, userId: seed.user.id, mailboxId: seed.mailbox.id });
const at = (iso: string) => new Date(iso);

describe("buildExtractionContext — participants", () => {
  it("P1 is the owner (aliases map to it); from/to/cc in order; internal flag; company from the map", async () => {
    await t.db.insert(s.companyDomains).values({ orgId: seed.org.id, domain: "abc-gr.example", company: "ABC Α.Ε." });
    const m = await insertMessage(t.db, {
      mailboxId: seed.mailbox.id,
      threadId: thread.id,
      from: "Client@abc-gr.example",
      fromName: "Γιάννης",
      to: ["sales@contoso.example", "colleague@contoso.example"],
      cc: ["boss@mail.abc-gr.example", "client@abc-gr.example"],
    });
    const { input, handleMap } = await buildExtractionContext(t.db, m.id);
    expect(input.owner).toEqual({ name: "Owner Person", address: "owner@contoso.example", aliases: ["sales@contoso.example"], internalDomains: ["contoso.example"], notes: null });
    expect(input.participants.map((p) => [p.handle, p.address, p.isOwner, p.isInternal, p.company, p.roles])).toEqual([
      ["P1", "owner@contoso.example", true, true, null, ["to"]],
      ["P2", "client@abc-gr.example", false, false, "ABC Α.Ε.", ["from", "cc"]],
      ["P3", "colleague@contoso.example", false, true, null, ["to"]],
      ["P4", "boss@mail.abc-gr.example", false, false, "ABC Α.Ε.", ["cc"]],
    ]);
    expect(input.participants[1]!.name).toBe("Γιάννης");
    expect(input.message).toMatchObject({ fromHandle: "P2", toHandles: ["P1", "P3"], ccHandles: ["P4", "P2"], direction: "INBOUND", subject: "Προσφορά", late: false });
    expect(handleMap.participants.P1).toEqual({ address: "owner@contoso.example", name: "Owner Person", isOwner: true, isInternal: true });
    expect(handleMap.participants.P2?.address).toBe("client@abc-gr.example");
  });

  it("carries the owner's “About your work” note to the AI input", async () => {
    await t.db.update(s.users).set({ profileNote: "Πωλήσεις ήχου. Όχι service." }).where(eq(s.users.id, seed.user.id));
    const m = await insertMessage(t.db, { mailboxId: seed.mailbox.id, threadId: thread.id, from: "client@abc-gr.example", to: ["owner@contoso.example"] });
    const { input } = await buildExtractionContext(t.db, m.id);
    expect(input.owner.notes).toBe("Πωλήσεις ήχου. Όχι service.");
  });

  it("caps participants at 8; extras become OTHER", async () => {
    const to = Array.from({ length: 10 }, (_, i) => `r${i}@x${i}.gr`);
    const m = await insertMessage(t.db, { mailboxId: seed.mailbox.id, to });
    const { input } = await buildExtractionContext(t.db, m.id);
    expect(input.participants).toHaveLength(8);
    expect(input.message.toHandles).toEqual(["P3", "P4", "P5", "P6", "P7", "P8", "OTHER"]);
  });

  it("quoted authors become participants (by address, or by name when known)", async () => {
    const m = await insertMessage(t.db, {
      mailboxId: seed.mailbox.id,
      segments: [
        { id: "S1", kind: "NEW", text: "Δείτε παρακάτω.", author: null, date: null, truncated: false },
        { id: "S2", kind: "QUOTED", text: "Χρειαζόμαστε τιμές.", author: "Μαρία Κ. <maria@xyz.example>", date: "2026-09-08T07:00:00.000Z", truncated: false },
        { id: "S3", kind: "FORWARDED", text: "…", author: "Πελάτης ABC", date: "not a date", truncated: false },
      ],
    });
    const { input } = await buildExtractionContext(t.db, m.id);
    expect(input.participants.find((p) => p.address === "maria@xyz.example")).toMatchObject({ name: "Μαρία Κ.", roles: ["quoted"] });
    expect(input.participants.find((p) => p.address === "client@abc-gr.example")!.roles).toEqual(["from", "quoted"]);
    expect(input.message.segments.map((x) => [x.id, x.anchor])).toEqual([
      ["S1", "Thursday 2026-09-10 11:00 (Europe/Athens)"],
      ["S2", "Tuesday 2026-09-08 10:00 (Europe/Athens)"],
      ["S3", null],
    ]);
    expect(input.message.sentAnchor).toBe("Thursday 2026-09-10 11:00 (Europe/Athens)");
  });

  it("parseAuthor handles 'Name <addr>', bare addresses and names", () => {
    expect(parseAuthor('"Παπαδόπουλος, Γ." <G.Pap@abc-gr.example>')).toEqual({ address: "g.pap@abc-gr.example", name: "Παπαδόπουλος, Γ." });
    expect(parseAuthor("info@abc-gr.example")).toEqual({ address: "info@abc-gr.example", name: null });
    expect(parseAuthor("Μαρία")).toEqual({ address: null, name: "Μαρία" });
  });
});

describe("buildExtractionContext — task cards", () => {
  it("offers thread open, recently closed and related open tasks, with handles in that order", async () => {
    const origin = await insertMessage(t.db, { mailboxId: seed.mailbox.id, threadId: thread.id, sortTs: at("2026-09-08T07:00:00Z"), state: "applied" });
    const open = await insertTask(t.db, { ...ids(), title: "ABC — Προσφορά", threadId: thread.id, messageId: origin.id, dueDate: "2026-09-12" });
    await t.db.insert(s.taskEvents).values({ taskId: open.id, actor: "ai", op: "CREATE", applied: true, evidenceQuote: "Στείλτε μου προσφορά", createdAt: at("2026-09-08T07:05:00Z") });
    await t.db.insert(s.taskEvents).values({ taskId: open.id, actor: "user", op: "USER_SNOOZE", applied: true, createdAt: at("2026-09-09T07:00:00Z") });
    const recent = await insertTask(t.db, { ...ids(), title: "ABC — Δείγματα", status: "COMPLETED", closedBy: "ai", threadId: thread.id });
    await t.db.update(s.tasks).set({ closedAt: at("2026-09-01T00:00:00Z") }).where(eq(s.tasks.id, recent.id));
    const stale = await insertTask(t.db, { ...ids(), title: "ABC — Παλιό", status: "COMPLETED", threadId: thread.id });
    await t.db.update(s.tasks).set({ closedAt: at("2026-08-01T00:00:00Z") }).where(eq(s.tasks.id, stale.id));
    const mergedAway = await insertTask(t.db, { ...ids(), title: "ABC — Συγχωνευμένο", threadId: thread.id });
    await t.db.update(s.tasks).set({ mergedIntoId: open.id }).where(eq(s.tasks.id, mergedAway.id));
    const related = await insertTask(t.db, { ...ids(), title: "ABC — Τιμοκατάλογος 2027" });
    const otherCompany = await insertTask(t.db, { ...ids(), title: "XYZ — Κάτι", counterparty: "x@xyz.example" });
    await t.db.update(s.tasks).set({ companyDomain: "xyz.example" }).where(eq(s.tasks.id, otherCompany.id));

    const m = await insertMessage(t.db, { mailboxId: seed.mailbox.id, threadId: thread.id });
    const { input, handleMap } = await buildExtractionContext(t.db, m.id);
    expect(input.taskCards.map((c) => [c.handle, c.scope, c.title])).toEqual([
      ["K1", "THREAD_OPEN", "ABC — Προσφορά"],
      ["K2", "THREAD_CLOSED", "ABC — Δείγματα"],
      ["K3", "RELATED_OPEN", "ABC — Τιμοκατάλογος 2027"],
    ]);
    expect(handleMap.tasks).toEqual({ K1: open.id, K2: recent.id, K3: related.id });
    expect(input.taskCards[0]).toMatchObject({
      status: "ACTION_REQUIRED",
      ownerHandle: "P1",
      counterpartyHandle: "P2",
      company: "ABC",
      dueDate: "2026-09-12",
      originEvidence: "Στείλτε μου προσφορά",
      originDate: "Tuesday 2026-09-08 10:00 (Europe/Athens)",
      lastEvent: "USER_SNOOZE",
      lastEventDate: "Wednesday 2026-09-09 10:00 (Europe/Athens)",
      closedBy: null,
    });
    expect(input.taskCards[1]!.closedBy).toBe("ai");
  });

  it("related tasks: same counterparty or company domain, never public domains or other users; ranked by text match", async () => {
    const other = (await t.db.insert(s.users).values({ orgId: seed.org.id, name: "Άλλος", email: "o@contoso.example" }).returning())[0]!;
    await insertTask(t.db, { orgId: seed.org.id, userId: other.id, mailboxId: seed.mailbox.id, title: "ABC — Όχι δικό μου" });
    const byDomain = await insertTask(t.db, { ...ids(), title: "ABC — Εγκατάσταση ηχείων", counterparty: "tech@abc-gr.example" });
    const byAddress = await insertTask(t.db, { ...ids(), title: "ABC — Τιμολόγιο Σεπτεμβρίου", counterparty: "client@abc-gr.example" });
    const gmailTask = await insertTask(t.db, { ...ids(), title: "Ιδιώτης — Τιμολόγιο", counterparty: "friend@gmail.com" });
    await t.db.update(s.tasks).set({ companyDomain: "gmail.com" }).where(eq(s.tasks.id, gmailTask.id));

    const m = await insertMessage(t.db, { mailboxId: seed.mailbox.id, cc: ["another@gmail.com"], subject: "Εγκατάσταση ηχείων", text: "Πότε μπορείτε να έρθετε για την εγκατάσταση;" });
    const { input, handleMap } = await buildExtractionContext(t.db, m.id);
    expect(input.taskCards.map((c) => c.scope)).toEqual(["RELATED_OPEN", "RELATED_OPEN"]);
    expect([handleMap.tasks.K1, handleMap.tasks.K2]).toEqual([byDomain.id, byAddress.id]);
    // The counterparty of a related task becomes a participant.
    expect(input.participants.map((p) => p.address)).toContain("tech@abc-gr.example");
    expect(input.taskCards[0]!.counterpartyHandle).toBe(input.participants.find((p) => p.address === "tech@abc-gr.example")!.handle);
  });

  it("offers at most 12 cards", async () => {
    for (let i = 0; i < 15; i++) await insertTask(t.db, { ...ids(), title: `ABC — Εργασία ${i}`, threadId: thread.id });
    const m = await insertMessage(t.db, { mailboxId: seed.mailbox.id, threadId: thread.id });
    const { input, handleMap } = await buildExtractionContext(t.db, m.id);
    expect(input.taskCards).toHaveLength(12);
    expect(input.taskCards.at(-1)!.handle).toBe("K12");
    expect(Object.keys(handleMap.tasks)).toHaveLength(12);
  });

  it("follows thread merges: tasks linked to a merged thread are this thread's", async () => {
    const old = await insertThread(t.db, seed.mailbox.id, "παλιο");
    await t.db.update(s.threads).set({ mergedIntoId: thread.id }).where(eq(s.threads.id, old.id));
    await insertTask(t.db, { ...ids(), title: "ABC — Από το παλιό νήμα", threadId: old.id });
    const m = await insertMessage(t.db, { mailboxId: seed.mailbox.id, threadId: thread.id });
    const { input } = await buildExtractionContext(t.db, m.id);
    expect(input.taskCards.map((c) => [c.scope, c.title])).toEqual([["THREAD_OPEN", "ABC — Από το παλιό νήμα"]]);
  });
});

describe("buildExtractionContext — thread digest & flags", () => {
  it("last 3 earlier AI-eligible messages, NEW text only, truncated; never filtered or later ones", async () => {
    const mk = (i: number, over: Partial<Parameters<typeof insertMessage>[1]> = {}) =>
      insertMessage(t.db, {
        mailboxId: seed.mailbox.id,
        threadId: thread.id,
        sortTs: at(`2026-09-0${i}T07:00:00Z`),
        state: "applied",
        subject: `Θέμα ${i}`,
        segments: [
          { id: "S1", kind: "NEW", text: `Νέο κείμενο ${i}`, author: null, date: null, truncated: false },
          { id: "S2", kind: "QUOTED", text: "παλιό quoted", author: null, date: null, truncated: false },
        ],
        ...over,
      });
    await mk(1);
    await mk(2, { direction: "OUTBOUND", from: "owner@contoso.example" });
    await mk(3, { segments: [{ id: "S1", kind: "NEW", text: "α".repeat(900), author: null, date: null, truncated: false }] });
    await mk(4, { state: "filtered" });
    const personal = await mk(5);
    await t.db.update(s.messages).set({ classification: "PERSONAL" }).where(eq(s.messages.id, personal.id));
    await mk(6, { from: "stranger@else.example" });
    await mk(8); // later than the message → not in the digest
    const m = await insertMessage(t.db, { mailboxId: seed.mailbox.id, threadId: thread.id, sortTs: at("2026-09-07T07:00:00Z") });
    await t.db.update(s.threads).set({ linkConfidence: "LOW" }).where(eq(s.threads.id, thread.id));
    await t.db.update(s.messages).set({ late: true }).where(eq(s.messages.id, m.id));

    const { input } = await buildExtractionContext(t.db, m.id);
    expect(input.threadDigest.map((d) => [d.subject, d.direction, d.fromHandle])).toEqual([
      ["Θέμα 2", "OUTBOUND", "P1"],
      ["Θέμα 3", "INBOUND", "P2"],
      ["Θέμα 6", "INBOUND", "OTHER"],
    ]);
    expect(input.threadDigest[0]).toMatchObject({ date: "Wednesday 2026-09-02 10:00 (Europe/Athens)", newText: "Νέο κείμενο 2" });
    expect(input.threadDigest[1]!.newText).toHaveLength(600);
    expect(input.threadDigest[1]!.newText.endsWith("…")).toBe(true);
    expect(input.lowLinkConfidence).toBe(true);
    expect(input.message.late).toBe(true);
  });

  it("works for a message without a thread; inline attachments are dropped; calendar is passed through", async () => {
    const m = await insertMessage(t.db, { mailboxId: seed.mailbox.id, threadId: null, attachments: [{ filename: "Prosfora.pdf" }, { filename: "image001.png", contentType: "image/png" }] });
    await t.db
      .update(s.messages)
      .set({
        attachments: [
          { filename: "Prosfora.pdf", contentType: "application/pdf", size: 10, inline: false },
          { filename: "image001.png", contentType: "image/png", size: 10, inline: true },
        ],
        calendar: { method: "REQUEST", summary: "Συνάντηση", start: "2026-09-12T08:00:00Z", end: null, tzid: "Europe/Athens", organizer: "client@abc-gr.example", location: null },
      })
      .where(eq(s.messages.id, m.id));
    const { input } = await buildExtractionContext(t.db, m.id);
    expect(input.taskCards).toEqual([]);
    expect(input.threadDigest).toEqual([]);
    expect(input.lowLinkConfidence).toBe(false);
    expect(input.message.attachments).toEqual([{ filename: "Prosfora.pdf", contentType: "application/pdf" }]);
    expect(input.message.calendar?.method).toBe("REQUEST");
  });

  it("query tokens: subject first, folded, stopwords/short/numeric dropped, deduped", () => {
    expect(queryTokens("ΑΠ: Προσφορά ηχείων", "Καλημέρα, για την προσφορά των ηχείων 2027 σας παρακαλώ.")).toEqual(["προσφορα", "ηχειων"]);
  });
});

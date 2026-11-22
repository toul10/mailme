import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  cleanTerms,
  FOLD_FROM,
  FOLD_TO,
  foldText,
  loadChatScope,
  loadRecords,
  localDayStart,
  notAnalysed,
  readThread,
  searchMail,
  searchTasks,
  snippetOf,
  taskByRef,
  termPattern,
  THREAD_MAX_MESSAGES,
  type ChatScope,
  type MailQuery,
  type TaskQuery,
} from "../../src/chat/search.js";
import * as s from "../../src/db/schema.js";
import type { Segment } from "../../src/domain/types.js";
import { nullLogger } from "../../src/lib/log.js";
import { ingestMessage, type IngestDeps } from "../../src/mail/ingest.js";
import { sharedTestDb } from "../engine-db/fixtures.js";
import { parsedMail } from "../mail-core/helpers.js";
import { insertFolder, insertMessage as insertWaitingMessage, insertTask, insertThread, seedOrgUserMailbox, type MessageSeed, type TestDb } from "../helpers/db.js";

/** Mail as the chat reads it: analysed already. (The helper's own default is mail that still waits for the AI, which the chat does not show.) */
const insertMessage = (db: TestDb["db"], m: MessageSeed) => insertWaitingMessage(db, { state: "applied", ...m });

const ZONE = "Europe/Athens";
const NOW = new Date("2026-11-20T10:00:00Z");
const at = (iso: string) => new Date(iso);
const seg = (id: string, kind: Segment["kind"], text: string, author: string | null = null): Segment => ({ id, kind, text, author, date: null, truncated: false });

let t: TestDb;
let seed: Awaited<ReturnType<typeof seedOrgUserMailbox>>;
let scope: ChatScope;
const shared = sharedTestDb();
beforeEach(async () => {
  t = shared();
  seed = await seedOrgUserMailbox(t.db, { address: "owner@contoso.example", name: "Δέσποινα Δοκιμή" });
  scope = (await loadChatScope(t.db, seed.user.id, ZONE, NOW))!;
});

const mail = (q: Partial<MailQuery> = {}, sc: ChatScope = scope) => searchMail(t.db, sc, { allOf: [], anyOf: [], person: null, after: null, before: null, sender: "anyone", limit: 8, ...q });
const tasksOf = (q: Partial<TaskQuery> = {}, sc: ChatScope = scope) => searchTasks(t.db, sc, { allOf: [], anyOf: [], status: "any", limit: 12, ...q });
const patch = (id: string, values: Partial<typeof s.messages.$inferInsert>) => t.db.update(s.messages).set(values).where(eq(s.messages.id, id));
const subjects = (r: { hits: Array<{ subject: string }> }) => r.hits.map((h) => h.subject);
let uid = 0;
/** A copy of the message that a sync saw in a folder. */
const place = (messageId: string, folderId: string, seenAt: string, flags: string[] = []) =>
  t.db.insert(s.messageLocations).values({ messageId, folderId, uid: ++uid, flags, firstSeenAt: at(seenAt) });

describe("folding", () => {
  it("maps Greek capitals, accents and the final sigma, one character for one", () => {
    const text = "Η ΠΑΡΑΓΓΕΛΊΑ του Γιώργου — ΑΫΛΟΣ ταχυδρόμος, Προσφοράς";
    expect(foldText(text)).toBe("η παραγγελια του γιωργου — αυλοσ ταχυδρομοσ, προσφορασ");
    expect(foldText(text)).toHaveLength(text.length);
    expect(foldText("Über ΐ ΰ İ")).toHaveLength("Über ΐ ΰ İ".length);
  });

  it("maps the accented Latin letters of names too, still one character for one", () => {
    expect(foldText("MÜLLER & Søn — José Ibáñez, Škoda, Łódź, Çelik")).toBe("muller & son — jose ibanez, skoda, lodz, celik");
    // The two strings are paired by position: a missing or doubled character would shift every letter after it.
    expect([...FOLD_FROM]).toHaveLength([...FOLD_TO].length);
    expect(FOLD_FROM).toHaveLength(FOLD_TO.length);
    expect(new Set(FOLD_FROM).size).toBe(FOLD_FROM.length);
    expect(FOLD_TO).toMatch(/^[a-zα-ω]+$/);
  });

  it("turns a folded word into a pattern of plain text: every spelling of each letter, and no operators", () => {
    expect(termPattern("τιμ-7")).toBe("[τΤ][ιΙΊΪίϊΐ][μΜ]-7");
    expect(termPattern("σ")).toBe("[σΣς]");
    expect(termPattern("n")).toBe("[nNÑŃŇñńň]");
    // Any script with capitals; a letter without a capital of its own stands for itself.
    expect(termPattern("дß1")).toBe("[дД]ß1");
    // What a regular expression would read as an operator is escaped, one by one.
    expect(termPattern(".*+?()[]{}|^$\\")).toBe("\\.\\*\\+\\?\\(\\)\\[\\]\\{\\}\\|\\^\\$\\\\");
    expect(termPattern("% _-@#&,:;<>=!~/'\"")).toBe("% _-@#&,:;<>=!~/'\"");
    // Every word the cleaning lets through gives a pattern JS itself can compile, and that finds its own spellings.
    for (const word of ["Τιμοκατάλογ", "MÜLLER", "a.b", "(x)", "50%", "c:\\temp", "[τιμ]", "ΑΫΛΟΣ"]) {
      const [folded] = cleanTerms([word], 1);
      const re = new RegExp(termPattern(folded!), "u");
      expect(re.test(word), word).toBe(true);
      expect(re.test(word.toUpperCase()), word).toBe(true);
      expect(re.test(`πριν ${folded} μετά`), word).toBe(true);
    }
  });

  it("cleans the model's words: folded, trimmed, without duplicates, too short ones dropped, capped", () => {
    expect(cleanTerms(["  Τιμοκατάλογ ", "ΤΙΜΟΚΑΤΑΛΟΓ", "a", "", "price   list"], 6)).toEqual(["τιμοκαταλογ", "price list"]);
    expect(cleanTerms(["x".repeat(200)], 6)[0]).toHaveLength(60);
    expect(cleanTerms(["one", "two", "three"], 2)).toEqual(["one", "two"]);
    expect(cleanTerms(null, 3)).toEqual([]);
    // Control characters are never part of a word (and the database refuses a NUL).
    expect(cleanTerms(["τιμο\u0000λόγιο", "a\u0000", "\u0007\u001b"], 6)).toEqual(["τιμο λογιο"]);
  });

  it("turns a local day into an instant of the user's zone", () => {
    expect(localDayStart("2026-11-20", ZONE)?.toISOString()).toBe("2026-11-19T22:00:00.000Z");
    expect(localDayStart("2026-07-01", ZONE)?.toISOString()).toBe("2026-06-30T21:00:00.000Z");
    expect(localDayStart("2026-11-20", ZONE, 1)?.toISOString()).toBe("2026-11-20T22:00:00.000Z");
    for (const bad of ["", "yesterday", "2026-13-01", "20/11/2026", null]) expect(localDayStart(bad, ZONE)).toBeNull();
  });
});

describe("search_mail", () => {
  it("finds word stems whatever the case and the accents: in the subject, the people, the attachment names and the text", async () => {
    const a = await insertMessage(t.db, { mailboxId: seed.mailbox.id, subject: "ΤΙΜΟΚΑΤΑΛΟΓΟΣ 2027", from: "g.papadopoulos@abc-gr.example", fromName: "Γιώργος Παπαδόπουλος", text: "Καλημέρα, σας στέλνω τα νέα.", sortTs: at("2026-11-18T08:00:00Z") });
    const b = await insertMessage(t.db, { mailboxId: seed.mailbox.id, subject: "Νέα", from: "sales@xyz-gr.example", fromName: "XYZ", text: "Στο συνημμένο θα βρείτε τον τιμοκατάλογό μας.", sortTs: at("2026-11-17T08:00:00Z") });
    const c = await insertMessage(t.db, { mailboxId: seed.mailbox.id, subject: "Αρχείο", from: "info@def-gr.example", fromName: "DEF", text: "Δείτε το συνημμένο.", attachments: [{ filename: "Pricelist_2027.pdf" }], sortTs: at("2026-11-16T08:00:00Z") });
    await insertMessage(t.db, { mailboxId: seed.mailbox.id, subject: "Άσχετο", from: "other@else-gr.example", fromName: "Άλλος", text: "Τίποτα σχετικό εδώ.", sortTs: at("2026-11-19T08:00:00Z") });

    const byStem = await mail({ allOf: ["Τιμοκατάλογ"] });
    expect(byStem.hits.map((h) => h.id)).toEqual([a.id, b.id]);
    expect(byStem.total).toBe(2);
    expect((await mail({ allOf: ["τιμοκαταλογ"] })).hits.map((h) => h.id)).toEqual([a.id, b.id]);
    expect((await mail({ anyOf: ["τιμοκαταλογ", "pricelist"] })).hits.map((h) => h.id)).toEqual([a.id, b.id, c.id]);
    expect((await mail({ allOf: ["παπαδοπουλ"] })).hits.map((h) => h.id)).toEqual([a.id]);
    expect((await mail({ allOf: ["PAPADOPOUL"] })).hits.map((h) => h.id)).toEqual([a.id]);
    expect((await mail({ allOf: ["δεν υπαρχει τετοια λεξη"] })).hits).toEqual([]);
    // LIKE wildcards in a word are plain characters.
    expect((await mail({ allOf: ["%%"] })).hits).toEqual([]);
    expect((await mail({ allOf: ["__"] })).hits).toEqual([]);
    expect((await mail({ allOf: ["pricelist_2027"] })).hits.map((h) => h.id)).toEqual([c.id]);
    expect((await mail({ allOf: ["pricelist%2027"] })).hits).toEqual([]);
  });

  it("all_of narrows, any_of widens, person is the sender or a recipient, days are local, sender tells own mail from the rest", async () => {
    const order = await insertMessage(t.db, { mailboxId: seed.mailbox.id, subject: "Παραγγελία ηχείων", from: "buyer@abc-gr.example", fromName: "Αγοραστής", to: ["owner@contoso.example", "orders@contoso.example"], text: "Θέλουμε 4 ηχεία.", sortTs: at("2026-11-10T22:30:00Z") });
    const offer = await insertMessage(t.db, { mailboxId: seed.mailbox.id, subject: "Προσφορά ηχείων", from: "buyer@abc-gr.example", fromName: "Αγοραστής", text: "Στείλτε προσφορά για ηχεία.", sortTs: at("2026-11-12T09:00:00Z") });
    const mine = await insertMessage(t.db, { mailboxId: seed.mailbox.id, subject: "Re: Προσφορά ηχείων", from: "owner@contoso.example", fromName: "Contoso", to: ["buyer@abc-gr.example"], text: "Σας στέλνω την προσφορά.", sortTs: at("2026-11-12T10:00:00Z") });
    await patch(mine.id, { claimsOwnerSender: true });
    const sent = await insertMessage(t.db, { mailboxId: seed.mailbox.id, direction: "OUTBOUND", subject: "Παραγγελία προς προμηθευτή", from: "owner@contoso.example", to: ["supplier@far-de.example"], text: "We order 10 speakers.", sortTs: at("2026-11-13T10:00:00Z") });

    expect((await mail({ allOf: ["ηχει"] })).hits.map((h) => h.id)).toEqual([mine.id, offer.id, order.id]);
    expect((await mail({ allOf: ["ηχει", "παραγγελ"] })).hits.map((h) => h.id)).toEqual([order.id]);
    expect((await mail({ allOf: ["ηχει"], anyOf: ["παραγγελ", "θελουμε"] })).hits.map((h) => h.id)).toEqual([order.id]);
    expect((await mail({ anyOf: ["speakers", "θελουμε"] })).hits.map((h) => h.id)).toEqual([sent.id, order.id]);

    expect((await mail({ person: "abc-gr.example" })).hits.map((h) => h.id)).toEqual([mine.id, offer.id, order.id]);
    expect((await mail({ person: "orders@" })).hits.map((h) => h.id)).toEqual([order.id]);
    expect((await mail({ person: "Αγοραστ" })).hits.map((h) => h.id)).toEqual([offer.id, order.id]);

    // 2026-11-10 22:30Z is already the 11th in Athens (UTC+2 in winter).
    expect((await mail({ before: "2026-11-10" })).hits).toEqual([]);
    expect((await mail({ after: "2026-11-11", before: "2026-11-11" })).hits.map((h) => h.id)).toEqual([order.id]);
    expect((await mail({ after: "2026-11-13" })).hits.map((h) => h.id)).toEqual([sent.id]);
    // A day that cannot be read never turns into "all time": such a search finds nothing (the engine refuses it
    // with a reason before it gets here).
    expect(await mail({ after: "last week" })).toEqual({ total: 0, hits: [] });
    expect(await mail({ before: "2026-02-31" })).toEqual({ total: 0, hits: [] });
    expect((await mail({ after: "", before: "  " })).total).toBe(4);

    const own = await mail({ sender: "me" });
    expect(own.hits.map((h) => h.id)).toEqual([sent.id, mine.id]);
    expect(own.hits.every((h) => h.own)).toBe(true);
    const others = await mail({ sender: "others" });
    expect(others.hits.map((h) => h.id)).toEqual([offer.id, order.id]);
    expect(others.hits.some((h) => h.own)).toBe(false);
  });

  it("ranks a word in the message itself before one that only its quoted text holds, and says how many matched", async () => {
    const quoting = await insertMessage(t.db, {
      mailboxId: seed.mailbox.id,
      subject: "Re: Ερώτηση",
      text: "",
      segments: [seg("S1", "NEW", "Εντάξει, ευχαριστώ."), seg("S2", "QUOTED", "Ο κωδικός του τιμολογίου είναι ΤΙΜ-778.", "Λογιστήριο")],
      sortTs: at("2026-11-19T08:00:00Z"),
    });
    const direct = await insertMessage(t.db, { mailboxId: seed.mailbox.id, subject: "Τιμολόγιο ΤΙΜ-778", text: "Επισυνάπτεται το τιμολόγιο.", sortTs: at("2026-11-01T08:00:00Z") });
    const res = await mail({ allOf: ["τιμ-778"] });
    expect(res.hits.map((h) => h.id)).toEqual([direct.id, quoting.id]);
    // The snippet of the quoting message shows where the word is, not its unrelated own line.
    expect(res.hits[1]!.snippet).toContain("ΤΙΜ-778");

    for (let i = 0; i < 12; i++) await insertMessage(t.db, { mailboxId: seed.mailbox.id, subject: `Δελτίο ${i}`, text: "Δελτίο αποστολής.", sortTs: at(`2026-10-${String(i + 1).padStart(2, "0")}T08:00:00Z`) });
    const many = await mail({ allOf: ["δελτιο"], limit: 5 });
    expect(many.total).toBe(12);
    expect(subjects(many)).toEqual(["Δελτίο 11", "Δελτίο 10", "Δελτίο 9", "Δελτίο 8", "Δελτίο 7"]);
    expect((await mail({ allOf: ["δελτιο"], limit: 500 })).hits).toHaveLength(12);
  });

  it("gives each hit its conversation size, its tasks (open first) and a snippet around the word", async () => {
    const thread = await insertThread(t.db, seed.mailbox.id, "ηχεια");
    const long = `${"Εισαγωγή χωρίς ενδιαφέρον. ".repeat(30)}Ο αριθμός παραγγελίας είναι PO-4471 και επείγει. ${"Κλείσιμο. ".repeat(30)}`;
    const m1 = await insertMessage(t.db, { mailboxId: seed.mailbox.id, threadId: thread.id, subject: "Παραγγελία", text: long, sortTs: at("2026-11-10T08:00:00Z") });
    await insertMessage(t.db, { mailboxId: seed.mailbox.id, threadId: thread.id, subject: "Re: Παραγγελία", text: "Ελήφθη.", sortTs: at("2026-11-10T09:00:00Z") });
    const closed = await insertTask(t.db, { orgId: seed.org.id, userId: seed.user.id, mailboxId: seed.mailbox.id, title: "Παλιά", status: "COMPLETED", messageId: m1.id });
    const open = await insertTask(t.db, { orgId: seed.org.id, userId: seed.user.id, mailboxId: seed.mailbox.id, title: "Εκτέλεση παραγγελίας", threadId: thread.id });

    const [hit] = (await mail({ allOf: ["po-4471"] })).hits;
    expect(hit!.threadSize).toBe(2);
    expect(hit!.tasks.map((x) => x.ref)).toEqual([open.ref, closed.ref]);
    expect(hit!.snippet).toContain("PO-4471");
    expect(hit!.snippet.startsWith("…")).toBe(true);
    expect(hit!.snippet.length).toBeLessThan(300);
    expect(hit!.snippet).not.toMatch(/\n/);
  });
});

describe("what stays out", () => {
  it("never returns another user's mail or tasks: not by search, not by id, not as a conversation", async () => {
    const other = await seedOrgUserMailbox(t.db, { address: "boss@contoso.example", name: "Άλλος Χρήστης" });
    const theirs = await insertMessage(t.db, { mailboxId: other.mailbox.id, subject: "Μισθοδοσία ηχείων", text: "Εμπιστευτικό: μισθοδοσία.", sortTs: at("2026-11-18T08:00:00Z") });
    const theirTask = await insertTask(t.db, { orgId: other.org.id, userId: other.user.id, mailboxId: other.mailbox.id, title: "Μισθοδοσία", messageId: theirs.id });
    const ours = await insertMessage(t.db, { mailboxId: seed.mailbox.id, subject: "Ηχεία", text: "Δικό μας.", sortTs: at("2026-11-18T08:00:00Z") });

    expect((await mail({ allOf: ["μισθοδοσ"] })).hits).toEqual([]);
    expect((await mail({ allOf: ["ηχει"] })).hits.map((h) => h.id)).toEqual([ours.id]);
    expect((await mail()).total).toBe(1);
    expect(await loadRecords(t.db, scope, [theirs.id, ours.id])).toHaveLength(1);
    expect(await readThread(t.db, scope, theirs.id)).toBeNull();
    expect((await tasksOf({ allOf: ["μισθοδοσ"] })).hits).toEqual([]);
    expect(await taskByRef(t.db, scope, theirTask.ref)).toBeNull();

    // And the other way round: their scope sees only theirs.
    const theirScope = (await loadChatScope(t.db, other.user.id, ZONE, NOW))!;
    expect((await mail({}, theirScope)).hits.map((h) => h.id)).toEqual([theirs.id]);
    expect((await tasksOf({}, theirScope)).hits.map((x) => x.id)).toEqual([theirTask.id]);
  });

  it("a user without a mailbox finds nothing, and an unknown user has no scope", async () => {
    const [u] = await t.db.insert(s.users).values({ orgId: seed.org.id, name: "Χωρίς mailbox", email: "nobox@contoso.example" }).returning();
    const empty = (await loadChatScope(t.db, u!.id, ZONE, NOW))!;
    expect(empty.mailboxIds).toEqual([]);
    expect(await mail({}, empty)).toEqual({ total: 0, hits: [] });
    expect(await loadRecords(t.db, empty, ["00000000-0000-4000-8000-000000000000"])).toEqual([]);
    expect(await loadChatScope(t.db, "00000000-0000-4000-8000-000000000000", ZONE, NOW)).toBeNull();
  });

  it("leaves out spam, phishing, deleted mail, deny-listed senders, the platform's own mail and what the AI called personal or spam", async () => {
    const keep = await insertMessage(t.db, { mailboxId: seed.mailbox.id, subject: "Κανονικό λογαριασμός", text: "λογαριασμός", sortTs: at("2026-11-19T08:00:00Z") });
    const hidden: Array<Partial<typeof s.messages.$inferInsert>> = [
      { state: "filtered", filterReason: "PHISHING" },
      { state: "filtered", filterReason: "SPAM_FOLDER" },
      { state: "filtered", filterReason: "DENYLIST" },
      { state: "filtered", filterReason: "MUTED" },
      { state: "filtered", filterReason: "DRAFT_OR_DELETED" },
      { state: "own_mail", filterReason: "OWN_MAIL" },
      { state: "discovered" },
      { state: "applied", classification: "PERSONAL" },
      { state: "applied", classification: "SPAM" },
    ];
    const ids: string[] = [];
    for (const [i, h] of hidden.entries()) {
      const m = await insertMessage(t.db, { mailboxId: seed.mailbox.id, subject: `Κρυφό ${i} λογαριασμός`, text: "ο λογαριασμός σας", sortTs: at("2026-11-18T08:00:00Z") });
      await patch(m.id, h);
      ids.push(m.id);
    }
    expect((await mail({ allOf: ["λογαριασμ"] })).hits.map((h) => h.id)).toEqual([keep.id]);
    expect((await mail()).total).toBe(1);
    expect(await loadRecords(t.db, scope, ids)).toEqual([]);
    for (const id of ids) expect(await readThread(t.db, scope, id)).toBeNull();
  });

  it("keeps ordinary mail the pre-filter only set aside: bulk, no-reply, the user's own rule, too old to analyse", async () => {
    const reasons = ["BULK", "NOREPLY", "RULE", "TOO_OLD", "BOUNCE", "OUT_OF_OFFICE"] as const;
    for (const r of reasons) {
      const m = await insertMessage(t.db, { mailboxId: seed.mailbox.id, subject: `Δέμα ${r}`, text: "Το δέμα σας παραδόθηκε.", sortTs: at("2026-11-18T08:00:00Z") });
      await patch(m.id, { state: r === "TOO_OLD" ? "skipped_old" : "filtered", filterReason: r });
    }
    const res = await mail({ allOf: ["δεμα"] });
    expect(res.total).toBe(reasons.length);
    expect(res.hits.map((h) => h.filterReason).sort()).toEqual([...reasons].sort());
  });

  it("leaves out senders on the user's «Αγνόησε» list, also mail from before they were muted", async () => {
    const boss = await insertMessage(t.db, { mailboxId: seed.mailbox.id, subject: "Εκπτώσεις", from: "news@promo.shop-gr.example", text: "εκπτώσεις", sortTs: at("2026-11-18T08:00:00Z") });
    const one = await insertMessage(t.db, { mailboxId: seed.mailbox.id, subject: "Εκπτώσεις 2", from: "john@single-gr.example", text: "εκπτώσεις", sortTs: at("2026-11-17T08:00:00Z") });
    const near = await insertMessage(t.db, { mailboxId: seed.mailbox.id, subject: "Εκπτώσεις 3", from: "john@notshop-gr.example", text: "εκπτώσεις", sortTs: at("2026-11-16T08:00:00Z") });
    const noFrom = await insertMessage(t.db, { mailboxId: seed.mailbox.id, subject: "Εκπτώσεις 4", text: "εκπτώσεις", sortTs: at("2026-11-15T08:00:00Z") });
    await patch(noFrom.id, { fromAddress: null });
    expect((await mail({ allOf: ["εκπτωσ"] })).total).toBe(4);

    await t.db.update(s.users).set({ mutedSenders: ["@shop-gr.example", "john@single-gr.example"] }).where(eq(s.users.id, seed.user.id));
    const muted = (await loadChatScope(t.db, seed.user.id, ZONE, NOW))!;
    expect((await mail({ allOf: ["εκπτωσ"] }, muted)).hits.map((h) => h.id)).toEqual([near.id, noFrom.id]);
    expect(await loadRecords(t.db, muted, [boss.id, one.id, near.id])).toHaveLength(1);
    expect(await readThread(t.db, muted, boss.id)).toBeNull();
  });
});

describe("what stays out, whatever the pre-filter wrote down first", () => {
  const setAside = async (subject: string, reason: string, over: Partial<typeof s.messages.$inferInsert> = {}) => {
    const m = await insertMessage(t.db, { mailboxId: seed.mailbox.id, subject, from: "news@shop.example", text: "Δείτε τις νέες μας τιμές.", sortTs: at("2026-11-18T08:00:00Z") });
    await patch(m.id, { state: reason === "TOO_OLD" ? "skipped_old" : "filtered", filterReason: reason, ...over });
    return m;
  };

  it("leaves out spam and phishing that an earlier rule had already set aside as bulk, no-reply or too old", async () => {
    const junk = await insertFolder(t.db, seed.mailbox.id, "Junk", "junk");
    const news = await setAside("Τιμές newsletter", "BULK", { headers: { "list-unsubscribe": "<mailto:u@shop.example>" } });
    // The mail server flagged it as spam.
    const flagged = await setAside("Τιμές flagged", "BULK", { headers: { "list-unsubscribe": "<mailto:u@shop.example>", "x-spam-flag": "YES" } });
    // It was found in the spam folder.
    const inJunk = await setAside("Τιμές junk", "NOREPLY");
    await place(inJunk.id, junk.id, "2026-11-18T08:01:00Z");
    const oldJunk = await setAside("Τιμές old junk", "TOO_OLD");
    await place(oldJunk.id, junk.id, "2026-11-18T08:01:00Z");
    // A «bank» that writes from somewhere else about the account, with an unsubscribe header in front.
    const phish = await setAside("Τιμές: ο λογαριασμός σας θα απενεργοποιηθεί", "BULK", { fromName: "EUROBANK", fromAddress: "info@cheap-host.example", headers: { "list-unsubscribe": "<mailto:u@cheap-host.example>" } });
    // The user's own address, forged (the server saw no SPF pass), with the bait in the text.
    const forged = await setAside("Τιμές forged", "TOO_OLD", {
      fromAddress: "owner@contoso.example",
      claimsOwnerSender: true,
      headers: { "x-spam-status": "No, score=3.8 required=5.0 tests=BAYES_00,SPF_NEUTRAL,TO_EQ_FM_DIRECT_MX autolearn=no version=3.4.6" },
      segments: [seg("S1", "NEW", "Unusual activity has been detected from your account.")],
    });
    const hidden = [flagged, inJunk, oldJunk, phish, forged].map((m) => m.id);

    expect((await mail({ allOf: ["τιμεσ"] })).hits.map((h) => h.id)).toEqual([news.id]);
    // The count does not give away what is hidden either.
    expect((await mail()).total).toBe(1);
    expect(await loadRecords(t.db, scope, [news.id, ...hidden])).toHaveLength(1);
    for (const id of hidden) expect(await readThread(t.db, scope, id)).toBeNull();

    // With the user's own spam rule switched off the task pipeline reads such mail too: then so does the chat.
    expect((await mail({ allOf: ["τιμεσ"] }, { ...scope, spamFilter: false })).total).toBe(6);
  });

  it("a phishing mail with an unsubscribe header goes through the real ingest as bulk mail, with its text, and is not readable", async () => {
    const inbox = await insertFolder(t.db, seed.mailbox.id, "INBOX", "inbox");
    const deps: IngestDeps = { db: t.db, clock: { now: () => NOW }, log: nullLogger, platformMailDomain: "mailme.local", lateDiscoveryMaxDays: 7 };
    const deliver = (messageIdHeader: string, dateHeader: Date, n: number) =>
      ingestMessage(deps, {
        mailboxId: seed.mailbox.id,
        source: {
          kind: "parsed",
          parsed: parsedMail({
            messageIdHeader,
            dateHeader,
            from: { address: "owner@contoso.example", name: null },
            to: [{ address: "owner@contoso.example", name: null }],
            subject: "Activity Sent From Your Own Account",
            textPlain: "Unusual activity has been detected from your account.",
            headers: {
              "list-unsubscribe": "<mailto:u@x.example>",
              "x-spam-status": "No, score=3.8 required=5.0 tests=BAYES_00,KAM_DMARC_NONE,SPF_NEUTRAL,TO_EQ_FM_DIRECT_MX autolearn=no autolearn_force=no version=3.4.6",
            },
          }),
        },
        location: { folderId: inbox.id, folderRole: "inbox", uid: n, internalDate: null, flags: [] },
        seenAt: NOW,
        via: "imap",
      });

    // The pre-filter stops at the first rule that matches: to it this is a newsletter, or simply old mail.
    const fresh = await deliver("phish-fresh@x.example", at("2026-11-20T09:00:00Z"), 9001);
    expect(fresh).toMatchObject({ state: "filtered", filterReason: "BULK" });
    const old = await deliver("phish-old@x.example", at("2026-09-09T07:00:00Z"), 9002);
    expect(old).toMatchObject({ state: "skipped_old", filterReason: "TOO_OLD" });
    const [stored] = await t.db.select().from(s.messages).where(eq(s.messages.id, fresh.messageId));
    expect(stored!.segments.map((x) => x.text).join(" ")).toContain("Unusual activity");

    expect((await mail({ allOf: ["unusual activity"] })).hits).toEqual([]);
    expect((await mail()).total).toBe(0);
    expect(await loadRecords(t.db, scope, [fresh.messageId, old.messageId])).toEqual([]);
    expect(await readThread(t.db, scope, fresh.messageId)).toBeNull();
  });

  it("reads where a message is from its most recent sighting: private folders, the spam folder, the trash, deleted copies", async () => {
    const inbox = await insertFolder(t.db, seed.mailbox.id, "INBOX", "inbox");
    const archive = await insertFolder(t.db, seed.mailbox.id, "Archive", "archive");
    const junk = await insertFolder(t.db, seed.mailbox.id, "Junk", "junk");
    const trash = await insertFolder(t.db, seed.mailbox.id, "Trash", "trash");
    const drafts = await insertFolder(t.db, seed.mailbox.id, "Drafts", "drafts");
    const family = await insertFolder(t.db, seed.mailbox.id, "Οικογένεια", "other");
    const m = (subject: string, over: Partial<MessageSeed> = {}) => insertMessage(t.db, { mailboxId: seed.mailbox.id, subject: `Φάκελος ${subject}`, text: "κείμενο", sortTs: at("2026-11-18T08:00:00Z"), ...over });
    const T1 = "2026-11-18T08:01:00Z";
    const T2 = "2026-11-19T08:01:00Z";

    const plain = await m("inbox");
    await place(plain.id, inbox.id, T1, ["\\Seen"]);
    const imported = await m("χωρίς θέση");
    // Filed from the inbox while its old copy still waited to be purged: the newer copy is the message.
    const filed = await m("αρχειοθετημένο");
    await place(filed.id, inbox.id, T1, ["\\Seen", "\\Deleted"]);
    await place(filed.id, archive.id, T2);
    // A draft that was then sent under the same Message-ID.
    const sentDraft = await m("σταλμένο", { direction: "OUTBOUND", from: "owner@contoso.example" });
    await place(sentDraft.id, drafts.id, T1, ["\\Draft"]);
    await place(sentDraft.id, archive.id, T2);
    // In the spam folder when it arrived, let through because the sender is a known contact.
    const rescued = await m("γνωστός στο spam");
    await place(rescued.id, junk.id, T1);
    // The user's own mail whose copy to themselves the server filed as spam.
    const selfCopy = await m("δικό μου", { direction: "OUTBOUND", from: "owner@contoso.example" });
    await place(selfCopy.id, archive.id, T1);
    await place(selfCopy.id, junk.id, T2);
    const visible = [plain, imported, filed, sentDraft, rescued, selfCopy].map((x) => x.id).sort();

    // Moved to the spam folder after MailMe had read it.
    const movedToJunk = await m("στο spam");
    await place(movedToJunk.id, inbox.id, T1);
    await place(movedToJunk.id, junk.id, T2);
    const trashed = await m("στον κάδο");
    await place(trashed.id, inbox.id, T1);
    await place(trashed.id, trash.id, T2);
    const deleted = await m("διαγραμμένο");
    await place(deleted.id, inbox.id, T1, ["\\Seen", "\\DELETED"]);
    const draft = await m("πρόχειρο", { direction: "OUTBOUND", from: "owner@contoso.example" });
    await place(draft.id, drafts.id, T1);
    const hidden = [movedToJunk, trashed, deleted, draft].map((x) => x.id);

    const personal = await m("οικογενειακό");
    await place(personal.id, family.id, T1);
    await place(personal.id, inbox.id, T2);

    const found = async () => (await mail({ allOf: ["φακελοσ"], limit: 12 })).hits.map((h) => h.id).sort();
    expect(await found()).toEqual([...visible, personal.id].sort());
    expect(await loadRecords(t.db, scope, hidden)).toEqual([]);
    for (const id of hidden) expect(await readThread(t.db, scope, id)).toBeNull();

    // The folder is marked private afterwards: a copy that was ever seen there keeps the message out.
    await t.db.update(s.mailboxFolders).set({ private: true }).where(eq(s.mailboxFolders.id, family.id));
    expect(await found()).toEqual(visible);
    expect(await loadRecords(t.db, scope, [personal.id])).toEqual([]);
    expect(await readThread(t.db, scope, personal.id)).toBeNull();
  });

  it("leaves out mail to and from the install's deny-list as it is now, also mail from before an entry was added", async () => {
    const m = (subject: string, over: Partial<MessageSeed> = {}) => insertMessage(t.db, { mailboxId: seed.mailbox.id, subject: `Υπόθεση ${subject}`, text: "κείμενο", sortTs: at("2026-11-18T08:00:00Z"), ...over });
    const lawyer = await m("δικηγόρος", { from: "Maria@Lawyers.example" });
    const clinic = await m("ιατρείο", { from: "results@lab.clinic.example" });
    const toDoctor = await m("προς γιατρό", { direction: "OUTBOUND", from: "owner@contoso.example", to: ["maria@lawyers.example"], cc: ["x@clinic.example"] });
    const viaReplyTo = await m("reply-to", { from: "noreply@forms.example" });
    await patch(viaReplyTo.id, { replyTo: [{ name: null, address: "maria@lawyers.example" }] });
    const mixed = await m("και πελάτης", { direction: "OUTBOUND", from: "owner@contoso.example", to: ["maria@lawyers.example", "buyer@abc-gr.example"], sortTs: at("2026-11-19T08:00:00Z") });
    const near = await m("άλλος", { from: "maria@notlawyers.example", sortTs: at("2026-11-17T08:00:00Z") });
    expect((await mail({ allOf: ["υποθεσ"] })).total).toBe(6);

    const denied = (await loadChatScope(t.db, seed.user.id, ZONE, NOW, { denyList: [" Maria@Lawyers.example ", "@clinic.example", ""] }))!;
    expect(denied.denyList).toEqual(["maria@lawyers.example", "@clinic.example"]);
    const res = await mail({ allOf: ["υποθεσ"] }, denied);
    expect(res.hits.map((h) => h.id)).toEqual([mixed.id, near.id]);
    expect(res.total).toBe(2);
    expect(await loadRecords(t.db, denied, [lawyer.id, clinic.id, toDoctor.id, viaReplyTo.id])).toEqual([]);
    for (const id of [lawyer.id, clinic.id, toDoctor.id, viaReplyTo.id]) expect(await readThread(t.db, denied, id)).toBeNull();
  });

  it("leaves out mail the AI has not read yet, and says how much of it there is", async () => {
    expect(await notAnalysed(t.db, scope)).toEqual({ count: 0, newest: null });
    const read = await insertMessage(t.db, { mailboxId: seed.mailbox.id, subject: "Νέο διαβασμένο", text: "κείμενο", sortTs: at("2026-11-20T08:00:00Z") });
    const waiting = await insertWaitingMessage(t.db, { mailboxId: seed.mailbox.id, subject: "Νέο σε αναμονή", text: "κείμενο", sortTs: at("2026-11-20T09:30:00Z") });
    const failed = await insertWaitingMessage(t.db, { mailboxId: seed.mailbox.id, subject: "Νέο αποτυχημένο", text: "κείμενο", sortTs: at("2026-11-20T09:00:00Z"), state: "failed" });
    // Extracted and not yet applied: readable once the AI's class is known, and never when that class is personal.
    const business = await insertWaitingMessage(t.db, { mailboxId: seed.mailbox.id, subject: "Νέο επαγγελματικό", text: "κείμενο", sortTs: at("2026-11-20T07:00:00Z"), state: "extracted" });
    await patch(business.id, { classification: "ACTIONABLE" });
    const personal = await insertWaitingMessage(t.db, { mailboxId: seed.mailbox.id, subject: "Νέο προσωπικό", text: "κείμενο", sortTs: at("2026-11-20T06:00:00Z"), state: "extracted" });
    await patch(personal.id, { classification: "PERSONAL" });
    const unclassified = await insertWaitingMessage(t.db, { mailboxId: seed.mailbox.id, subject: "Νέο αταξινόμητο", text: "κείμενο", sortTs: at("2026-11-20T05:00:00Z"), state: "extracted" });

    expect((await mail({ allOf: ["νεο"] })).hits.map((h) => h.id)).toEqual([read.id, business.id]);
    expect(await loadRecords(t.db, scope, [waiting.id, failed.id, personal.id, unclassified.id])).toEqual([]);
    expect(await notAnalysed(t.db, scope)).toEqual({ count: 2, newest: at("2026-11-20T09:30:00Z") });
    // Another user's waiting mail is not counted.
    const other = await seedOrgUserMailbox(t.db, { address: "boss@contoso.example", name: "Άλλος Χρήστης" });
    expect(await notAnalysed(t.db, (await loadChatScope(t.db, other.user.id, ZONE, NOW))!)).toEqual({ count: 0, newest: null });
  });
});

describe("who wrote it, and when", () => {
  it("dates a message by when the mail server got it, not by the Date header its sender wrote", async () => {
    const m = await insertMessage(t.db, { mailboxId: seed.mailbox.id, subject: "Τιμολόγιο", text: "κείμενο", sortTs: at("2026-11-18T08:00:00Z") });
    await patch(m.id, { dateHeader: at("2031-01-01T00:00:00Z") });
    const [r] = await loadRecords(t.db, scope, [m.id]);
    expect(r!.date).toEqual(at("2026-11-18T08:00:00Z"));
    expect((await mail({ after: "2026-11-19" })).hits).toEqual([]);
  });

  it("tells a colleague from an outsider by the address, and marks a colleague the server could not authenticate", async () => {
    const failed = { "x-spam-status": "No, score=2.1 required=5.0 tests=SPF_FAIL,TO_EQ_FM_DIRECT_MX autolearn=no version=3.4.6" };
    const passed = { "x-spam-status": "No, score=-1.0 required=5.0 tests=SPF_PASS,DKIM_VALID_AU autolearn=ham version=3.4.6" };
    const m = (from: string, headers: Record<string, string>) =>
      insertMessage(t.db, { mailboxId: seed.mailbox.id, subject: "Αλλαγή IBAN", from, text: "Πληρώστε στον νέο λογαριασμό.", sortTs: at("2026-11-18T08:00:00Z") }).then(async (x) => (await patch(x.id, { headers }), x));
    const colleague = await m("orders@contoso.example", passed);
    const forged = await m("boss@contoso.example", failed);
    const sub = await m("x@mail.contoso.example", {});
    const outsider = await m("x@notcontoso.example", failed);
    const sent = await insertMessage(t.db, { mailboxId: seed.mailbox.id, direction: "OUTBOUND", subject: "Δικό μου", from: "owner@contoso.example", text: "κείμενο" });
    await patch(sent.id, { headers: failed });

    const got = new Map((await loadRecords(t.db, scope, [colleague.id, forged.id, sub.id, outsider.id, sent.id])).map((r) => [r.id, [r.own, r.internal, r.unverified]]));
    expect(got.get(colleague.id)).toEqual([false, true, false]);
    expect(got.get(forged.id)).toEqual([false, true, true]);
    expect(got.get(sub.id)).toEqual([false, true, false]);
    // An outsider can be anybody anyway: nothing is claimed about them.
    expect(got.get(outsider.id)).toEqual([false, false, false]);
    // A copy from the user's own Sent folder is theirs whatever its headers say.
    expect(got.get(sent.id)).toEqual([true, false, false]);
  });
});

describe("read_thread", () => {
  it("returns the conversation oldest first with its tasks, across merged threads, and says what was left out", async () => {
    const root = await insertThread(t.db, seed.mailbox.id, "προσφορα");
    const merged = await insertThread(t.db, seed.mailbox.id, "προσφορα");
    await t.db.update(s.threads).set({ mergedIntoId: root.id }).where(eq(s.threads.id, merged.id));
    const first = await insertMessage(t.db, { mailboxId: seed.mailbox.id, threadId: root.id, subject: "Προσφορά", text: "Στείλτε προσφορά.", sortTs: at("2026-11-10T08:00:00Z") });
    const reply = await insertMessage(t.db, { mailboxId: seed.mailbox.id, threadId: merged.id, subject: "RE: Προσφορά", from: "owner@contoso.example", text: "Σας τη στέλνω αύριο.", sortTs: at("2026-11-10T09:00:00Z") });
    const spam = await insertMessage(t.db, { mailboxId: seed.mailbox.id, threadId: root.id, subject: "Re: Προσφορά", text: "Κέρδισες!", sortTs: at("2026-11-10T10:00:00Z") });
    await patch(spam.id, { state: "filtered", filterReason: "PHISHING" });
    const task = await insertTask(t.db, { orgId: seed.org.id, userId: seed.user.id, mailboxId: seed.mailbox.id, title: "ABC — Προσφορά", threadId: root.id, messageId: first.id });

    for (const anchor of [first.id, reply.id]) {
      const view = (await readThread(t.db, scope, anchor))!;
      expect(view.messages.map((m) => m.id)).toEqual([first.id, reply.id]);
      expect(view.omitted).toBe(0);
      expect(view.tasks.map((x) => x.ref)).toEqual([task.ref]);
    }
    expect((await readThread(t.db, scope, reply.id))!.messages[1]!.own).toBe(true);

    for (let i = 0; i < THREAD_MAX_MESSAGES + 3; i++) await insertMessage(t.db, { mailboxId: seed.mailbox.id, threadId: root.id, subject: `Re: Προσφορά ${i}`, text: `μήνυμα ${i}`, sortTs: at(`2026-11-11T${String(i).padStart(2, "0")}:00:00Z`) });
    const long = (await readThread(t.db, scope, first.id))!;
    // The newest messages, and the one that was asked for even when it is older than those.
    expect(long.messages).toHaveLength(THREAD_MAX_MESSAGES + 1);
    expect(long.messages[0]!.id).toBe(first.id);
    expect(long.messages.at(-1)!.subject).toBe(`Re: Προσφορά ${THREAD_MAX_MESSAGES + 2}`);
    expect(long.omitted).toBe(4);
  });

  it("a message without a conversation is read alone; text that retention dropped is marked", async () => {
    const lone = await insertMessage(t.db, { mailboxId: seed.mailbox.id, subject: "Μόνο του", text: "Ένα μήνυμα.", sortTs: at("2026-08-01T08:00:00Z") });
    await patch(lone.id, { segments: [], textPlain: null, bodyPurgedAt: at("2026-11-01T00:00:00Z") });
    const view = (await readThread(t.db, scope, lone.id))!;
    expect(view.messages).toHaveLength(1);
    expect(view.messages[0]!.textKept).toBe(false);
    expect(view.messages[0]!.segments).toEqual([]);
    expect(await readThread(t.db, scope, "not-a-uuid").catch(() => "threw")).not.toBe("threw");
  });

  it("marks a copy of the user's own mail that the server could not authenticate", async () => {
    const forged = await insertMessage(t.db, { mailboxId: seed.mailbox.id, subject: "Αλλαγή IBAN", from: "owner@contoso.example", text: "Πληρώστε στον νέο λογαριασμό.", sortTs: at("2026-11-18T08:00:00Z") });
    await patch(forged.id, { claimsOwnerSender: true, headers: { "x-spam-status": "No, score=2.1 required=5.0 tests=SPF_FAIL,TO_EQ_FM_DIRECT_MX autolearn=no version=3.4.6" } });
    const real = await insertMessage(t.db, { mailboxId: seed.mailbox.id, subject: "Κανονικό", from: "owner@contoso.example", text: "Γεια.", sortTs: at("2026-11-18T09:00:00Z") });
    await patch(real.id, { claimsOwnerSender: true, headers: { "x-spam-status": "No, score=-1.0 required=5.0 tests=SPF_PASS,DKIM_VALID_AU autolearn=ham version=3.4.6" } });
    const [a, b] = await loadRecords(t.db, scope, [forged.id, real.id]);
    expect([a!.own, a!.unverified]).toEqual([true, true]);
    expect([b!.own, b!.unverified]).toEqual([true, false]);
  });
});

describe("search_tasks", () => {
  it("lists by status and by words: only the user's own, never merged ones, open ones first", async () => {
    const base = { orgId: seed.org.id, userId: seed.user.id, mailboxId: seed.mailbox.id };
    const ask = await insertTask(t.db, { ...base, title: "ABC — Προσφορά για ηχεία", company: "ABC" });
    const promised = await insertTask(t.db, { ...base, title: "XYZ — Να στείλω τιμοκατάλογο", status: "WAITING_FOR_ME", company: "XYZ" });
    const waiting = await insertTask(t.db, { ...base, title: "DEF — Περιμένω υπογραφή", status: "WAITING_FOR_OTHER", company: "DEF" });
    const done = await insertTask(t.db, { ...base, title: "ABC — Παλιά προσφορά", status: "COMPLETED", company: "ABC" });
    const colleague = await insertTask(t.db, { ...base, title: "GHI — Το έχει ο συνάδελφος", company: "GHI" });
    await t.db.update(s.tasks).set({ ownerKind: "INTERNAL", ownerAddress: "orders@contoso.example" }).where(eq(s.tasks.id, colleague.id));
    const merged = await insertTask(t.db, { ...base, title: "ABC — Διπλή προσφορά", company: "ABC" });
    await t.db.update(s.tasks).set({ mergedIntoId: ask.id }).where(eq(s.tasks.id, merged.id));

    const refs = async (q: Partial<TaskQuery>) => (await tasksOf(q)).hits.map((x) => x.ref).sort((a, b) => a - b);
    expect(await refs({ status: "any" })).toEqual([ask.ref, promised.ref, waiting.ref, done.ref, colleague.ref]);
    expect(await refs({ status: "open" })).toEqual([ask.ref, promised.ref, waiting.ref, colleague.ref]);
    expect(await refs({ status: "mine" })).toEqual([ask.ref, promised.ref]);
    expect(await refs({ status: "waiting" })).toEqual([waiting.ref]);
    expect(await refs({ status: "closed" })).toEqual([done.ref]);
    expect(await refs({ allOf: ["ΠΡΟΣΦΟΡ"], status: "any" })).toEqual([ask.ref, done.ref]);
    expect(await refs({ allOf: ["προσφορ"], anyOf: ["ηχει", "δεν-υπαρχει"], status: "any" })).toEqual([ask.ref]);
    expect(await refs({ anyOf: ["τιμοκαταλογ", "υπογραφ"], status: "open" })).toEqual([promised.ref, waiting.ref]);

    const any = await tasksOf({ allOf: ["προσφορ"], status: "any" });
    expect(any.hits.map((x) => x.ref)).toEqual([ask.ref, done.ref]);
    expect(any.total).toBe(2);
    expect((await tasksOf({ status: "any", limit: 2 })).total).toBe(5);
    expect((await taskByRef(t.db, scope, done.ref))?.title).toBe("ABC — Παλιά προσφορά");
    expect(await taskByRef(t.db, scope, merged.ref)).toBeNull();
    expect(await taskByRef(t.db, scope, 0)).toBeNull();
  });
});

describe("folding in searches", () => {
  it("matches a word as plain text: signs that mean something in a pattern are just signs", async () => {
    const odd = await insertMessage(t.db, { mailboxId: seed.mailbox.id, subject: "Τιμή (νέα) 5.0 [A+B] C:\\temp a|b ^start$ {x} 100%?", text: "κείμενο", sortTs: at("2026-11-18T08:00:00Z") });
    await insertMessage(t.db, { mailboxId: seed.mailbox.id, subject: "Άλλο 5x0 ab start x", text: "κείμενο", sortTs: at("2026-11-17T08:00:00Z") });
    const ids = async (word: string) => (await mail({ allOf: [word] })).hits.map((h) => h.id);
    for (const word of ["(νέα)", "5.0", "[a+b]", "c:\\temp", "a|b", "^start$", "{x}", "100%?", "ΤΙΜΉ (ΝΈΑ)"]) expect(await ids(word), word).toEqual([odd.id]);
    // Not a wildcard, not an alternative, not an anchor, not a class.
    for (const word of ["5.0x", "τιμη.*5", "zzz|τιμη", "^τιμη", "[αβ]λλο", "τιμη+", "(τιμη", "τιμη)", "\\d\\d", "100%%"]) expect(await ids(word), word).toEqual([]);
    expect((await tasksOf({ allOf: ["(", "[", "\\"] })).hits).toEqual([]);
  });

  it("finds names with Latin accents in mail, and task words the way the task list stores them", async () => {
    const muller = await insertMessage(t.db, { mailboxId: seed.mailbox.id, subject: "Angebot", from: "j.mueller@gmbh.example", fromName: "Jürgen MÜLLER", text: "Señor José Ibáñez bestätigt.", sortTs: at("2026-11-18T08:00:00Z") });
    expect((await mail({ allOf: ["muller"] })).hits.map((h) => h.id)).toEqual([muller.id]);
    expect((await mail({ allOf: ["Müller"] })).hits.map((h) => h.id)).toEqual([muller.id]);
    expect((await mail({ allOf: ["ibanez"], person: "JÜRGEN" })).hits.map((h) => h.id)).toEqual([muller.id]);
    // A word with a NUL in it is a word with a space: the search runs.
    expect((await mail({ allOf: ["jür\u0000gen"] })).hits).toEqual([]);

    const base = { orgId: seed.org.id, userId: seed.user.id, mailboxId: seed.mailbox.id };
    const task = await insertTask(t.db, { ...base, title: "Müller GmbH — Angebot für José", company: "ABC-Hotels Α.Ε." });
    const refs = async (q: Partial<TaskQuery>) => (await tasksOf(q)).hits.map((x) => x.ref);
    expect(await refs({ allOf: ["Müller"] })).toEqual([task.ref]);
    expect(await refs({ allOf: ["muller", "jose"] })).toEqual([task.ref]);
    // The word is folded the way the task list folds its own text (dashes and dots stay, other signs are spaces).
    expect(await refs({ allOf: ["ABC–Hotels"] })).toEqual([task.ref]);
    expect(await refs({ anyOf: ["«Α.Ε.»"] })).toEqual([task.ref]);
    expect(await refs({ allOf: ["müller\u0000gmbh"] })).toEqual([task.ref]);
  });
});

describe("snippets", () => {
  it("take the start of the message's own text when no word is found there, and nothing when there is no text", () => {
    expect(snippetOf([seg("S1", "NEW", "Πρώτη γραμμή.\n\nΔεύτερη γραμμή.")], ["αγνωστο"])).toBe("Πρώτη γραμμή. Δεύτερη γραμμή.");
    expect(snippetOf([], ["κατι"])).toBe("");
    expect(snippetOf([seg("S1", "QUOTED", "Μόνο παράθεση εδώ.")], [])).toBe("Μόνο παράθεση εδώ.");
  });
});

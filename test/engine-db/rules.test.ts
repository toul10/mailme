import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { withMailRules } from "../../src/ai/rules-extractor.js";
import * as s from "../../src/db/schema.js";
import { buildDigestModel } from "../../src/digest/build.js";
import { createPreviewLinkFactory } from "../../src/digest/links.js";
import { renderDigest } from "../../src/digest/render.js";
import type { MailRule } from "../../src/domain/rules.js";
import { closeAnsweredTasks } from "../../src/engine/answered.js";
import { drainMailbox } from "../../src/engine/pipeline.js";
import { applyRuleDismissals, planRuleDismissals } from "../../src/engine/rule-apply.js";
import { nullLogger } from "../../src/lib/log.js";
import { eventSummary } from "../../src/server/labels.js";
import { insertMessage, insertTask, insertThread, seedOrgUserMailbox, type TestDb } from "../helpers/db.js";
import { fakeExtractor, okResult, output, pipelineDeps, sharedTestDb, testClock, type TestClock } from "./fixtures.js";

let t: TestDb;
let seed: Awaited<ReturnType<typeof seedOrgUserMailbox>>;
let clock: TestClock;
const shared = sharedTestDb();
beforeEach(async () => {
  t = shared();
  seed = await seedOrgUserMailbox(t.db);
  clock = testClock("2026-09-10T09:00:00Z");
});

const setRules = (rules: MailRule[]) => t.db.update(s.users).set({ mailRules: rules }).where(eq(s.users.id, seed.user.id));
const FORWARD: MailRule = { id: "orders-forward", kind: "forward", enabled: true, text: "Παραγγελίες χωρίς το orders@: πες μου", topics: ["παραγγελ", "purchase order"], target: "orders@contoso.example" };
const ANSWERED: MailRule = { id: "answered-internal", kind: "answered", enabled: true, text: "Ό,τι απαντιέται από @contoso.example: report" };
const at = (iso: string) => new Date(iso);

describe("forward rule — through the real context, reconcile and apply", () => {
  const silentAi = () => fakeExtractor(() => okResult(output([], "FYI")));

  async function purchaseOrder(from: string, opts: { cc?: string[]; subject?: string } = {}) {
    const thread = await insertThread(t.db, seed.mailbox.id, "po");
    return insertMessage(t.db, {
      mailboxId: seed.mailbox.id,
      threadId: thread.id,
      from,
      to: ["owner@contoso.example"],
      cc: opts.cc ?? [],
      subject: opts.subject ?? "New Northwind Purchase Order 4500000017",
      text: "Please find attached our purchase order.",
      sortTs: at("2026-09-10T08:00:00Z"),
    });
  }
  /** Earlier mail from the domain, to a colleague too (not only this mailbox): the company knows the sender. */
  const knownDomain = (domain: string, to = ["owner@contoso.example", "m.georgiou@contoso.example"]) =>
    insertMessage(t.db, { mailboxId: seed.mailbox.id, from: `buyer@${domain}`, to, subject: "Τιμή", sortTs: at("2026-09-01T08:00:00Z"), state: "applied" });

  it("a known customer's order without orders@ becomes a task to forward it to orders@ and never reaches the AI", async () => {
    await setRules([FORWARD]);
    await knownDomain("bigretail.example");
    const po = await purchaseOrder("po@bigretail.example");
    const ai = silentAi();
    const report = await drainMailbox(pipelineDeps(t, withMailRules(ai), clock), seed.mailbox.id);
    expect(report).toMatchObject({ processed: 1, applied: 1 });
    expect(ai.calls).toHaveLength(0);
    const [task] = await t.db.select().from(s.tasks).where(eq(s.tasks.originMessageId, po.id));
    expect(task).toMatchObject({ title: "Forward to orders@contoso.example: New Northwind Purchase Order 4500000017", status: "ACTION_REQUIRED", needsReview: false });
    const [create] = await t.db.select().from(s.taskEvents).where(eq(s.taskEvents.taskId, task!.id));
    expect(create).toMatchObject({ op: "CREATE", evidenceSource: "NEW", evidenceQuote: "Please find attached our purchase order." });
    const [ext] = await t.db.select().from(s.extractions).where(eq(s.extractions.messageId, po.id));
    expect(ext!.model).toBe("rules");
  });

  it("goes to the AI instead: orders@ already in Cc, a first-contact domain (fake POs), or no rule", async () => {
    await setRules([FORWARD]);
    await knownDomain("bigretail.example");
    await purchaseOrder("po@bigretail.example", { cc: ["orders@contoso.example"] });
    const ai = silentAi();
    await drainMailbox(pipelineDeps(t, withMailRules(ai), clock), seed.mailbox.id);
    expect(ai.calls).toHaveLength(1);

    // A fake-PO campaign: its earlier mail reached the AI, but only ever came to this mailbox.
    await knownDomain("newbuyer.example", ["owner@contoso.example"]);
    await purchaseOrder("sales@newbuyer.example", { subject: "Παραγγελία No. 1234/567" });
    await drainMailbox(pipelineDeps(t, withMailRules(ai), clock), seed.mailbox.id);
    expect(ai.calls).toHaveLength(2);
    expect(ai.calls[1]!.rules).toMatchObject({ external: true, senderKnown: false });

    await setRules([]);
    await purchaseOrder("po@bigretail.example", { subject: "Purchase order 77" });
    await drainMailbox(pipelineDeps(t, withMailRules(ai), clock), seed.mailbox.id);
    expect(ai.calls).toHaveLength(3);
    expect(ai.calls[2]!.rules).toBeUndefined();
    expect(await t.db.select().from(s.tasks)).toHaveLength(0);
  });
});

describe("suppliers — rules that only name tasks", () => {
  const SUPPLIER: MailRule = { id: "supplier-northwind", kind: "supplier", enabled: true, text: "Northwind", name: "Northwind", senders: ["@northwind.example"] };
  const fromSupplier = async () => {
    const thread = await insertThread(t.db, seed.mailbox.id, "price list");
    return insertMessage(t.db, { mailboxId: seed.mailbox.id, threadId: thread.id, from: "ion@northwind.example", to: ["owner@contoso.example"], subject: "Price list", text: "Please confirm the new price list.", sortTs: at("2026-09-10T08:00:00Z") });
  };

  it("the AI is given the mail exactly as without them: a user with suppliers only has no rules to tell", async () => {
    await setRules([SUPPLIER]);
    await fromSupplier();
    const ai = fakeExtractor(() => okResult(output([], "FYI")));
    await drainMailbox(pipelineDeps(t, withMailRules(ai), clock), seed.mailbox.id);
    expect(ai.calls).toHaveLength(1);
    expect(ai.calls[0]!.rules).toBeUndefined();
  });

  it("next to other rules, only the other rules reach the engine and the AI", async () => {
    await setRules([FORWARD, SUPPLIER, { ...SUPPLIER, id: "supplier-off", name: "Off", senders: ["@off.example"], enabled: false }]);
    await fromSupplier();
    const ai = fakeExtractor(() => okResult(output([], "FYI")));
    await drainMailbox(pipelineDeps(t, withMailRules(ai), clock), seed.mailbox.id);
    expect(ai.calls[0]!.rules?.list).toEqual([FORWARD]);
  });
});

describe("answered rule — someone at the organization replied", () => {
  async function request(opts: { from?: string } = {}) {
    const thread = await insertThread(t.db, seed.mailbox.id, "ζητηση");
    const origin = await insertMessage(t.db, { mailboxId: seed.mailbox.id, threadId: thread.id, from: opts.from ?? "client@abc-gr.example", subject: "Ζήτηση προσφοράς", sortTs: at("2026-09-08T08:00:00Z"), state: "applied" });
    const task = await insertTask(t.db, { orgId: seed.org.id, userId: seed.user.id, mailboxId: seed.mailbox.id, threadId: thread.id, messageId: origin.id });
    return { thread, origin, task };
  }
  const reply = (threadId: string, from: string, subject = "ΑΠ: Ζήτηση προσφοράς", extra: { headers?: Record<string, string>; fromName?: string } = {}) =>
    insertMessage(t.db, { mailboxId: seed.mailbox.id, threadId, from, fromName: extra.fromName ?? "Συνάδελφος", subject, sortTs: at("2026-09-09T08:00:00Z"), state: "applied" }).then(async (m) => {
      if (extra.headers) await t.db.update(s.messages).set({ headers: extra.headers }).where(eq(s.messages.id, m.id));
      return m;
    });
  const sweep = () => closeAnsweredTasks({ db: t.db, clock, log: nullLogger }, seed.mailbox.id);
  const status = async (id: string) => (await t.db.select().from(s.tasks).where(eq(s.tasks.id, id)))[0]!;

  it("a colleague's reply completes the request (system) and records who answered", async () => {
    await setRules([ANSWERED]);
    const { thread, task } = await request();
    const r = await reply(thread.id, "m.georgiou@contoso.example");
    expect(await sweep()).toMatchObject({ closed: 1 });
    expect(await status(task.id)).toMatchObject({ status: "COMPLETED", closedBy: "system" });
    const [ev] = await t.db.select().from(s.taskEvents).where(and(eq(s.taskEvents.taskId, task.id), eq(s.taskEvents.op, "SYSTEM_ANSWERED")));
    expect(ev).toMatchObject({ actor: "system", messageId: r.id, payload: { by: "m.georgiou@contoso.example" } });
    // Reopened by the owner: theirs from now on.
    await t.db.update(s.tasks).set({ status: "ACTION_REQUIRED", closedBy: null, closedAt: null }).where(eq(s.tasks.id, task.id));
    expect(await sweep()).toMatchObject({ closed: 0 });
  });

  it("not an answer: a forward to the owner («ΠΡ:», «FW:»), the requester writing again, a forged colleague, no rule", async () => {
    await setRules([ANSWERED]);
    const a = await request();
    await reply(a.thread.id, "m.georgiou@contoso.example", "ΠΡ: Ζήτηση προσφοράς");
    await reply(a.thread.id, "m.georgiou@contoso.example", "FW: Ζήτηση προσφοράς");
    const b = await request({ from: "maria@contoso.example" });
    await reply(b.thread.id, "maria@contoso.example", "RE: Ζήτηση προσφοράς");
    const c = await request();
    await reply(c.thread.id, "it@contoso.example", "RE: Ζήτηση προσφοράς", {
      headers: { "x-spam-status": "No, score=3.8 required=5.0 tests=SPF_NEUTRAL,TO_EQ_FM_DIRECT_MX autolearn=no version=3.4.6" },
    });
    const d = await request();
    await reply(d.thread.id, "client@abc-gr.example", "RE: Ζήτηση προσφοράς");
    expect(await sweep()).toMatchObject({ closed: 0 });
    await setRules([]);
    const e = await request();
    await reply(e.thread.id, "m.georgiou@contoso.example");
    expect(await sweep()).toEqual({ closed: 0, handedOver: 0, planned: [] });
  });

  it("a reply the owner's own ignore rule set aside still answers; other filtered mail does not", async () => {
    await setRules([ANSWERED]);
    const filtered = (id: string, filterReason: string) => t.db.update(s.messages).set({ state: "filtered", filterReason, filterRule: filterReason === "RULE" ? "orders-ignore" : null }).where(eq(s.messages.id, id));
    const a = await request();
    await filtered((await reply(a.thread.id, "m.georgiou@contoso.example")).id, "OUT_OF_OFFICE");
    const b = await request();
    await filtered((await reply(b.thread.id, "m.georgiou@contoso.example")).id, "RULE");
    expect((await sweep()).planned.map((p) => [p.ref, p.kind])).toEqual([[b.task.ref, "answered"]]);
    expect(await status(a.task.id)).toMatchObject({ status: "ACTION_REQUIRED" });
    expect(await status(b.task.id)).toMatchObject({ status: "COMPLETED", closedBy: "system" });
  });

  it("a thread joined by subject alone: only a reply that names the request's own Message-ID answers", async () => {
    await setRules([ANSWERED]);
    const { thread, origin, task } = await request();
    await t.db.update(s.threads).set({ linkConfidence: "LOW" }).where(eq(s.threads.id, thread.id));
    await reply(thread.id, "m.georgiou@contoso.example");
    expect(await sweep()).toMatchObject({ closed: 0 });
    await insertMessage(t.db, { mailboxId: seed.mailbox.id, threadId: thread.id, from: "m.georgiou@contoso.example", subject: "ΑΠ: Ζήτηση προσφοράς", sortTs: at("2026-09-09T09:00:00Z"), state: "applied", references: [`<${origin.messageIdHeader}>`] });
    expect(await sweep()).toMatchObject({ closed: 1 });
    expect(await status(task.id)).toMatchObject({ status: "COMPLETED" });
  });

  it("runs after a drain, under the drain lock, and the report lists it under “Answered”", async () => {
    await setRules([ANSWERED, { id: "report-summary", kind: "summary", enabled: true, text: "Σύνοψη" }]);
    const { thread, task } = await request();
    await reply(thread.id, "owner@contoso.example", "ΑΠ: Ζήτηση προσφοράς", { fromName: "Δέσποινα" });
    const report = await drainMailbox(pipelineDeps(t, fakeExtractor(() => okResult(output([]))), clock), seed.mailbox.id);
    expect(report.answered).toBe(1);
    expect(await status(task.id)).toMatchObject({ status: "COMPLETED", closedBy: "system" });

    const model = await buildDigestModel(t.db, seed.user.id, "2026-09-10", at("2026-09-10T09:30:00Z"));
    expect(model.rules?.answered).toEqual([{ taskId: task.id, ref: task.ref, title: task.title, by: "Δέσποινα" }]);
    expect(model.rules?.summary).toMatchObject({ answered: 1 });
    const { html, text } = await renderDigest(model, createPreviewLinkFactory("http://localhost:3000"));
    expect(text).toContain("💬 Answered (1)");
    expect(text).toContain("Summary:");
    expect(html).toContain("— answered by Δέσποινα");
  });
});

describe("forwards — the forward rule's task and a request the owner hands to a colleague", () => {
  const sweep = (opts: { dryRun?: boolean } = {}) => closeAnsweredTasks({ db: t.db, clock, log: nullLogger }, seed.mailbox.id, opts);
  const task = async (id: string) => (await t.db.select().from(s.tasks).where(eq(s.tasks.id, id)))[0]!;
  const events = (taskId: string, op: string) => t.db.select().from(s.taskEvents).where(and(eq(s.taskEvents.taskId, taskId), eq(s.taskEvents.op, op)));
  type Mail = { from: string; to: string[]; cc?: string[]; subject: string; at: string; state?: "applied" | "pending" | "filtered"; fromName?: string };
  const mail = (threadId: string, m: Mail) =>
    insertMessage(t.db, { mailboxId: seed.mailbox.id, threadId, from: m.from, fromName: m.fromName ?? null, to: m.to, cc: m.cc ?? [], subject: m.subject, sortTs: at(m.at), state: m.state ?? "applied" });

  /** A known customer's order without orders@: the forward rule's own task, through a real drain. */
  async function orderTask() {
    await insertMessage(t.db, { mailboxId: seed.mailbox.id, from: "buyer@bigretail.example", to: ["owner@contoso.example", "m.georgiou@contoso.example"], subject: "Τιμή", sortTs: at("2026-09-01T08:00:00Z"), state: "applied" });
    const thread = await insertThread(t.db, seed.mailbox.id, "po");
    const po = await insertMessage(t.db, { mailboxId: seed.mailbox.id, threadId: thread.id, from: "po@bigretail.example", subject: "Purchase Order 4500000017", text: "Please find attached our purchase order.", sortTs: at("2026-09-08T08:00:00Z") });
    await drainMailbox(pipelineDeps(t, withMailRules(fakeExtractor(() => okResult(output([], "FYI")))), clock), seed.mailbox.id);
    const [made] = await t.db.select().from(s.tasks).where(eq(s.tasks.originMessageId, po.id));
    expect(made!.title).toBe("Forward to orders@contoso.example: Purchase Order 4500000017");
    return { thread, po, made: made! };
  }
  async function request() {
    const thread = await insertThread(t.db, seed.mailbox.id, "ζητηση");
    const origin = await insertMessage(t.db, { mailboxId: seed.mailbox.id, threadId: thread.id, from: "client@abc-gr.example", subject: "Ζήτηση προσφοράς", sortTs: at("2026-09-08T08:00:00Z"), state: "applied" });
    const made = await insertTask(t.db, { orgId: seed.org.id, userId: seed.user.id, mailboxId: seed.mailbox.id, threadId: thread.id, messageId: origin.id });
    return { thread, origin, made };
  }
  const FORWARD_TO_NIKOS: Omit<Mail, "at"> = { from: "owner@contoso.example", fromName: "Δέσποινα", to: ["nikos@contoso.example"], cc: ["owner@contoso.example"], subject: "ΠΡ: Ζήτηση προσφοράς" };

  it("the forward rule's task is completed once the mail reaches the rule's target — with no “answered” rule, and through an ignore rule", async () => {
    await setRules([FORWARD]);
    const { thread, made } = await orderTask();
    // To a colleague, not to orders@: nothing yet (and no hand-over without the "answered" rule).
    await mail(thread.id, { from: "owner@contoso.example", to: ["nikos@contoso.example"], subject: "ΠΡ: Purchase Order 4500000017", at: "2026-09-08T09:00:00Z" });
    expect(await sweep()).toEqual({ closed: 0, handedOver: 0, planned: [] });
    // The owner's forward to orders@, which the owner's own "orders@ in the recipients: ignore" rule set aside.
    const fwd = await mail(thread.id, { ...FORWARD_TO_NIKOS, to: ["orders@contoso.example"], subject: "ΠΡ: Purchase Order 4500000017", at: "2026-09-09T08:00:00Z", state: "filtered" });
    await t.db.update(s.messages).set({ filterReason: "RULE", filterRule: "orders-ignore" }).where(eq(s.messages.id, fwd.id));
    expect((await sweep({ dryRun: true })).planned).toEqual([{ taskId: made.id, ref: made.ref, title: made.title, kind: "forwarded", by: "owner@contoso.example", to: "orders@contoso.example" }]);
    expect(await task(made.id)).toMatchObject({ status: "ACTION_REQUIRED" });
    expect(await sweep()).toMatchObject({ closed: 1, handedOver: 0 });
    expect(await task(made.id)).toMatchObject({ status: "COMPLETED", closedBy: "system" });
    const [ev] = await events(made.id, "SYSTEM_ANSWERED");
    expect(ev).toMatchObject({ actor: "system", messageId: fwd.id, payload: { by: "owner@contoso.example", name: "Δέσποινα", forwardedTo: "orders@contoso.example" } });
    expect(eventSummary(ev!)).toBe("Forwarded to orders@contoso.example by Δέσποινα");

    // The report says where it went.
    await setRules([FORWARD, ANSWERED]);
    const model = await buildDigestModel(t.db, seed.user.id, "2026-09-10", at("2026-09-10T09:30:00Z"));
    expect(model.rules?.answered).toEqual([expect.objectContaining({ taskId: made.id, ref: made.ref, by: "Δέσποινα", forwardedTo: "orders@contoso.example" })]);
    const { html, text } = await renderDigest(model, createPreviewLinkFactory("http://localhost:3000"));
    // Addresses are defanged in the report (the dot becomes "․"), so no mail client links them.
    expect(text).toMatch(/— forwarded to orders@contoso.example \(Δέσποινα\)/u);
    expect(html).not.toContain("answered by");
  });

  it("also when the target itself writes in the thread, or the rule was switched off since; never for another task", async () => {
    await setRules([FORWARD, ANSWERED]);
    const a = await orderTask();
    await setRules([{ ...FORWARD, enabled: false }, ANSWERED]);
    // Not a reply by its subject, so the "answered" rule alone would not count it.
    await mail(a.thread.id, { from: "orders@contoso.example", to: ["po@bigretail.example"], cc: ["owner@contoso.example"], subject: "Order confirmation 4500000017", at: "2026-09-09T08:00:00Z" });
    const b = await request();
    await mail(b.thread.id, { from: "owner@contoso.example", to: ["orders@contoso.example"], subject: "Ζήτηση προσφοράς — για εσάς", at: "2026-09-09T08:00:00Z" });
    expect((await sweep({ dryRun: true })).planned.map((p) => [p.ref, p.kind, p.to])).toEqual([[a.made.ref, "forwarded", "orders@contoso.example"]]);
  });

  it("the owner's forward to a colleague hands the request over: open, the colleague's, and completed by a reply to the customer", async () => {
    await setRules([ANSWERED]);
    const { thread, made } = await request();
    const fwd = await mail(thread.id, { ...FORWARD_TO_NIKOS, at: "2026-09-08T10:00:00Z" });
    expect(await sweep()).toMatchObject({ closed: 0, handedOver: 1, planned: [{ ref: made.ref, kind: "handed_over", by: "owner@contoso.example", to: "nikos@contoso.example" }] });
    expect(await task(made.id)).toMatchObject({ status: "ACTION_REQUIRED", ownerKind: "INTERNAL", ownerAddress: "nikos@contoso.example", closedBy: null });
    const [ev] = await events(made.id, "SYSTEM_FORWARDED");
    expect(ev).toMatchObject({ actor: "system", messageId: fwd.id, before: { ownerKind: "ME" }, after: { ownerKind: "INTERNAL" }, payload: { by: "owner@contoso.example", to: "nikos@contoso.example", on: "2026-09-08" } });
    expect(eventSummary(ev!)).toBe("Handled by nikos@contoso.example · forwarded on 8 Sep 2026");
    expect(await sweep()).toEqual({ closed: 0, handedOver: 0, planned: [] });

    // Said once in the report; the colleague's task appears in no other section.
    const model = await buildDigestModel(t.db, seed.user.id, "2026-09-10", at("2026-09-10T09:30:00Z"));
    expect(model.rules?.handedOver).toEqual([{ taskId: made.id, ref: made.ref, title: made.title, to: "nikos@contoso.example" }]);
    expect(model.isEmpty).toBe(false);
    const { text } = await renderDigest(model, createPreviewLinkFactory("http://localhost:3000"));
    expect(text).toContain("↪ Forwarded to a colleague (1)");
    expect(text).toMatch(/— handled by nikos@contoso.example/u);

    // "ok, I will call them" to the owner answers nobody; the reply to the customer does.
    await mail(thread.id, { from: "nikos@contoso.example", to: ["owner@contoso.example"], subject: "RE: ΠΡ: Ζήτηση προσφοράς", at: "2026-09-08T11:00:00Z" });
    expect(await sweep()).toEqual({ closed: 0, handedOver: 0, planned: [] });
    const answer = await mail(thread.id, { from: "nikos@contoso.example", fromName: "Νίκος Παππάς", to: ["purchasing@abc-gr.example"], cc: ["owner@contoso.example"], subject: "RE: Ζήτηση προσφοράς", at: "2026-09-09T08:00:00Z" });
    expect(await sweep()).toMatchObject({ closed: 1, handedOver: 0, planned: [{ kind: "answered", by: "nikos@contoso.example" }] });
    expect(await task(made.id)).toMatchObject({ status: "COMPLETED", closedBy: "system", ownerKind: "INTERNAL" });
    expect((await events(made.id, "SYSTEM_ANSWERED"))[0]).toMatchObject({ messageId: answer.id, payload: { name: "Νίκος Παππάς" } });
  });

  it("the same result when the forward and the colleague's “ok” are read together; a reply before the forward is a plain answer", async () => {
    await setRules([ANSWERED]);
    const a = await request();
    await mail(a.thread.id, { ...FORWARD_TO_NIKOS, at: "2026-09-08T10:00:00Z" });
    await mail(a.thread.id, { from: "nikos@contoso.example", to: ["owner@contoso.example"], subject: "RE: ΠΡ: Ζήτηση προσφοράς", at: "2026-09-08T11:00:00Z" });
    const b = await request();
    await mail(b.thread.id, { from: "nikos@contoso.example", to: ["owner@contoso.example"], subject: "RE: Ζήτηση προσφοράς", at: "2026-09-08T09:00:00Z" });
    await mail(b.thread.id, { ...FORWARD_TO_NIKOS, at: "2026-09-08T10:00:00Z" });
    expect((await sweep()).planned.map((p) => [p.ref, p.kind])).toEqual([
      [a.made.ref, "handed_over"],
      [b.made.ref, "answered"],
    ]);
  });

  it("not a hand-over: a forward to a supplier, by a colleague, forged, still in the AI's queue, one the AI acted on, or without the rule", async () => {
    await setRules([ANSWERED]);
    const supplier = await request();
    await mail(supplier.thread.id, { ...FORWARD_TO_NIKOS, to: ["sales@supplier.example", "nikos@contoso.example"], at: "2026-09-08T10:00:00Z" });
    const colleague = await request();
    await mail(colleague.thread.id, { ...FORWARD_TO_NIKOS, from: "maria@contoso.example", at: "2026-09-08T10:00:00Z" });
    const forged = await request();
    const f = await mail(forged.thread.id, { ...FORWARD_TO_NIKOS, at: "2026-09-08T10:00:00Z" });
    await t.db.update(s.messages).set({ headers: { "x-spam-status": "No, score=3.8 required=5.0 tests=SPF_NEUTRAL,TO_EQ_FM_DIRECT_MX autolearn=no version=3.4.6" } }).where(eq(s.messages.id, f.id));
    const queued = await request();
    const q = await mail(queued.thread.id, { ...FORWARD_TO_NIKOS, at: "2026-09-08T10:00:00Z", state: "pending" });
    const byAi = await request();
    const m = await mail(byAi.thread.id, { ...FORWARD_TO_NIKOS, at: "2026-09-08T10:00:00Z" });
    await t.db.insert(s.taskEvents).values({ taskId: byAi.made.id, userId: seed.user.id, mailboxId: seed.mailbox.id, messageId: m.id, actor: "ai", op: "SUGGEST_DISMISS", applied: false, suggestionState: "pending" });
    expect(await sweep()).toEqual({ closed: 0, handedOver: 0, planned: [] });

    // Read by the AI with nothing to say: now it is handed over.
    await t.db.update(s.messages).set({ state: "applied" }).where(eq(s.messages.id, q.id));
    expect((await sweep({ dryRun: true })).planned.map((p) => [p.ref, p.kind])).toEqual([[queued.made.ref, "handed_over"]]);
    await setRules([]);
    expect(await sweep()).toEqual({ closed: 0, handedOver: 0, planned: [] });
    expect(await task(queued.made.id)).toMatchObject({ ownerKind: "ME" });
  });
});

describe("updates rule and the report without rules", () => {
  it("the owner's own announcements (not replies) are listed under “Updates”", async () => {
    await setRules([{ id: "updates", kind: "updates", enabled: true, text: "Ενημερωτικά", topics: ["προϊόντ", "προσφορ"], except: ["ζήτηση προσφορ"] }]);
    const own = (subject: string) =>
      insertMessage(t.db, { mailboxId: seed.mailbox.id, from: "owner@contoso.example", to: ["a@abc-gr.example", "b@def.example"], subject, sortTs: at("2026-09-10T07:00:00Z"), state: "applied" }).then((m) =>
        t.db.update(s.messages).set({ claimsOwnerSender: true }).where(eq(s.messages.id, m.id)),
      );
    await own("ΝΕΑ ΠΡΟΪΟΝΤΑ - ΝΕΟΣ ΤΙΜΟΚΑΤΑΛΟΓΟΣ");
    await own("ΑΠ: ΝΕΑ ΠΡΟΪΟΝΤΑ");
    await own("ΖΗΤΗΣΗ ΠΡΟΣΦΟΡΑΣ για ηχεία");
    const model = await buildDigestModel(t.db, seed.user.id, "2026-09-10", at("2026-09-10T09:30:00Z"));
    expect(model.rules?.updates.map((u) => [u.subject, u.recipients])).toEqual([["ΝΕΑ ΠΡΟΪΟΝΤΑ - ΝΕΟΣ ΤΙΜΟΚΑΤΑΛΟΓΟΣ", 2]]);
    expect(model.isEmpty).toBe(false);
    const { text } = await renderDigest(model, createPreviewLinkFactory("http://localhost:3000"));
    expect(text).toContain("📣 Updates (1)");
  });

  it("without rules the model has no rule blocks", async () => {
    const model = await buildDigestModel(t.db, seed.user.id, "2026-09-10", at("2026-09-10T09:30:00Z"));
    expect(model.rules).toBeUndefined();
  });
});

describe("rules:apply — ignore rules on the open tasks", () => {
  it("plans the tasks an ignore rule now covers and dismisses them as the system", async () => {
    const webinar = await insertMessage(t.db, { mailboxId: seed.mailbox.id, subject: "Webinar | Μισθολογική Διαφάνεια", text: "Δηλώστε συμμετοχή.", state: "applied" });
    const keep = await insertMessage(t.db, { mailboxId: seed.mailbox.id, subject: "Τιμή και διαθεσιμότητα", state: "applied" });
    const w = await insertTask(t.db, { orgId: seed.org.id, userId: seed.user.id, mailboxId: seed.mailbox.id, messageId: webinar.id });
    await insertTask(t.db, { orgId: seed.org.id, userId: seed.user.id, mailboxId: seed.mailbox.id, messageId: keep.id });
    const rules: MailRule[] = [{ id: "webinars", kind: "ignore", enabled: true, text: "Webinar: ignore", topics: ["webinar"] }];
    expect(await planRuleDismissals(t.db, seed.user.id)).toEqual([]);
    const plan = await planRuleDismissals(t.db, seed.user.id, rules);
    expect(plan.map((p) => [p.taskId, p.ruleId])).toEqual([[w.id, "webinars"]]);
    expect(await applyRuleDismissals(t.db, plan, at("2026-09-10T10:00:00Z"))).toBe(1);
    const [after] = await t.db.select().from(s.tasks).where(eq(s.tasks.id, w.id));
    expect(after).toMatchObject({ status: "DISMISSED", closedBy: "system" });
    const [ev] = await t.db.select().from(s.taskEvents).where(eq(s.taskEvents.taskId, w.id));
    expect(ev).toMatchObject({ op: "SYSTEM_RULE_DISMISS", payload: { rule: "webinars" } });
    expect(await applyRuleDismissals(t.db, plan, at("2026-09-10T10:00:00Z"))).toBe(0);
  });
});

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
    expect(await sweep()).toEqual({ closed: 0, planned: [] });
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

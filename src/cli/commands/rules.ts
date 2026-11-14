import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { mailboxes, users } from "../../db/schema.js";
import { normalizeRules, type MailRule } from "../../domain/rules.js";
import { closeAnsweredTasks } from "../../engine/answered.js";
import { applyRuleDismissals, planRuleDismissals } from "../../engine/rule-apply.js";
import { UsageError } from "../args.js";
import { audit, findUser } from "../context.js";
import { yesOpt, type Command } from "./types.js";

const userOpt = { type: "string", required: true, arg: "<email|id>", description: "User" } as const;

function describe(r: MailRule): string {
  const parts = [`${r.enabled ? "on " : "off"}  ${r.id} [${r.kind}]  ${r.text}`];
  if (r.topics?.length) parts.push(`      topics: ${r.topics.join(", ")}`);
  if (r.except?.length) parts.push(`      except: ${r.except.join(", ")}`);
  if (r.recipients?.length) parts.push(`      recipients: ${r.recipients.join(", ")}`);
  if (r.target) parts.push(`      target: ${r.target}`);
  return parts.join("\n");
}

const short = (s: string) => (s.length > 70 ? `${s.slice(0, 69)}…` : s);

export const rulesList: Command = {
  name: "rules:list",
  summary: "Show a user's mail rules (format: docs/rules/README.md)",
  options: { user: userOpt },
  async run(ctx, args) {
    const rt = await ctx.runtime();
    const user = await findUser(rt.db, args.req("user"));
    const [u] = await rt.db.select({ mailRules: users.mailRules }).from(users).where(eq(users.id, user.id));
    const { rules, skipped } = normalizeRules(u?.mailRules);
    if (!rules.length && !skipped.length) ctx.io.out("No rules.");
    for (const r of rules) ctx.io.out(describe(r));
    for (const s of skipped) ctx.io.err(`unusable: ${s.id} — ${s.error}`);
    return skipped.length ? 1 : 0;
  },
};

/** Reads a rules file (a list, or { rules: [...] }); any unusable rule is an error. */
function readRulesFile(file: string, err: (s: string) => void): MailRule[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new UsageError(`Cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const { rules, skipped } = normalizeRules(Array.isArray(raw) ? raw : (raw as { rules?: unknown })?.rules);
  if (skipped.length) {
    for (const s of skipped) err(`${s.id}: ${s.error}`);
    throw new UsageError("Fix the rules above; nothing was changed");
  }
  return rules;
}

export const rulesImport: Command = {
  name: "rules:import",
  summary: "Replace a user's mail rules with a JSON file (a list, or { rules: [...] }); refuses any unusable rule",
  options: {
    user: userOpt,
    file: { type: "string", required: true, arg: "<rules.json>", description: "Rules file (e.g. docs/rules/example.json)" },
    yes: yesOpt,
  },
  async run(ctx, args) {
    const rt = await ctx.runtime();
    const user = await findUser(rt.db, args.req("user"));
    const rules = readRulesFile(args.req("file"), (s) => ctx.io.err(s));
    for (const r of rules) ctx.io.out(describe(r));
    if (!args.bool("yes") && !(await ctx.io.confirm(`Replace the rules of ${user.email} with these ${rules.length}?`))) return 1;
    await rt.db.update(users).set({ mailRules: rules }).where(eq(users.id, user.id));
    await audit(rt.db, "rules_imported", { orgId: user.orgId, userId: user.id, detail: { count: rules.length, ids: rules.map((r) => r.id) }, now: ctx.now() });
    ctx.io.out(`Imported ${rules.length} rule(s) for ${user.email}. They apply from the next mail; run rules:apply for the open tasks.`);
  },
};

export const rulesApply: Command = {
  name: "rules:apply",
  summary: "Apply a user's rules to the open tasks: ignore rules dismiss, the answered rule completes (dry run without --yes)",
  options: {
    user: userOpt,
    file: { type: "string", arg: "<rules.json>", description: "What-if: use this file's rules instead of the stored ones (dry run only)" },
    yes: { type: "boolean", description: "Write the changes (default: only show them)" },
  },
  async run(ctx, args) {
    const rt = await ctx.runtime();
    const user = await findUser(rt.db, args.req("user"));
    const file = args.str("file");
    const override = file ? readRulesFile(file, (s) => ctx.io.err(s)) : undefined;
    if (override && args.bool("yes")) throw new UsageError("--file is a dry run; import the rules first (rules:import), then rules:apply --yes");
    const write = args.bool("yes");
    const deps = rt.pipelineDeps;
    const boxes = await rt.db.select({ id: mailboxes.id, address: mailboxes.address }).from(mailboxes).where(eq(mailboxes.userId, user.id));
    const plan = await planRuleDismissals(rt.db, user.id, override);
    let dismissed = 0;
    let answered = 0;
    let busy = 0;
    for (const mb of boxes) {
      // Same lock as drain/apply: no race with the worker.
      const res = await deps.withLock(`drain:${mb.id}`, async () => {
        const mine = plan.filter((d) => d.mailboxId === mb.id);
        for (const d of mine) ctx.io.out(`dismiss   #${d.ref} ${short(d.title)}  ← rule ${d.ruleId}`);
        if (write) dismissed += await applyRuleDismissals(rt.db, mine, ctx.now());
        const sweep = await closeAnsweredTasks(deps, mb.id, { dryRun: !write, ...(override ? { rules: override } : {}) });
        for (const t of sweep.planned) ctx.io.out(`answered  #${t.ref} ${short(t.title)}  ← ${t.by ?? "?"}`);
        answered += write ? sweep.closed : sweep.planned.length;
      });
      if (!res.acquired) {
        busy++;
        ctx.io.err(`${mb.address}: busy (a drain holds the lock); try again in a minute`);
      }
    }
    const planned = write ? `${dismissed} dismissed, ${answered} completed as answered` : `${plan.length} to dismiss, ${answered} to complete as answered — run again with --yes to write`;
    ctx.io.out(planned);
    if (write) await audit(rt.db, "rules_applied", { orgId: user.orgId, userId: user.id, detail: { dismissed, answered }, now: ctx.now() });
    return busy ? 1 : 0;
  },
};

export const ruleCommands: Command[] = [rulesList, rulesImport, rulesApply];

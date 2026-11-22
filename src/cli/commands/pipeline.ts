import { chmodSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { DateTime } from "luxon";
import { probeAdvice, probeExtractor } from "../../ai/probe.js";
import { AI_KEY_ENV, AI_PROVIDER_LABELS, type AiProvider } from "../../ai/providers.js";
import { CHAT_KEY_ENV, createChatModel } from "../../chat/model.js";
import { chatProbeAdvice, probeChat, PROBE_QUESTION } from "../../chat/probe.js";
import { digests, organizations } from "../../db/schema.js";
import { SMTP_UNKNOWN } from "../../digest/dispatch.js";
import type { PipelineDeps } from "../../engine/pipeline.js";
import { UsageError } from "../args.js";
import { assertIsoDate, findMailbox, findUser, type CliContext } from "../context.js";
import { yesOpt, type Command } from "./types.js";

/** Expand directories (recursively) to their .eml files; plain files are taken as given. Sorted for a stable order. */
export function collectEmlFiles(inputs: string[]): string[] {
  const out: string[] = [];
  for (const input of inputs) {
    const st = statSync(input, { throwIfNoEntry: false });
    if (!st) throw new UsageError(`Not found: ${input}`);
    if (st.isDirectory()) {
      const files = readdirSync(input, { recursive: true, encoding: "utf8" })
        .filter((f) => f.toLowerCase().endsWith(".eml"))
        .map((f) => path.join(input, f))
        .sort();
      out.push(...files);
    } else {
      out.push(input);
    }
  }
  return [...new Set(out)];
}

async function userToday(ctx: CliContext, orgId: string): Promise<string> {
  const rt = await ctx.runtime();
  const [org] = await rt.db.select({ timezone: organizations.timezone }).from(organizations).where(eq(organizations.id, orgId));
  return DateTime.fromJSDate(ctx.now(), { zone: org?.timezone || rt.config.DEFAULT_TIMEZONE }).toISODate()!;
}

export const importEml: Command = {
  name: "import:eml",
  summary: "Import .eml files (fixtures, one-off history) through the normal ingest path",
  options: {
    mailbox: { type: "string", required: true, arg: "<id|address>", description: "Target mailbox" },
    outbound: { type: "boolean", description: "The files are the owner's sent mail (still requires From = owner)" },
  },
  positional: { name: "dir|files", min: 1, max: Number.POSITIVE_INFINITY },
  async run(ctx, args) {
    const rt = await ctx.runtime();
    const mb = await findMailbox(rt.db, args.req("mailbox"));
    const files = collectEmlFiles(args.positionals);
    if (files.length === 0) throw new UsageError("No .eml files found");
    ctx.io.out(`Importing ${files.length} file(s) into mailbox ${mb.id}…`);
    const r = await ctx.services.importEmlFiles({ ingest: rt.ingest }, mb.id, files, { declaredOutbound: args.bool("outbound") });
    ctx.io.out(`Imported ${r.imported}, duplicates ${r.duplicates}, errors ${r.errors.length}.`);
    for (const e of r.errors) ctx.io.err(`  ${e.file}: ${e.error}`);
    return r.errors.length ? 1 : 0;
  },
};

export const syncOnce: Command = {
  name: "sync:once",
  summary: "Run one full IMAP sync cycle for a mailbox (read-only)",
  options: { mailbox: { type: "string", required: true, arg: "<id|address>", description: "Mailbox" } },
  async run(ctx, args) {
    const rt = await ctx.runtime();
    const mb = await findMailbox(rt.db, args.req("mailbox"));
    if (mb.provider !== "imap") throw new UsageError("Only IMAP mailboxes sync");
    if (mb.status !== "active") throw new UsageError(`Mailbox status is ${mb.status}; fix it first (mailbox:add / mailbox:resume)`);
    rt.sealingKeys({ requirePrivate: true });
    const r = await ctx.services.syncMailboxOnce(rt.syncDeps, mb.id);
    ctx.io.out(
      `${r.ok ? "OK" : `FAILED (${r.errorKind ?? "error"})`}: folders ${r.foldersSynced}, new ${r.newMessages}, duplicates ${r.duplicates}, ` +
        `full cycle ${r.fullCycle ? "yes" : "no"}, ${Math.round((r.finishedAt.getTime() - r.startedAt.getTime()) / 1000)} s`,
    );
    return r.ok ? 0 : 1;
  },
};

/** Why the chosen provider cannot run (src/ai/resolve.ts), and the fix. */
function unavailableHint(provider: AiProvider, reason: string | null): string {
  const label = AI_PROVIDER_LABELS[provider];
  switch (reason) {
    case "key_unreadable":
      return `this process cannot decrypt the saved ${label} key (is CREDENTIALS_PRIVATE_KEY_FILE the worker's private key?).`;
    case "no_model":
      return `no ${label} model is chosen (Admin → AI).`;
    default:
      return `there is no ${label} key (add one in Admin → AI, or set ${AI_KEY_ENV[provider]} in the worker's environment).`;
  }
}

export const drainOnce: Command = {
  name: "drain:once",
  summary: "Analyse the mailbox queue now (extract → reconcile → apply), in order",
  options: {
    mailbox: { type: "string", required: true, arg: "<id|address>", description: "Mailbox" },
    max: { type: "number", description: "Stop after this many messages" },
    settle: { type: "boolean", default: true, description: "Honour the settle window (--no-settle for freshly imported fixtures)" },
    yes: yesOpt,
  },
  async run(ctx, args) {
    const rt = await ctx.runtime();
    const mb = await findMailbox(rt.db, args.req("mailbox"));
    // What Admin → AI chose (or AI_MODE and the environment): a real provider costs money.
    await rt.refreshAi();
    const ai = rt.ai;
    if (ai?.mode === "unavailable" && ai.provider) {
      // One drain would pause AI for every mailbox: refuse here, and say why.
      ctx.io.err(`AI cannot run: ${unavailableHint(ai.provider, ai.reason)} Nothing was analysed.`);
      return 1;
    }
    if (ai?.mode === "provider" && ai.provider && !args.bool("yes")) {
      const label = AI_PROVIDER_LABELS[ai.provider];
      if (!(await ctx.io.confirm(`This calls the ${label} API (${ai.model ?? "?"}) and costs money. Continue?`))) return 1;
    }
    const base = rt.pipelineDeps;
    const deps: PipelineDeps = args.bool("settle")
      ? base
      : {
          db: base.db,
          withLock: base.withLock,
          get extractor() {
            return base.extractor;
          },
          clock: base.clock,
          log: base.log,
          config: { ...base.config, SETTLE_SEC: 0 },
        };
    const max = args.num("max");
    if (max !== undefined && (!Number.isInteger(max) || max < 1)) throw new UsageError("--max must be a positive integer");
    // The operator ran sync/import just before: everything seen so far counts as a complete cycle.
    const r = await ctx.services.drainMailbox(deps, mb.id, { fullCycleAt: ctx.now(), ...(max !== undefined ? { maxMessages: max } : {}) });
    ctx.io.out(`Processed ${r.processed} (extracted ${r.extracted}, applied ${r.applied}, parked ${r.parked}).`);
    if (r.lockBusy) ctx.io.out("Another drain (the worker?) holds this mailbox's lock; try again later.");
    if (r.transientBackoff) ctx.io.out("Stopped: the head message is backing off after a transient error or still settling.");
    if (r.budgetPaused) ctx.io.out("Stopped: the mailbox's daily AI budget is reached (resets at local midnight).");
    if (r.globalPause) ctx.io.out("Stopped: AI is globally paused (see `pnpm cli ai:resume`).");
    return r.lockBusy || r.globalPause ? 1 : 0;
  },
};

export const aiCheck: Command = {
  name: "ai:check",
  summary: "Send one invented email through the AI in use (key, billing, model, schema) and show the answer; reads no mail, changes nothing",
  options: { yes: yesOpt, json: { type: "boolean", description: "Machine-readable output" } },
  async run(ctx, args) {
    const rt = await ctx.runtime();
    // What Admin → AI chose (or AI_MODE and the environment), as the worker would run it. Read-only here.
    await rt.refreshAi();
    const ai = rt.ai;
    if (ai?.mode === "unavailable" && ai.provider) {
      ctx.io.err(`AI cannot run: ${unavailableHint(ai.provider, ai.reason)}`);
      return 1;
    }
    const provider = ai?.mode === "provider" ? ai.provider : null;
    if (provider && !args.bool("yes")) {
      if (!(await ctx.io.confirm(`This makes one paid call to the ${AI_PROVIDER_LABELS[provider]} API (${ai?.model ?? "?"}), a few cents at most. Continue?`))) return 1;
    }
    const r = await probeExtractor(rt.extractor);
    if (args.bool("json")) {
      ctx.io.out(JSON.stringify(r, null, 2));
      return r.ok ? 0 : 1;
    }
    const secs = (r.latencyMs / 1000).toFixed(1);
    ctx.io.out(`AI check: ${r.extractor} · ${r.pipelineVersion}`);
    if (!r.ok) {
      ctx.io.out(`FAILED in ${secs} s: ${r.errorClass}: ${r.error}`);
      const advice = probeAdvice(r.error, provider);
      if (advice) ctx.io.out(`  ${advice}`);
      if (r.errorClass === "GLOBAL") ctx.io.out("  In the worker this error pauses AI for every mailbox, until a change is saved in Admin → AI or `pnpm cli ai:resume` is run.");
      return 1;
    }
    const u = r.usage;
    const tokens = u ? ` · tokens in ${u.inputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens}, out ${u.outputTokens}` : "";
    ctx.io.out(`OK in ${secs} s · model ${r.model ?? "?"}${tokens} · about $${r.costUsd.toFixed(4)}`);
    ctx.io.out(`Answer: ${r.messageClass} · ${r.operations.join(", ") || "no operations"}`);
    if (!provider) ctx.io.out("  NOTE: no AI provider is in use (the built-in rules answered). Choose one in Admin → AI to check it.");
    else if (!r.asExpected) ctx.io.out("  NOTE: the invented email asks for a quote by Friday; the expected answer is ACTIONABLE with one CREATE.");
    return 0;
  },
};

export const chatCheck: Command = {
  name: "chat:check",
  summary: "Ask one invented question through the configured chat model (key, billing, model, lookups, sources); invented mail in memory, no database",
  options: { yes: yesOpt, json: { type: "boolean", description: "Machine-readable output" } },
  async run(ctx, args) {
    const config = ctx.config();
    if (config.CHAT_MODE === "off") {
      ctx.io.err(`CHAT_MODE=off: there is no chat to check. Set CHAT_MODE=gemini with CHAT_MODEL and ${CHAT_KEY_ENV} (or CHAT_MODE=mock).`);
      return 1;
    }
    if (config.CHAT_MODE !== "mock" && !args.bool("yes")) {
      if (!(await ctx.io.confirm(`CHAT_MODE=${config.CHAT_MODE}: this makes a few paid API calls (about a cent together). Continue?`))) return 1;
    }
    // A missing key or model throws here, with the name of what is missing (never a value).
    const model = (ctx.services.createChatModel ?? createChatModel)(config);
    if (!model) return 1;
    const r = await (ctx.services.probeChat ?? probeChat)(model, { retentionDays: config.BODY_RETENTION_DAYS });
    if (args.bool("json")) {
      ctx.io.out(JSON.stringify(r, null, 2));
      return r.ok ? 0 : 1;
    }
    const secs = (r.latencyMs / 1000).toFixed(1);
    const spent = `${r.calls} ${r.calls === 1 ? "call" : "calls"}, ${r.lookups} ${r.lookups === 1 ? "lookup" : "lookups"} · tokens in ${r.inputTokens}, out ${r.outputTokens} · about $${r.costUsd.toFixed(4)}`;
    ctx.io.out(`Chat check: ${r.model} · prompt ${r.promptVersion}`);
    ctx.io.out(`Question: ${PROBE_QUESTION}`);
    for (const step of r.steps) ctx.io.out(`  ${step}`);
    if (!r.ok) {
      ctx.io.out(`FAILED in ${secs} s: ${r.outcome}${r.error ? `: ${r.error}` : ""} · ${spent}`);
      const advice = chatProbeAdvice(r);
      if (advice) ctx.io.out(`  ${advice}`);
      return 1;
    }
    ctx.io.out(`OK in ${secs} s · model ${r.answeredBy ?? "?"} · ${spent}`);
    ctx.io.out(`Answer: ${(r.answer ?? "").replace(/\s*\n\s*/g, " / ")}`);
    ctx.io.out(`Sources: ${r.sources.join(" | ") || "none"}`);
    if (!r.asExpected) ctx.io.out("  NOTE: the invented mailbox holds one request from George Placeholder (a quote for 4 ceiling speakers by Friday); the answer should name that message or its task as a source.");
    return 0;
  },
};

export const digestPreview: Command = {
  name: "digest:preview",
  summary: "Render a user's daily report to an HTML file without sending it",
  options: {
    user: { type: "string", required: true, arg: "<email|id>", description: "User" },
    date: { type: "string", arg: "<YYYY-MM-DD>", description: "Report date (default today in the org timezone)" },
    out: { type: "string", arg: "<file.html>", description: "Output file (default <DATA_DIR>/previews/digest-<date>.html)" },
  },
  async run(ctx, args) {
    const rt = await ctx.runtime();
    const user = await findUser(rt.db, args.req("user"));
    const date = args.str("date") ? assertIsoDate(args.str("date")!, "--date") : await userToday(ctx, user.orgId);
    const r = await ctx.services.deliverDigestForUser(rt.digestDeps, user.id, date, { dryRun: true });
    const file = args.str("out") ?? path.join(ctx.ops().DATA_DIR, "previews", `digest-${user.id.slice(0, 8)}-${date}.html`);
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, r.html, { mode: 0o600 });
    chmodSync(file, 0o600);
    ctx.io.out(`Preview (${r.status}) written to ${file} — it contains e-mail-derived text; delete it when done.`);
  },
};

export const digestSendNow: Command = {
  name: "digest:send-now",
  summary: "Deliver today's report now (exactly once per user and date — never a second copy)",
  options: {
    user: { type: "string", required: true, arg: "<email|id>", description: "User" },
    date: { type: "string", arg: "<YYYY-MM-DD>", description: "Report date (default today in the org timezone)" },
    retry: { type: "boolean", description: "Clear a skipped/failed (never delivered) report row first, so it can be sent" },
    yes: yesOpt,
  },
  async run(ctx, args) {
    const rt = await ctx.runtime();
    const user = await findUser(rt.db, args.req("user"));
    const date = args.str("date") ? assertIsoDate(args.str("date")!, "--date") : await userToday(ctx, user.orgId);
    const [row] = await rt.db.select().from(digests).where(and(eq(digests.userId, user.id), eq(digests.localDate, date)));
    if (row?.status === "delivered") {
      ctx.io.out(`The report for ${date} was already delivered${row.deliveredAt ? ` at ${row.deliveredAt.toISOString()}` : ""}; nothing to do.`);
      return 0;
    }
    const retryable = row?.status === "skipped" || row?.status === "failed";
    const unknown = row?.status === "failed" && row.lastError === SMTP_UNKNOWN;
    if (row) ctx.io.out(`A report row for ${date} exists with status "${row.status}"${row.lastError ? ` (${row.lastError})` : ""}${retryable && !args.bool("retry") ? " (use --retry to send it anyway)" : ""}.`);
    if (unknown) {
      ctx.io.out("Its SMTP submission was interrupted and may have been delivered. Check the user's inbox first: --retry sends it again.");
      if (!args.bool("retry")) return 1;
    }
    if (!args.bool("yes") && !(await ctx.io.confirm(`Deliver the ${date} report to user ${user.id} now?`))) return 1;
    rt.sealingKeys({ requirePrivate: true });
    if (row && retryable && args.bool("retry")) {
      // Only never-delivered rows; the dispatcher's claim (insert … on conflict do nothing) keeps delivery exactly-once.
      await rt.db.delete(digests).where(and(eq(digests.id, row.id), inArray(digests.status, ["skipped", "failed"])));
    }
    const r = await ctx.services.deliverDigestForUser(rt.digestDeps, user.id, date, {});
    ctx.io.out(`Result: ${r.status}`);
    if (r.status === "busy") ctx.io.err("The worker is delivering this report right now; it is not sent a second time. Check again in a few minutes.");
    return r.status === "delivered" || r.status === "already_delivered" ? 0 : 1;
  },
};

export const pipelineCommands: Command[] = [importEml, syncOnce, drainOnce, aiCheck, chatCheck, digestPreview, digestSendNow];

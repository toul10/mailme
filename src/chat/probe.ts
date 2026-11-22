/**
 * One invented question for checking the chat's model end to end (`pnpm cli chat:check`): the key, the billing
 * behind it, the model id, the thinking level, the step schema, and whether the model works the way the chat needs
 * it to — looks things up first, then answers and names its source. A wrong one of these fails every question of
 * every user: better found here, before a release.
 *
 * It runs the real engine (src/chat/engine.ts) over a mailbox that exists only in memory for the length of the
 * check (embedded Postgres, the real migrations), so it reads nobody's mail and needs no database. Nobody in it is
 * real (example.* addresses): a customer asked for a quote by Friday, and the question is what he asked for.
 */
import { probeAdvice } from "../ai/probe.js";
import { openDb, type Db } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import * as s from "../db/schema.js";
import { nullLogger } from "../lib/log.js";
import { foldForSearch } from "../lib/text.js";
import type { ChatEvent } from "../server/api-types.js";
import { newChatStats, runChat, type ChatStats } from "./engine.js";
import { CHAT_KEY_ENV, type ChatModel } from "./model.js";
import { CHAT_PROMPT_VERSION } from "./prompt.js";

export const PROBE_QUESTION = "What did George Placeholder ask me for?";
const ZONE = "Europe/Athens";
const OWNER = { name: "Maria Sample", address: "maria@example.com" };
/** The whole check may take this long (a question in the app has its own, shorter deadline). */
const PROBE_TIMEOUT_MS = 150_000;

export interface ChatProbeReport {
  /** An answer came back. */
  ok: boolean;
  /** The chat model as configured, e.g. "gemini:gemini-3.8-flash@low". */
  model: string;
  /** The model that answered, as the provider names it. */
  answeredBy: string | null;
  promptVersion: string;
  /** What was looked up, as the user would see it. */
  steps: string[];
  /** The answer (about the invented mailbox only). */
  answer: string | null;
  /** What the answer named: subjects of messages and titles of tasks. */
  sources: string[];
  /** The answer names the customer's message or the task made from it: the model found what was asked. */
  asExpected: boolean;
  outcome: ChatStats["outcome"];
  /** Status and code only, as the adapter reports it (never a provider message). */
  error: string | null;
  calls: number;
  lookups: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
}

/** The invented mailbox: one request with its task and the owner's reply, and one unrelated message. */
async function seed(db: Db, now: Date): Promise<{ userId: string; requestId: string; taskId: string }> {
  const ago = (days: number, hours = 0) => new Date(now.getTime() - days * 86_400_000 - hours * 3_600_000);
  const [org] = await db.insert(s.organizations).values({ name: "Example", internalDomains: ["example.com"], timezone: ZONE }).returning({ id: s.organizations.id });
  const [user] = await db.insert(s.users).values({ orgId: org!.id, name: OWNER.name, email: OWNER.address }).returning({ id: s.users.id });
  const [mailbox] = await db
    .insert(s.mailboxes)
    .values({ orgId: org!.id, userId: user!.id, address: OWNER.address, imapHost: "mail.example.com", imapUsername: OWNER.address, status: "active", backfillFrom: ago(60), liveSince: ago(30) })
    .returning({ id: s.mailboxes.id });
  const mailboxId = mailbox!.id;

  let n = 0;
  const message = async (m: { threadId: string; direction: "INBOUND" | "OUTBOUND"; from: string; fromName: string; to: string; subject: string; text: string; at: Date }): Promise<string> => {
    const key = `chat-check-${++n}@example.invalid`;
    const [row] = await db
      .insert(s.messages)
      .values({
        mailboxId,
        threadId: m.threadId,
        messageKey: key,
        messageIdHeader: key,
        direction: m.direction,
        fromAddress: m.from,
        fromName: m.fromName,
        to: [{ address: m.to, name: null }],
        cc: [],
        subject: m.subject,
        subjectNorm: foldForSearch(m.subject),
        sortTs: m.at,
        dateHeader: m.at,
        internalDate: m.at,
        firstSeenAt: m.at,
        inReplyTo: null,
        references: [],
        segments: [{ id: "S1", kind: "NEW", text: m.text, author: null, date: null, truncated: false }],
        attachments: [],
        textPlain: m.text,
        state: "applied",
      })
      .returning({ id: s.messages.id });
    return row!.id;
  };
  const thread = async (subject: string): Promise<string> => {
    const [row] = await db.insert(s.threads).values({ mailboxId, subjectNorm: foldForSearch(subject) }).returning({ id: s.threads.id });
    return row!.id;
  };

  const quote = await thread("Quote for speakers");
  const requestId = await message({
    threadId: quote,
    direction: "INBOUND",
    from: "george@example.org",
    fromName: "George Placeholder",
    to: OWNER.address,
    subject: "Quote for speakers",
    text: "Good morning,\n\ncould you please send us a quote for 4 ceiling speakers and one amplifier by Friday?\n\nThank you,\nGeorge Placeholder\nPlaceholder Ltd",
    at: ago(2, 3),
  });
  await message({
    threadId: quote,
    direction: "OUTBOUND",
    from: OWNER.address,
    fromName: OWNER.name,
    to: "george@example.org",
    subject: "Re: Quote for speakers",
    text: "Good morning Mr Placeholder, I will send it to you tomorrow.\n\nMaria",
    at: ago(2, 1),
  });
  await message({
    threadId: await thread("Warehouse hours"),
    direction: "INBOUND",
    from: "helen@example.net",
    fromName: "Helen Specimen",
    to: OWNER.address,
    subject: "Warehouse hours",
    text: "Good afternoon, from Monday the warehouse takes deliveries from 08:00 to 15:00.",
    at: ago(1, 4),
  });

  const title = "Quote for 4 ceiling speakers and an amplifier";
  const [task] = await db
    .insert(s.tasks)
    .values({
      orgId: org!.id,
      userId: user!.id,
      mailboxId,
      ref: 1,
      title,
      status: "ACTION_REQUIRED",
      counterpartyAddress: "george@example.org",
      company: "Placeholder Ltd",
      companyDomain: "example.org",
      origin: "ai",
      originMessageId: requestId,
      searchText: foldForSearch(`${title} Placeholder Ltd george@example.org George Placeholder`),
    })
    .returning({ id: s.tasks.id });
  await db.insert(s.taskLinks).values({ taskId: task!.id, threadId: quote, messageId: requestId, role: "origin" });
  return { userId: user!.id, requestId, taskId: task!.id };
}

/**
 * Asks {@link PROBE_QUESTION} of the invented mailbox with `model`. Never throws for a model failure: the report
 * carries it.
 */
export async function probeChat(model: ChatModel, opts: { retentionDays?: number; now?: Date; timeoutMs?: number } = {}): Promise<ChatProbeReport> {
  const started = performance.now();
  const now = opts.now ?? new Date();
  let error: string | null = null;
  let answeredBy: string | null = null;
  // The engine tells the user a sentence and the log a tag; the check wants the tag.
  const watched: ChatModel = {
    name: model.name,
    id: model.id,
    async complete(call) {
      const r = await model.complete(call);
      if (!r.ok) error = r.error;
      answeredBy = r.model ?? answeredBy;
      return r;
    },
  };

  const handle = await openDb("pglite://memory");
  const stats = newChatStats(model);
  const events: ChatEvent[] = [];
  let seeded: { userId: string; requestId: string; taskId: string };
  try {
    await runMigrations(handle);
    seeded = await seed(handle.db, now);
    const deps = { db: handle.db, clock: { now: () => now }, log: nullLogger, model: watched, retentionDays: opts.retentionDays ?? 90 };
    const signal = AbortSignal.timeout(opts.timeoutMs ?? PROBE_TIMEOUT_MS);
    for await (const e of runChat(deps, { userId: seeded.userId, zone: ZONE, question: PROBE_QUESTION, history: [] }, stats, signal)) events.push(e);
  } finally {
    await handle.close();
  }

  const answer = events.find((e) => e.type === "answer");
  const sources = answer?.sources ?? [];
  return {
    ok: answer !== undefined,
    model: model.id,
    answeredBy,
    promptVersion: CHAT_PROMPT_VERSION,
    steps: events.filter((e) => e.type === "step").map((e) => e.label),
    answer: answer?.answer ?? null,
    sources: sources.map((x) => (x.kind === "mail" ? x.subject : `#${x.ref} ${x.title}`)),
    asExpected: sources.some((x) => (x.kind === "mail" ? x.messageId === seeded.requestId : x.taskId === seeded.taskId)),
    outcome: stats.outcome,
    // "aborted" here can only be the check's own time limit.
    error: answer ? null : stats.outcome === "aborted" ? "timeout" : error,
    calls: stats.calls,
    lookups: stats.lookups,
    inputTokens: stats.inputTokens + stats.cachedTokens,
    outputTokens: stats.outputTokens,
    costUsd: stats.costUsd,
    latencyMs: Math.round(performance.now() - started),
  };
}

/** What an operator should do about a failed check. Null: no specific advice. */
export function chatProbeAdvice(r: Pick<ChatProbeReport, "outcome" | "error">): string | null {
  const e = r.error ?? "";
  if (/^http_402\b/.test(e)) return "The prepaid credits of the Gemini billing account are used up: buy credits in AI Studio (Billing).";
  if (/API_KEY_|^http_401\b/.test(e)) return `Gemini refuses the API key: check ${CHAT_KEY_ENV} in the API's environment (the right key, not restricted or deleted).`;
  if (/^http_404\b/.test(e)) return "The API does not know this model id: check CHAT_MODEL against the models of your key.";
  if (/^max_tokens|^finish:MAX_TOKENS/.test(e)) return "The answer did not fit in CHAT_MAX_TOKENS (thinking counts too): lower CHAT_THINKING_LEVEL or raise CHAT_MAX_TOKENS.";
  if (e === "timeout") return "No answer in time: the model is too slow for a chat at this thinking level. Try CHAT_THINKING_LEVEL=low.";
  if (r.outcome === "error:bad_output") return "The model answered, but not with a usable step (twice): this model does not follow the chat's JSON shape reliably.";
  return probeAdvice(r.error, "gemini");
}

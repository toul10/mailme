/**
 * One chat question, from the text to the answer: the model asks for lookups in the user's own mail and tasks, this
 * runs them, and after a few rounds the model answers with the handles of what it relied on.
 *
 * What bounds a question: CHAT_LIMITS (rounds, lookups per round, sizes), the caller's abort signal (the reader went
 * away, or the question's time is up), and the model's own failures. Whatever happens, `stats` says what was spent:
 * the caller records it (src/chat/usage.ts) and it is what the daily limits count.
 *
 * Nothing is written and nothing is kept: the lookups only read — each one runs in a read-only transaction with a
 * time limit of its own — and the conversation lives in the browser.
 */
import { sql } from "drizzle-orm";
import type { Db, DbOrTx } from "../db/client.js";
import type { Clock, Logger } from "../domain/types.js";
import { EN_MONTHS_SHORT } from "../lib/dates.js";
import { truncate } from "../lib/text.js";
import { errorCode } from "../ops/alerts.js";
import type { ChatErrorCode, ChatEvent, ChatMailSource, ChatSource, ChatTurn } from "../server/api-types.js";
import type { ChatFailure, ChatModel } from "./model.js";
import {
  ANSWER_NOW,
  CHAT_LIMITS,
  chatStepSchema,
  contextBlock,
  earlierBlock,
  lookupTitle,
  NEXT_STEP,
  parseStep,
  questionBlock,
  roundBlock,
  systemPrompt,
  TRY_AGAIN,
  type EarlierTurn,
  type Lookup,
} from "./prompt.js";
import { citedHandles, MAIL_HANDLE_RE, renderEarlierSource, renderMailSearch, renderTask, renderTaskSearch, renderThread, SourceRegistry, TASK_HANDLE_RE } from "./render.js";
import { loadChatScope, loadRecords, localDayStart, notAnalysed, ownText, readThread, searchMail, searchTasks, taskByRef, taskMessageIds, tasksByIds, type ChatScope, type MailRecord } from "./search.js";

export interface ChatDeps {
  db: DbOrTx;
  clock: Clock;
  log: Logger;
  model: ChatModel;
  /** BODY_RETENTION_DAYS: how long message text is kept (the model tells the user when that matters). */
  retentionDays: number;
  /** DENY_LIST of the install: mail to or from these addresses and domains is private and never read. */
  denyList?: readonly string[];
  /** How long one lookup may run in the database (default LOOKUP_TIMEOUT_MS). */
  lookupTimeoutMs?: number;
}

export interface ChatInput {
  userId: string;
  zone: string;
  question: string;
  history: readonly ChatTurn[];
  /** The per-mailbox view: one of the user's own mailboxes to ask about (anything else ends the question, reading nothing). */
  mailboxId?: string | null;
}

/** What one question cost and how it ended. Counts and codes only: never the question or anything that was read. */
export interface ChatStats {
  model: string;
  calls: number;
  rounds: number;
  lookups: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number;
  sources: number;
  outcome: "running" | "answer" | "aborted" | `error:${ChatFailure | "scope" | "internal"}`;
}

export const newChatStats = (model: ChatModel): ChatStats => ({ model: model.id, calls: 0, rounds: 0, lookups: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0, sources: 0, outcome: "running" });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Earlier sources read again per question (handles of an earlier answer stay usable for a follow-up). */
const EARLIER_SOURCES_MAX = 40;
const SEARCH_HITS = 8;
const TASK_HITS = 12;
const EXCERPT_CHARS = 280;
/**
 * One lookup in the database. The searches read text, not an index: on a large mailbox and a small database one
 * can take seconds, and neither the reader's stop nor the question's deadline can end a query that is under way.
 */
export const LOOKUP_TIMEOUT_MS = 10_000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const TOO_SLOW = "This lookup took too long and was stopped. Narrow it: one or two distinctive words, a person, or a range of days.";

/** Postgres ended the statement for its time limit (57014, query_canceled). */
const isStatementTimeout = (err: unknown): boolean => errorCode(err) === "57014";

/**
 * Runs `fn` in a transaction that can only read and whose statements are ended after `timeoutMs`. Read-only is
 * defence in depth: no lookup writes, and here the database itself would refuse one.
 */
export function readOnly<T>(db: DbOrTx, timeoutMs: number, fn: (tx: DbOrTx) => Promise<T>): Promise<T> {
  return (db as Db).transaction(
    async (tx) => {
      await tx.execute(sql`select set_config('statement_timeout', ${String(Math.max(1, Math.round(timeoutMs)))}, true)`);
      return fn(tx);
    },
    { accessMode: "read only" },
  );
}

const FAILURE_TEXT: Record<Exclude<ChatFailure, "aborted">, { code: ChatErrorCode; message: string }> = {
  no_credit: { code: "ai_unavailable", message: "The AI isn't available right now. Tell your administrator." },
  unavailable: { code: "ai_unavailable", message: "The AI didn't answer. Try again in a moment." },
  config: { code: "ai_unavailable", message: "The chat isn't set up correctly. Tell your administrator." },
  blocked: { code: "no_answer", message: "No answer came out for this question. Try wording it differently." },
  too_long: { code: "no_answer", message: "This conversation has grown too long. Start a new one and ask again." },
  bad_output: { code: "no_answer", message: "I couldn't work out an answer. Try asking it another way." },
};
const INTERNAL_ERROR = "Something went wrong. Try again.";

/** The newest earlier turns that fit, oldest first, each cut to a size that keeps a long conversation affordable. */
export function trimHistory(history: readonly ChatTurn[]): ChatTurn[] {
  const out: ChatTurn[] = [];
  let chars = 0;
  for (const t of history.slice(-CHAT_LIMITS.historyTurns).reverse()) {
    const turn: ChatTurn = {
      question: truncate(t.question.trim(), CHAT_LIMITS.questionChars).text,
      answer: truncate(t.answer.trim(), 4000).text,
      draft: t.draft?.trim() ? truncate(t.draft.trim(), 2000).text : null,
      sources: t.sources,
    };
    const size = turn.question.length + turn.answer.length + (turn.draft?.length ?? 0);
    if (out.length && chars + size > CHAT_LIMITS.historyChars) break;
    chars += size;
    out.unshift(turn);
  }
  return out;
}

function mailSource(handle: string, r: MailRecord): ChatMailSource {
  const task = r.tasks[0];
  return {
    kind: "mail",
    handle,
    messageId: r.id,
    date: r.date.toISOString(),
    fromName: r.fromName,
    fromAddress: r.fromAddress,
    own: r.own,
    unverified: r.unverified,
    subject: r.subject,
    excerpt: truncate(ownText(r.segments), EXCERPT_CHARS).text,
    attachments: r.attachments,
    task: task ? { id: task.id, ref: task.ref } : null,
  };
}

const bare = (handle: string): string => handle.trim().replace(/^\[|\]$/g, "").trim();
/** "2026-09-08" → "8 Sep". */
const shortDay = (iso: string): string => `${Number(iso.slice(8, 10))} ${EN_MONTHS_SHORT[Number(iso.slice(5, 7)) - 1] ?? iso.slice(5, 7)}`;

/** What the user sees while a lookup runs. Their own words and their own mail's subjects: shown to them only. */
export function stepLabel(l: Lookup, registry: SourceRegistry): string {
  const words = [...l.allOf, ...l.anyOf].map((w) => w.trim()).filter(Boolean).slice(0, 5).join(", ");
  if (l.tool === "search_tasks") return words ? `Looking at your tasks: “${truncate(words, 80).text}”` : "Looking at your tasks";
  if (l.tool === "read_thread") {
    const h = bare(l.handle);
    const mail = registry.mail(h);
    if (mail) return `Reading the conversation “${truncate(mail.subject || "no subject", 70).text}”`;
    return TASK_HANDLE_RE.test(h) ? `Reading the mail of task ${h}` : "Reading a conversation";
  }
  const bits = [
    words ? `“${truncate(words, 80).text}”` : null,
    l.person ? `with ${truncate(l.person, 40).text}` : null,
    ISO_DAY.test(l.after) ? `from ${shortDay(l.after)}` : null,
    ISO_DAY.test(l.before) ? `until ${shortDay(l.before)}` : null,
    l.sender === "me" ? "sent by you" : null,
  ].filter(Boolean);
  return bits.length ? `Searching your mail: ${bits.join(" · ")}` : "Looking at your most recent mail";
}

/** Why a lookup cannot run as written, in words for the model; null when it can. */
function refusal(scope: ChatScope, l: Lookup): string | null {
  if (l.tool !== "search_mail") return null;
  const from = l.after ? localDayStart(l.after, scope.zone) : null;
  const to = l.before ? localDayStart(l.before, scope.zone) : null;
  const wrong = [l.after && !from ? '"after"' : null, l.before && !to ? '"before"' : null].filter(Boolean);
  // A day that is not a day would search all time, and the result would read as if the limit had been applied.
  if (wrong.length) return `Not searched: ${wrong.join(" and ")} must be a real day written as YYYY-MM-DD, or "" for no limit. Correct it and search again.`;
  if (from && to && from.getTime() > to.getTime()) return 'Not searched: "after" is a later day than "before". Correct the days and search again.';
  return null;
}

async function runLookup(db: DbOrTx, scope: ChatScope, registry: SourceRegistry, l: Lookup): Promise<string> {
  if (l.tool === "search_mail") {
    const res = await searchMail(db, scope, { allOf: l.allOf, anyOf: l.anyOf, person: l.person || null, after: l.after || null, before: l.before || null, sender: l.sender, limit: SEARCH_HITS });
    return renderMailSearch(scope, res, registry);
  }
  if (l.tool === "search_tasks") {
    const res = await searchTasks(db, scope, { allOf: l.allOf, anyOf: l.anyOf, status: l.status, limit: TASK_HITS });
    const origins = await loadRecords(db, scope, res.hits.map((t) => t.originMessageId).filter((id): id is string => !!id));
    return renderTaskSearch(scope, res, registry, new Map(origins.map((r) => [r.id, registry.addMail(r)])));
  }
  const handle = bare(l.handle);
  const known = registry.mail(handle);
  if (known) {
    const view = await readThread(db, scope, known.id);
    return view ? renderThread(scope, view, registry) : "This message can no longer be read.";
  }
  if (TASK_HANDLE_RE.test(handle)) {
    const task = await taskByRef(db, scope, Number(handle.slice(1)));
    if (!task) return "There is no task with this number.";
    const linked = await taskMessageIds(db, scope, task.id);
    const anchorId = task.originMessageId && linked.includes(task.originMessageId) ? task.originMessageId : (linked.at(-1) ?? task.originMessageId);
    const view = anchorId ? await readThread(db, scope, anchorId) : null;
    const card = renderTask(scope, task, registry, view ? registry.addMail(view.messages.find((m) => m.id === anchorId) ?? view.messages[0]!) : null);
    return view ? `${card}\n${renderThread(scope, view, registry)}` : `${card}\nNo mail of this task can be read (it was entered by hand, or its mail is no longer kept).`;
  }
  return MAIL_HANDLE_RE.test(handle)
    ? "This handle did not appear in the lookup results of this conversation. Search for the message again."
    : "Not a handle. Use one exactly as it appears in the lookup results: M… for a message, #… for a task.";
}

/**
 * Runs one question. Yields what the user should see as it happens; the last event is the answer or an error,
 * except when `signal` fired (the caller knows why and says so itself). `stats` is filled in as it goes.
 */
export async function* runChat(deps: ChatDeps, input: ChatInput, stats: ChatStats, signal: AbortSignal): AsyncGenerator<ChatEvent, void, void> {
  const { db, model, log } = deps;
  const timeoutMs = deps.lookupTimeoutMs ?? LOOKUP_TIMEOUT_MS;
  const turns = trimHistory(input.history);
  const earlierIds = (kind: "mail" | "task"): string[] => [...new Set(turns.flatMap((t) => t.sources.filter((s) => s.kind === kind && UUID_RE.test(s.id)).map((s) => s.id.toLowerCase())))].slice(-EARLIER_SOURCES_MAX);
  // Who asks, and the sources of the earlier turns read again from the database: what the browser sent is only a
  // list of ids, and an id that is not this user's to read finds nothing.
  const start = await readOnly(db, timeoutMs, async (tx) => {
    const scope = await loadChatScope(tx, input.userId, input.zone, deps.clock.now(), { denyList: deps.denyList ?? [], mailboxId: input.mailboxId ?? null });
    if (!scope) return null;
    return { scope, earlierMail: await loadRecords(tx, scope, earlierIds("mail")), earlierTasks: await tasksByIds(tx, scope, earlierIds("task")), unread: await notAnalysed(tx, scope) };
  });
  if (!start) {
    stats.outcome = "error:scope";
    yield { type: "error", code: "internal", message: INTERNAL_ERROR };
    return;
  }
  const { scope, earlierMail, earlierTasks, unread } = start;
  const registry = new SourceRegistry();

  // Every source is registered (its handle stays usable); the lines that name them are kept while they fit, the
  // newest first.
  const allLines = [...earlierMail.map((mail) => renderEarlierSource(scope, registry, { mail })), ...earlierTasks.map((task) => renderEarlierSource(scope, registry, { task }))];
  const sourceLines: string[] = [];
  let lineRoom: number = CHAT_LIMITS.earlierSourceChars;
  for (const line of [...allLines].reverse()) {
    if (line.length > lineRoom) break;
    lineRoom -= line.length;
    sourceLines.unshift(line);
  }
  const earlier: EarlierTurn[] = turns.map((t) => ({ question: t.question, answer: t.answer, draft: t.draft }));

  const system = systemPrompt({ retentionDays: deps.retentionDays });
  const schema = chatStepSchema();
  let transcript = [contextBlock(scope, unread), earlierBlock(earlier, sourceLines), questionBlock(truncate(input.question.trim(), CHAT_LIMITS.questionChars).text)].filter(Boolean).join("\n\n");
  let retry = false;

  for (;;) {
    if (signal.aborted) {
      stats.outcome = "aborted";
      return;
    }
    const final = stats.rounds >= CHAT_LIMITS.rounds || transcript.length >= CHAT_LIMITS.transcriptChars;
    const user = `${transcript}\n\n${retry ? `${TRY_AGAIN}\n` : ""}${final ? ANSWER_NOW : NEXT_STEP}`;
    const res = await model.complete({ system, user, schema, signal });
    stats.calls++;
    stats.costUsd = Math.round((stats.costUsd + res.costUsd) * 1e8) / 1e8;
    if (res.usage) {
      stats.inputTokens += res.usage.inputTokens;
      stats.outputTokens += res.usage.outputTokens;
      stats.cachedTokens += res.usage.cacheReadInputTokens;
    }
    if (!res.ok) {
      if (res.kind === "aborted" || signal.aborted) {
        stats.outcome = "aborted";
        return;
      }
      stats.outcome = `error:${res.kind}`;
      // The tag only (status and code): enough to tell an empty balance from a refused key.
      (res.kind === "config" || res.kind === "no_credit" ? log.error : log.warn).call(log, { code: res.error, kind: res.kind, model: model.id }, "chat: the model call failed");
      yield { type: "error", ...FAILURE_TEXT[res.kind] };
      return;
    }

    const step = parseStep(res.text);
    const lookups = step && !final ? step.lookups.slice(0, CHAT_LIMITS.lookupsPerRound) : [];
    if (!step || (!lookups.length && !step.answer)) {
      if (!retry) {
        retry = true;
        continue;
      }
      stats.outcome = "error:bad_output";
      log.warn({ model: model.id, calls: stats.calls }, "chat: no usable step from the model");
      yield { type: "error", ...FAILURE_TEXT.bad_output };
      return;
    }
    retry = false;

    if (lookups.length) {
      stats.rounds++;
      const results: Array<{ title: string; body: string }> = [];
      let room = Math.min(CHAT_LIMITS.roundChars, Math.max(0, CHAT_LIMITS.transcriptChars - transcript.length));
      for (const l of lookups) {
        if (signal.aborted) {
          stats.outcome = "aborted";
          return;
        }
        // A lookup that cannot run as written is answered at once, and the reader is not told of a search that
        // never happened.
        const refused = refusal(scope, l);
        if (!refused) yield { type: "step", label: stepLabel(l, registry) };
        stats.lookups++;
        let full = refused ?? "";
        if (room > 0 && !refused) {
          try {
            full = await readOnly(db, timeoutMs, (tx) => runLookup(tx, scope, registry, l));
          } catch (err) {
            if (!isStatementTimeout(err)) throw err;
            // The model is told, and can ask for less; the question goes on.
            log.warn({ tool: l.tool }, "chat: a lookup ran out of time");
            full = TOO_SLOW;
          }
        }
        const body = room <= 0 ? "Left out: no room is left for more results. Answer with what you have." : full.length > room ? `${full.slice(0, room)}\n(cut: the results did not fit)` : full;
        room -= body.length;
        results.push({ title: lookupTitle(l), body });
      }
      transcript += `\n\n${roundBlock(stats.rounds, results)}`;
      continue;
    }

    // The answer: its handles become sources only when a lookup of this conversation returned them.
    const sources: ChatSource[] = [];
    for (const handle of citedHandles(step.answer, step.sources)) {
      if (sources.length >= CHAT_LIMITS.answerSources) break;
      const mail = registry.mail(handle);
      if (mail) sources.push(mailSource(handle, mail));
      const task = mail ? null : registry.task(handle);
      if (task) sources.push({ kind: "task", handle, taskId: task.id, ref: task.ref, title: task.title, status: task.status });
    }
    stats.sources = sources.length;
    stats.outcome = "answer";
    yield { type: "answer", answer: step.answer, draft: step.draft || null, sources };
    return;
  }
}

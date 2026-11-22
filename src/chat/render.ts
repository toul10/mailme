/**
 * How lookup results reach the chat model (src/chat/engine.ts): data blocks with short handles, and the registry
 * that turns a handle in the answer back into the message or task it names.
 *
 * A message's handle is "M" + the first hex digits of its id (M3fa9c1): the same message has the same handle in
 * every turn of a conversation, with nothing stored on the server. A task's handle is its number as the user knows
 * it (#184). The model can name only what a lookup of this conversation returned.
 */
import { DateTime } from "luxon";
import { escapeAttr, escapeText } from "../ai/prompt.js";
import type { Address } from "../domain/types.js";
import { OPEN_STATUSES } from "../domain/types.js";
import { ownText, type ChatScope, type MailRecord, type MailSearchResult, type TaskRecord, type TaskRef, type TaskSearchResult, type ThreadView } from "./search.js";

// ── Handles ─────────────────────────────────────────────────────────────────

export const MAIL_HANDLE_RE = /^M[0-9a-f]{6,32}$/;
export const TASK_HANDLE_RE = /^#(\d{1,9})$/;
/** A handle inside the answer text: [M3fa9c1], [#184], or several in one pair of brackets. */
export const CITATION_RE = /\[((?:M[0-9a-f]{6,32}|#\d{1,9})(?:\s*[,;]\s*(?:M[0-9a-f]{6,32}|#\d{1,9}))*)\]/g;

const HANDLE_MIN_HEX = 6;

export class SourceRegistry {
  private readonly mailByHandle = new Map<string, MailRecord>();
  private readonly handleByMailId = new Map<string, string>();
  private readonly taskByRef = new Map<number, TaskRef>();

  /** Registers a message and returns its handle (the same one every time for the same message). */
  addMail(record: MailRecord): string {
    const known = this.handleByMailId.get(record.id);
    if (known) {
      this.mailByHandle.set(known, record);
      return known;
    }
    const hex = record.id.replace(/-/g, "").toLowerCase();
    for (let n = HANDLE_MIN_HEX; n <= hex.length; n += 2) {
      const handle = `M${hex.slice(0, n)}`;
      const holder = this.mailByHandle.get(handle);
      if (holder && holder.id !== record.id) continue;
      this.mailByHandle.set(handle, record);
      this.handleByMailId.set(record.id, handle);
      return handle;
    }
    throw new Error("chat: no free handle"); // two different ids cannot share all 32 digits
  }

  addTask(task: TaskRef): string {
    this.taskByRef.set(task.ref, task);
    return `#${task.ref}`;
  }

  mail(handle: string): MailRecord | null {
    return this.mailByHandle.get(handle.trim()) ?? null;
  }

  task(handle: string): TaskRef | null {
    const m = TASK_HANDLE_RE.exec(handle.trim());
    return m ? (this.taskByRef.get(Number(m[1])) ?? null) : null;
  }

  handleOfMail(id: string): string | null {
    return this.handleByMailId.get(id) ?? null;
  }
}

/** The handles an answer cites, in order of first appearance (from its text, then from the model's own list). */
export function citedHandles(answer: string, listed: readonly string[]): string[] {
  const out: string[] = [];
  const add = (h: string) => {
    const t = h.trim();
    if ((MAIL_HANDLE_RE.test(t) || TASK_HANDLE_RE.test(t)) && !out.includes(t)) out.push(t);
  };
  for (const m of answer.matchAll(CITATION_RE)) for (const h of m[1]!.split(/[,;]/)) add(h);
  for (const h of listed) add(h.replace(/^\[|\]$/g, ""));
  return out;
}

// ── Rendering ───────────────────────────────────────────────────────────────

export const RENDER_LIMITS = {
  /** Text of one message in a conversation view. */
  messageChars: 3200,
  /** All message text of one conversation view; the newest messages get their share first. */
  threadChars: 16_000,
  /** What an old message shows when the conversation's budget is used up. */
  leftoverChars: 240,
  /** Quoted older mail, shown only for the oldest message (it may be the only trace of what came before). */
  quotedChars: 1500,
  summaryChars: 700,
  /** A subject line: the sender writes it, and nothing says it is short. */
  subjectChars: 300,
} as const;

function attrs(pairs: Array<[string, string | number | boolean | null | undefined]>): string {
  return pairs
    .filter(([, v]) => v !== null && v !== undefined && v !== "" && v !== false)
    .map(([k, v]) => ` ${k}="${escapeAttr(String(v))}"`)
    .join("");
}

const stamp = (d: Date, zone: string): string => DateTime.fromJSDate(d, { zone }).setLocale("en").toFormat("yyyy-LL-dd HH:mm ccc");
const day = (d: Date, zone: string): string => DateTime.fromJSDate(d, { zone }).toFormat("yyyy-LL-dd");

function person(name: string | null, address: string | null): string {
  const n = (name ?? "").trim().replace(/^['"]+|['"]+$/g, "");
  if (n && address && n.toLowerCase() !== address.toLowerCase()) return `${n} <${address}>`;
  return address ?? n;
}

function people(list: readonly Address[], max = 6): string {
  const shown = list.slice(0, max).map((a) => person(a.name, a.address));
  return list.length > max ? `${shown.join(", ")} +${list.length - max}` : shown.join(", ");
}

/**
 * Who wrote it, as far as the address says. "(unverified)": it names the user or the organization as its sender,
 * and the mail server's checks show that sender was not authenticated.
 */
function writer(r: MailRecord): string {
  const who = r.own ? "me" : r.internal ? "colleague" : "external";
  return r.unverified ? `${who} (unverified)` : who;
}

const FILTER_NOTES: Record<string, string> = {
  BULK: "bulk mail (newsletter or notification)",
  NOREPLY: "automatic mail from a no-reply address",
  BOUNCE: "delivery failure notice",
  OUT_OF_OFFICE: "automatic out-of-office reply",
  CALENDAR_REPLY: "calendar reply",
  RULE: "set aside by one of the user's own mail rules",
  TOO_OLD: "older than the period MailMe analysed",
  EMPTY: "no text",
  ENCRYPTED: "encrypted: the text cannot be read",
};

function taskList(tasks: readonly TaskRef[], registry: SourceRegistry, max = 3): string {
  return tasks
    .slice(0, max)
    .map((t) => `${registry.addTask(t)} (${(OPEN_STATUSES as readonly string[]).includes(t.status) ? "open" : "closed"})`)
    .join(", ");
}

function mailAttrs(scope: ChatScope, r: MailRecord, registry: SourceRegistry, extra: Array<[string, string | number | boolean | null | undefined]> = []): string {
  return attrs([
    ["handle", registry.addMail(r)],
    ["date", stamp(r.date, scope.zone)],
    ["by", writer(r)],
    ["from", person(r.fromName, r.fromAddress)],
    ["to", people(r.to)],
    ["cc", people(r.cc, 4)],
    ["subject", subjectOf(r)],
    ["attachments", r.attachments.slice(0, 8).join(", ")],
    ["tasks", taskList(r.tasks, registry)],
    ["note", r.filterReason ? (FILTER_NOTES[r.filterReason] ?? null) : null],
    ["text", r.textKept ? null : "not kept"],
    ...extra,
  ]);
}

function clip(text: string, max: number): { text: string; cut: boolean } {
  if (text.length <= max) return { text, cut: false };
  return { text: `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`, cut: true };
}

const subjectOf = (r: MailRecord): string => (r.subject ? clip(r.subject, RENDER_LIMITS.subjectChars).text : "(no subject)");

/** One search hit: its facts and a snippet. */
function renderHit(scope: ChatScope, hit: MailRecord & { snippet: string }, registry: SourceRegistry): string {
  const open = `<mail${mailAttrs(scope, hit, registry, [["conversation_messages", hit.threadSize > 1 ? hit.threadSize : null]])}>`;
  return hit.snippet ? `${open}\n${escapeText(hit.snippet)}\n</mail>` : `${open}</mail>`;
}

export function renderMailSearch(scope: ChatScope, res: MailSearchResult, registry: SourceRegistry): string {
  if (!res.hits.length) return "No message matched.";
  const head = res.total > res.hits.length ? `${res.total} messages matched; the ${res.hits.length} newest:` : `${res.hits.length} ${res.hits.length === 1 ? "message" : "messages"} matched:`;
  return [head, ...res.hits.map((h) => renderHit(scope, h, registry))].join("\n");
}

/** One message of a conversation view, with as much of its own text as `budget` allows. */
function renderFull(scope: ChatScope, r: MailRecord, registry: SourceRegistry, budget: number, withQuoted: boolean): string {
  const hadQuoted = r.segments.some((s) => s.kind === "QUOTED" && s.text.trim());
  const body: string[] = [];
  let left = Math.max(0, budget);
  let cut = false;
  if (r.textKept) {
    for (const s of r.segments) {
      const text = s.text.trim();
      if (!text || s.kind === "QUOTED") continue;
      if (left <= 0) {
        cut = true;
        break;
      }
      const c = clip(text, left);
      cut ||= c.cut || s.truncated;
      left -= c.text.length;
      // A forwarded message keeps its own frame: who wrote it and when is not the forwarder.
      body.push(s.kind === "FORWARDED" ? `<forwarded${attrs([["author", s.author], ["date", s.date]])}>\n${escapeText(c.text)}\n</forwarded>` : escapeText(c.text));
    }
    if (withQuoted && hadQuoted) {
      const quoted = clip(r.segments.filter((s) => s.kind === "QUOTED").map((s) => s.text.trim()).filter(Boolean).join("\n\n"), RENDER_LIMITS.quotedChars);
      body.push(`<quoted>\n${escapeText(quoted.text)}\n</quoted>`);
    }
  }
  const open = `<mail${mailAttrs(scope, r, registry, [["text_cut", cut ? "true" : null], ["quoted_older_mail", hadQuoted && !withQuoted ? "left out" : null]])}>`;
  return body.length ? [open, ...body, "</mail>"].join("\n") : `${open}</mail>`;
}

export function renderThread(scope: ChatScope, view: ThreadView, registry: SourceRegistry): string {
  // Newest first for the budget, oldest first on the page.
  const share = new Map<string, number>();
  let left: number = RENDER_LIMITS.threadChars;
  for (const r of [...view.messages].reverse()) {
    const want = Math.min(RENDER_LIMITS.messageChars, ownText(r.segments).length);
    const give = left >= want ? want : left > RENDER_LIMITS.leftoverChars ? left : Math.min(RENDER_LIMITS.leftoverChars, want);
    share.set(r.id, give);
    left = Math.max(0, left - give);
  }
  const parts: string[] = [];
  const tasks = taskList(view.tasks, registry, 6);
  parts.push(`Conversation of ${view.messages.length} ${view.messages.length === 1 ? "message" : "messages"}, oldest first${view.omitted ? ` (${view.omitted} older ones are not shown)` : ""}${tasks ? `. Tasks made from it: ${tasks}` : ""}.`);
  view.messages.forEach((r, i) => parts.push(renderFull(scope, r, registry, share.get(r.id) ?? 0, i === 0)));
  return parts.join("\n");
}

const STATUS_NOTES: Record<string, string> = {
  ACTION_REQUIRED: "open: someone asked the user for this",
  WAITING_FOR_ME: "open: the user promised this",
  WAITING_FOR_OTHER: "open: the user waits for someone else",
  COMPLETED: "closed: done",
  DISMISSED: "closed: dismissed",
};

export function renderTask(scope: ChatScope, t: TaskRecord, registry: SourceRegistry, originHandle: string | null): string {
  const owner = t.ownerKind === "ME" ? "me" : t.ownerKind === "INTERNAL" ? `colleague: ${person(t.ownerName, t.ownerAddress) || "?"}` : t.ownerKind === "EXTERNAL" ? `external: ${person(t.ownerName, t.ownerAddress) || "?"}` : "unclear";
  const lines = [
    `<task${attrs([
      ["handle", registry.addTask(t)],
      ["status", STATUS_NOTES[t.status] ?? t.status],
      ["handled_by", owner],
      ["priority", t.priority === "NORMAL" ? null : t.priority.toLowerCase()],
      ["with", person(t.counterpartyName, t.counterpartyAddress)],
      ["company", t.company],
      ["due", t.dueDate],
      ["snoozed_until", t.snoozedUntil],
      ["created", day(t.createdAt, scope.zone)],
      ["last_activity", day(t.lastActivityAt, scope.zone)],
      ["closed", t.closedAt ? day(t.closedAt, scope.zone) : null],
      ["from_mail", originHandle],
    ])}>`,
    `<title>${escapeText(t.title)}</title>`,
  ];
  if (t.summary?.trim()) lines.push(`<summary>${escapeText(clip(t.summary.trim(), RENDER_LIMITS.summaryChars).text)}</summary>`);
  if (t.nextAction?.trim()) lines.push(`<next_step>${escapeText(clip(t.nextAction.trim(), 300).text)}</next_step>`);
  lines.push("</task>");
  return lines.join("\n");
}

export function renderTaskSearch(scope: ChatScope, res: TaskSearchResult, registry: SourceRegistry, originHandles: ReadonlyMap<string, string>): string {
  if (!res.hits.length) return "No task matched.";
  const head = res.total > res.hits.length ? `${res.total} tasks matched; ${res.hits.length} shown (open ones first, then the most recently active):` : `${res.hits.length} ${res.hits.length === 1 ? "task" : "tasks"} matched:`;
  return [head, ...res.hits.map((t) => renderTask(scope, t, registry, t.originMessageId ? (originHandles.get(t.originMessageId) ?? null) : null))].join("\n");
}

/** A source of an earlier answer, as one short line: enough to recognise it and to read it again by its handle. */
export function renderEarlierSource(scope: ChatScope, registry: SourceRegistry, source: { mail?: MailRecord; task?: TaskRef }): string {
  if (source.mail) {
    const r = source.mail;
    return `<mail${attrs([["handle", registry.addMail(r)], ["date", stamp(r.date, scope.zone)], ["by", writer(r)], ["from", person(r.fromName, r.fromAddress)], ["subject", clip(subjectOf(r), 140).text]])} />`;
  }
  if (source.task) return `<task${attrs([["handle", registry.addTask(source.task)], ["status", STATUS_NOTES[source.task.status] ?? source.task.status]])}><title>${escapeText(clip(source.task.title, 200).text)}</title></task>`;
  return "";
}

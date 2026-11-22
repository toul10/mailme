/**
 * “Ask your mail”: the user asks about their own mail and tasks, and the answer comes with the mail and tasks it
 * was taken from, numbered, so every sentence can be checked. The model only reads (src/chat); nothing on this
 * screen sends a mail or changes a task. Answers are plain text and are rendered as text.
 *
 * The conversation is the store's (chat-store.ts): it survives a visit to a task and back, and nothing else.
 */
import { Check, Copy, Mail, Paperclip, RotateCcw, ShieldAlert, SquareCheck } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent } from "react";
import type { ChatSource } from "../../../src/server/api-types.js";
import { QUESTION_MAX, type ChatExchange } from "../chat-store.js";
import { answerBlocks, type Inline } from "../chat-text.js";
import { chat } from "../client.js";
import { useToast } from "../components/Toast.js";
import { formatDateTime, plural } from "../format.js";
import { useApp, useDocumentTitle } from "../hooks.js";
import { STATUS_LABELS } from "../labels.js";
import { routeHref } from "../router.js";
import { getLastListHref } from "./TaskList.js";

/** Questions the task list and the mailbox can answer for anybody, in the words people use. */
const STARTERS = ["What is waiting for my reply?", "Who hasn't answered me yet?", "What was I asked for this week?", "What did I promise and haven't done?"];

const sourceId = (exchangeId: number, n: number) => `chat-src-${exchangeId}-${n}`;

export function Chat() {
  const { me, zone, today } = useApp();
  const { exchanges, busy } = useSyncExternalStore(chat.subscribe, chat.getSnapshot);
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useDocumentTitle("Ask your mail");

  // A further question goes to the top of the window; what is looked up and the answer fill in below it (the
  // stylesheet keeps that much room under the newest one). The first question stays under the page's title.
  const lastId = exchanges.at(-1)?.id ?? null;
  const isFurther = exchanges.length > 1;
  const shown = useRef(lastId);
  useEffect(() => {
    if (lastId !== null && lastId !== shown.current && isFurther) document.getElementById(`chat-x-${lastId}`)?.scrollIntoView({ block: "start" });
    shown.current = lastId;
  }, [lastId, isFurther]);

  if (!me.chat) {
    return (
      <div className="page">
        <header className="bridge bridge-compact">
          <h1 className="page-title">Ask your mail</h1>
        </header>
        <p className="empty">It isn't switched on in this installation.</p>
      </div>
    );
  }

  const ask = (question: string) => {
    if (busy || !question.trim()) return;
    setText("");
    void chat.ask(question);
  };
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    ask(text);
  };
  // Enter asks, Shift+Enter starts a new line; an Enter that only confirms a composition (IME) does neither.
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    ask(text);
  };
  const startOver = () => {
    chat.reset();
    setText("");
    inputRef.current?.focus();
  };

  return (
    <div className="page chat">
      <header className="bridge bridge-compact chat-bridge">
        <a className="back-link" href={getLastListHref()}>
          ← Back to the list
        </a>
        <div className="chat-bridge-row">
          <h1 className="page-title">Ask your mail</h1>
          {exchanges.length ? (
            <button type="button" className="btn btn-small" onClick={startOver}>
              New conversation
            </button>
          ) : null}
        </div>
        <p className="bridge-sub chat-bridge-sub">Ask anything about your mail and your tasks. Every answer shows the mail it was taken from.</p>
      </header>

      <div className="chat-thread">
        {exchanges.length === 0 ? (
          <div className="chat-start">
            <p className="chat-start-lead">To begin, try one of these:</p>
            <ul className="chat-starters">
              {STARTERS.map((q) => (
                <li key={q}>
                  <button type="button" className="chat-starter" onClick={() => ask(q)}>
                    {q}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          exchanges.map((x) => <Exchange key={x.id} x={x} zone={zone} today={today} canRetry={!busy} />)
        )}
      </div>

      <form className="chat-dock" onSubmit={onSubmit}>
        <div className="chat-box">
          <label className="sr-only" htmlFor="chat-question">
            Your question
          </label>
          <textarea
            id="chat-question"
            ref={inputRef}
            rows={2}
            value={text}
            maxLength={QUESTION_MAX}
            placeholder="e.g. What did ABC write to me about the order?"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            autoFocus
          />
          {busy ? (
            <button type="button" className="btn chat-send" onClick={() => chat.stop()}>
              Stop
            </button>
          ) : (
            <button type="submit" className="btn btn-primary chat-send" disabled={!text.trim()}>
              Ask
            </button>
          )}
        </div>
        <p className="chat-note">It reads only your own mail and tasks, and changes nothing. The conversation is not saved.</p>
      </form>
    </div>
  );
}

function Exchange({ x, zone, today, canRetry }: { x: ChatExchange; zone: string; today: string; canRetry: boolean }) {
  return (
    <article className="chat-x" id={`chat-x-${x.id}`}>
      <h2 className="chat-q">
        <span className="led led-user" aria-hidden="true" />
        <span>{x.question}</span>
      </h2>
      <div className="chat-out" aria-live="polite" aria-busy={x.status === "running"}>
        {x.status === "running" ? <Trace steps={x.steps} /> : null}
        {x.status === "done" ? <Answer x={x} zone={zone} today={today} /> : null}
        {x.status === "failed" ? (
          <div className="chat-fail">
            <p>{x.error}</p>
            <RetryButton id={x.id} disabled={!canRetry} label="Ask again" />
          </div>
        ) : null}
        {x.status === "stopped" ? (
          <div className="chat-fail chat-stopped">
            <p>You stopped it before it was answered.</p>
            <RetryButton id={x.id} disabled={!canRetry} label="Ask again" />
          </div>
        ) : null}
      </div>
    </article>
  );
}

function RetryButton({ id, disabled, label }: { id: number; disabled: boolean; label: string }) {
  return (
    <button type="button" className="btn btn-small" disabled={disabled} onClick={() => void chat.retry(id)}>
      <RotateCcw size={14} aria-hidden="true" />
      {label}
    </button>
  );
}

/** While a question runs: the lookups done so far, and one lit line for what happens now. */
function Trace({ steps }: { steps: readonly string[] }) {
  return (
    <ol className="chat-trace">
      {steps.map((label, i) => (
        <li key={i}>
          <span className="led" aria-hidden="true" />
          {label}
        </li>
      ))}
      <li className="is-now">
        <span className="led led-ai" aria-hidden="true" />
        {steps.length ? "Reading what I found…" : "Working out where to look…"}
      </li>
    </ol>
  );
}

function Answer({ x, zone, today }: { x: ChatExchange; zone: string; today: string }) {
  const blocks = useMemo(() => answerBlocks(x.answer ?? "", x.sources), [x.answer, x.sources]);
  const jump = (n: number) => {
    const el = document.getElementById(sourceId(x.id, n));
    el?.scrollIntoView({ block: "nearest" });
    el?.focus({ preventScroll: true });
  };
  const line = (parts: Inline[]) =>
    parts.map((p, i) =>
      p.kind === "text" ? (
        p.text
      ) : (
        <button key={i} type="button" className="chat-cite" onClick={() => jump(p.n)} aria-label={`Source ${p.n}`}>
          {p.n}
        </button>
      ),
    );

  return (
    <div className="chat-a">
      <div className="chat-a-text">
        <span className="led led-ai chat-a-led" aria-hidden="true" />
        {blocks.map((b, i) =>
          b.kind === "p" ? (
            <p key={i}>
              {b.lines.map((parts, j) => (
                <span key={j} className="chat-line">
                  {line(parts)}
                </span>
              ))}
            </p>
          ) : b.ordered ? (
            <ol key={i}>
              {b.items.map((parts, j) => (
                <li key={j}>{line(parts)}</li>
              ))}
            </ol>
          ) : (
            <ul key={i}>
              {b.items.map((parts, j) => (
                <li key={j}>{line(parts)}</li>
              ))}
            </ul>
          ),
        )}
      </div>
      {x.draft ? <Draft text={x.draft} /> : null}
      {x.sources.length ? (
        <section className="chat-sources" aria-label="Sources of the answer">
          <h3 className="chat-h">Where it comes from</h3>
          <ol className="chat-src-list">
            {x.sources.map((s, i) => (
              <Source key={s.handle} s={s} n={i + 1} id={sourceId(x.id, i + 1)} zone={zone} today={today} />
            ))}
          </ol>
        </section>
      ) : null}
      {x.steps.length ? (
        <details className="chat-looked">
          <summary>
            What I looked at ({plural(x.steps.length, "lookup", "lookups")})
          </summary>
          <ol>
            {x.steps.map((label, i) => (
              <li key={i}>{label}</li>
            ))}
          </ol>
        </details>
      ) : null}
    </div>
  );
}

function Source({ s, n, id, zone, today }: { s: ChatSource; n: number; id: string; zone: string; today: string }) {
  if (s.kind === "task") {
    return (
      <li className="chat-src" id={id} tabIndex={-1}>
        <span className="chat-src-n" aria-hidden="true">
          {n}
        </span>
        <div className="chat-src-body">
          <p className="chat-src-title">
            <SquareCheck size={15} aria-hidden="true" />
            <a href={routeHref({ name: "task", id: s.taskId })}>
              #{s.ref} {s.title}
            </a>
          </p>
          <p className="chat-src-meta">Task, {STATUS_LABELS[s.status].toLowerCase()}</p>
        </div>
      </li>
    );
  }
  // “You” only for mail that is the user's beyond doubt. Everyone else is shown with the address the mail came
  // from: a display name is whatever the sender typed.
  const mine = s.own && !s.unverified;
  const name = (s.fromName ?? "").trim();
  const address = (s.fromAddress ?? "").trim();
  const showAddress = !mine && !!address && name.toLowerCase() !== address.toLowerCase();
  const who = mine ? "You" : name || address || "Unknown sender";
  const files = s.attachments.length;
  return (
    <li className="chat-src" id={id} tabIndex={-1}>
      <span className="chat-src-n" aria-hidden="true">
        {n}
      </span>
      <div className="chat-src-body">
        <p className="chat-src-title">
          <Mail size={15} aria-hidden="true" />
          <span>{s.subject || "(no subject)"}</span>
        </p>
        <p className="chat-src-meta">
          {who}
          {showAddress && name ? <span className="chat-src-addr"> &lt;{address}&gt;</span> : null}, {formatDateTime(s.date, zone, today)}
          {files ? (
            <span className="chat-src-files" title={s.attachments.join(", ")}>
              <Paperclip size={13} aria-hidden="true" />
              {plural(files, "attachment", "attachments")}
            </span>
          ) : null}
        </p>
        {s.unverified ? (
          <p className="chat-src-warn">
            <ShieldAlert size={14} aria-hidden="true" />
            <span>{s.own ? "It says you sent it, but the mail server did not confirm that." : "It says it comes from your organization, but the mail server did not confirm that."}</span>
          </p>
        ) : null}
        {s.excerpt ? (
          <figure className="quote chat-src-quote">
            <blockquote>
              <p>{s.excerpt}</p>
            </blockquote>
          </figure>
        ) : null}
        <p className="chat-src-link">
          {s.task ? <a href={routeHref({ name: "task", id: s.task.id })}>Task #{s.task.ref}</a> : <a href={routeHref({ name: "new", fromMessageId: s.messageId })}>New task from this email</a>}
        </p>
      </div>
    </li>
  );
}

/** A mail the user asked for: text to copy into their own mail program. MailMe sends nothing. */
function Draft({ text }: { text: string }) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => void (timer.current !== null && window.clearTimeout(timer.current)), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast("Copied", "success");
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 2500);
    } catch {
      toast("It couldn't be copied. Select the text and copy it with the keyboard.", "error");
    }
  };

  return (
    <section className="chat-draft" aria-label="Draft email">
      <header className="chat-draft-head">
        <h3 className="chat-h">Draft email</h3>
        <button type="button" className="btn btn-small" onClick={() => void copy()}>
          {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
          Copy
        </button>
      </header>
      <div className="chat-draft-text">{text}</div>
      <p className="chat-draft-note">MailMe sends no mail. Paste it into your mail program and read it before you send it.</p>
    </section>
  );
}

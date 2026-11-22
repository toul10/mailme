/**
 * The conversation of “Ask your mail”: what was asked, what is being looked up, what came back. It lives in
 * memory only — not on the server (src/server/routes/chat.ts stores nothing of it) and not in the browser's storage
 * — so it is gone with the tab, and it is cleared when the user signs out or another one signs in.
 *
 * No DOM here: the store is driven by an injected `ask` (the API client's `chat`) and runs under vitest in node.
 */
import type { ChatEvent, ChatRequest, ChatSource, ChatTurn } from "../../src/server/api-types.js";
import { errorMessage, isApiError } from "./api.js";

export type AskFn = (req: ChatRequest, onEvent: (event: ChatEvent) => void, signal: AbortSignal) => Promise<void>;

export interface ChatExchange {
  id: number;
  question: string;
  status: "running" | "done" | "failed" | "stopped";
  /** What was looked up, in order (shown while it runs, and afterwards on request). */
  steps: string[];
  answer: string | null;
  draft: string | null;
  sources: ChatSource[];
  /** Why there is no answer (status "failed"). */
  error: string | null;
}

export interface ChatSnapshot {
  exchanges: readonly ChatExchange[];
  busy: boolean;
}

/** Earlier turns sent along with a question (the server reads at most this many: CHAT_LIMITS.historyTurns). */
export const HISTORY_TURNS = 6;
/** Sources of one earlier turn sent along (the server refuses a turn with more: src/server/routes/chat.ts). */
export const HISTORY_SOURCES = 60;
export const QUESTION_MAX = 2000;

/** The answered turns, oldest first, as the server takes them: the texts, and its sources by id only. */
export function historyOf(exchanges: readonly ChatExchange[]): ChatTurn[] {
  return exchanges
    .filter((x) => x.status === "done" && x.answer)
    .slice(-HISTORY_TURNS)
    .map((x) => ({
      question: x.question,
      answer: x.answer ?? "",
      draft: x.draft,
      sources: x.sources.slice(0, HISTORY_SOURCES).map((s) => (s.kind === "mail" ? { kind: "mail" as const, id: s.messageId } : { kind: "task" as const, id: s.taskId })),
    }));
}

/** Why a question got no answer, in the user's words. */
export function chatErrorText(err: unknown): string {
  if (isApiError(err)) {
    // The server says which limit it was (one at a time, today's questions, today's budget).
    if (err.code === "rate_limited" && err.serverMessage) return err.serverMessage;
    if (err.code === "not_found") return "“Ask your mail” isn't switched on here.";
    if (err.code === "invalid") return "This question can't be sent as it is. Make it shorter and try again.";
  }
  return errorMessage(err);
}

export const CUT_SHORT = "The answer was cut off halfway. Try again.";

export class ChatStore {
  private exchanges: ChatExchange[] = [];
  private snapshot: ChatSnapshot = { exchanges: [], busy: false };
  private readonly listeners = new Set<() => void>();
  private running: { id: number; abort: AbortController } | null = null;
  private nextId = 1;
  private owner: string | null = null;

  constructor(private readonly askFn: AskFn) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  readonly getSnapshot = (): ChatSnapshot => this.snapshot;

  private publish(): void {
    this.snapshot = { exchanges: this.exchanges, busy: this.running !== null };
    for (const l of this.listeners) l();
  }

  private patch(id: number, change: Partial<ChatExchange>): void {
    this.exchanges = this.exchanges.map((x) => (x.id === id ? { ...x, ...change } : x));
    this.publish();
  }

  /** Asks; nothing happens while another question runs or when there is nothing to ask. */
  async ask(text: string): Promise<void> {
    const question = text.trim().slice(0, QUESTION_MAX);
    if (!question || this.running) return;
    const history = historyOf(this.exchanges);
    const id = this.nextId++;
    const abort = new AbortController();
    this.running = { id, abort };
    this.exchanges = [...this.exchanges, { id, question, status: "running", steps: [], answer: null, draft: null, sources: [], error: null }];
    this.publish();

    // Whatever arrives after the question was stopped or the conversation cleared belongs to nobody.
    const mine = () => this.running?.id === id;
    let settled = false;
    try {
      await this.askFn(
        { question, history },
        (event) => {
          if (!mine() || settled) return;
          const now = this.exchanges.find((x) => x.id === id);
          if (!now) return;
          if (event.type === "step") this.patch(id, { steps: [...now.steps, event.label] });
          else if (event.type === "answer") {
            settled = true;
            this.patch(id, { status: "done", answer: event.answer, draft: event.draft, sources: event.sources });
          } else {
            settled = true;
            this.patch(id, { status: "failed", error: event.message });
          }
        },
        abort.signal,
      );
      if (mine() && !settled) this.patch(id, abort.signal.aborted ? { status: "stopped" } : { status: "failed", error: CUT_SHORT });
    } catch (err) {
      if (mine() && !settled) this.patch(id, abort.signal.aborted ? { status: "stopped" } : { status: "failed", error: chatErrorText(err) });
    } finally {
      if (mine()) {
        this.running = null;
        this.publish();
      }
    }
  }

  /** Gives up the question that is running (the server stops its model call when the connection closes). */
  stop(): void {
    const run = this.running;
    if (!run) return;
    run.abort.abort();
    this.running = null;
    this.patch(run.id, { status: "stopped" });
  }

  /** Asks a question that failed or was stopped once more, in its place at the end of the conversation. */
  async retry(id: number): Promise<void> {
    const x = this.exchanges.find((e) => e.id === id);
    if (!x || x.status === "running" || x.status === "done" || this.running) return;
    this.exchanges = this.exchanges.filter((e) => e.id !== id);
    await this.ask(x.question);
  }

  /** “New conversation”, and signing out: everything goes, a running question included. */
  reset(): void {
    this.running?.abort.abort();
    this.running = null;
    this.exchanges = [];
    this.publish();
  }

  /** The conversation belongs to one signed-in user: another one starts from nothing. */
  bindUser(userId: string): void {
    if (this.owner !== null && this.owner !== userId) this.reset();
    this.owner = userId;
  }
}

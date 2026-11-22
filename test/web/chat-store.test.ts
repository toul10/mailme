import { describe, expect, it } from "vitest";
import type { ChatEvent, ChatRequest, ChatSource } from "../../src/server/api-types.js";
import { ApiRequestError } from "../../web/src/api.js";
import { CUT_SHORT, ChatStore, HISTORY_SOURCES, HISTORY_TURNS, QUESTION_MAX, chatErrorText, historyOf, type AskFn, type ChatExchange, type ChatSnapshot } from "../../web/src/chat-store.js";

interface Call {
  req: ChatRequest;
  emit: (event: ChatEvent) => void;
  signal: AbortSignal;
  end: () => void;
  fail: (err: unknown) => void;
}

/** An `ask` the test drives by hand: every question waits until the test ends or fails it. */
function manualAsk() {
  const calls: Call[] = [];
  const ask: AskFn = (req, onEvent, signal) =>
    new Promise<void>((resolve, reject) => {
      calls.push({ req, emit: onEvent, signal, end: resolve, fail: reject });
    });
  return { ask, calls };
}

const mail = (handle: string): ChatSource => ({
  kind: "mail",
  handle,
  messageId: `message-${handle}`,
  date: "2026-11-18T08:42:00.000Z",
  fromName: "Γιώργος Παπαδόπουλος",
  fromAddress: "g@abc-hotels.example",
  own: false,
  unverified: false,
  subject: "Προσφορά",
  excerpt: "Καλημέρα σας",
  attachments: [],
  task: null,
});
const task = (ref: number): ChatSource => ({ kind: "task", handle: `#${ref}`, taskId: `task-${ref}`, ref, title: "ABC — Προσφορά", status: "ACTION_REQUIRED" });
const answer = (text: string, sources: ChatSource[] = [], draft: string | null = null): ChatEvent => ({ type: "answer", answer: text, draft, sources });

/** Asks and answers in one go. */
async function exchange(store: ChatStore, calls: Call[], question: string, event: ChatEvent): Promise<void> {
  const done = store.ask(question);
  const call = calls.at(-1)!;
  call.emit(event);
  call.end();
  await done;
}

describe("chat store: one question", () => {
  it("shows the question at once, the lookups as they come, then the answer", async () => {
    const { ask, calls } = manualAsk();
    const store = new ChatStore(ask);
    const seen: ChatSnapshot[] = [];
    store.subscribe(() => seen.push(store.getSnapshot()));

    const done = store.ask("  Τι περιμένει απάντηση από μένα;  ");
    expect(store.getSnapshot()).toMatchObject({ busy: true, exchanges: [{ id: 1, question: "Τι περιμένει απάντηση από μένα;", status: "running", steps: [], answer: null }] });
    expect(calls[0]!.req).toEqual({ question: "Τι περιμένει απάντηση από μένα;", history: [] });

    calls[0]!.emit({ type: "step", label: "Looking at your tasks" });
    calls[0]!.emit({ type: "step", label: "Reading the conversation “Προσφορά”" });
    expect(store.getSnapshot().exchanges[0]!.steps).toEqual(["Looking at your tasks", "Reading the conversation “Προσφορά”"]);

    calls[0]!.emit(answer("Η ABC περιμένει προσφορά [M3fa9c1].", [mail("M3fa9c1")], "Καλημέρα σας,"));
    // A second answer or an error after the answer changes nothing.
    calls[0]!.emit({ type: "error", code: "internal", message: "late" });
    calls[0]!.end();
    await done;

    expect(store.getSnapshot()).toMatchObject({
      busy: false,
      exchanges: [{ status: "done", answer: "Η ABC περιμένει προσφορά [M3fa9c1].", draft: "Καλημέρα σας,", error: null, steps: ["Looking at your tasks", "Reading the conversation “Προσφορά”"] }],
    });
    expect(store.getSnapshot().exchanges[0]!.sources).toEqual([mail("M3fa9c1")]);
    // useSyncExternalStore compares snapshots by identity: a new one for every change, the same one in between.
    expect(new Set(seen).size).toBe(seen.length);
    expect(store.getSnapshot()).toBe(store.getSnapshot());
  });

  it("asks nothing for an empty question, cuts a very long one, and takes one question at a time", async () => {
    const { ask, calls } = manualAsk();
    const store = new ChatStore(ask);
    await store.ask("   \n ");
    expect(calls).toHaveLength(0);
    expect(store.getSnapshot()).toEqual({ exchanges: [], busy: false });

    const done = store.ask("ξ".repeat(QUESTION_MAX + 500));
    expect(calls[0]!.req.question).toHaveLength(QUESTION_MAX);
    await store.ask("Και κάτι ακόμα");
    expect(calls).toHaveLength(1);
    expect(store.getSnapshot().exchanges).toHaveLength(1);
    calls[0]!.end();
    await done;
  });

  it("stops listening when the listener leaves", async () => {
    const { ask, calls } = manualAsk();
    const store = new ChatStore(ask);
    let heard = 0;
    const leave = store.subscribe(() => heard++);
    leave();
    await exchange(store, calls, "Κάτι", answer("Ναι."));
    expect(heard).toBe(0);
  });
});

describe("chat store: what goes back to the server", () => {
  it("sends the answered turns with their sources by id only, and never a failed or stopped one", async () => {
    const { ask, calls } = manualAsk();
    const store = new ChatStore(ask);
    await exchange(store, calls, "Τι ζητά η ABC;", answer("Προσφορά [M3fa9c1], είναι η [#184].", [mail("M3fa9c1"), task(184)], "Καλημέρα σας,"));
    await exchange(store, calls, "Και η Delta;", { type: "error", code: "ai_unavailable", message: "The AI didn't answer." });
    const stopped = store.ask("Κάτι που σταμάτησα");
    store.stop();
    calls[2]!.end();
    await stopped;

    const done = store.ask("Γράψε της μια απάντηση");
    expect(calls[3]!.req).toEqual({
      question: "Γράψε της μια απάντηση",
      history: [
        {
          question: "Τι ζητά η ABC;",
          answer: "Προσφορά [M3fa9c1], είναι η [#184].",
          draft: "Καλημέρα σας,",
          sources: [
            { kind: "mail", id: "message-M3fa9c1" },
            { kind: "task", id: "task-184" },
          ],
        },
      ],
    });
    calls[3]!.end();
    await done;
  });

  it("sends the newest turns only", () => {
    const turns: ChatExchange[] = Array.from({ length: HISTORY_TURNS + 3 }, (_, i) => ({ id: i + 1, question: `Ερώτηση ${i + 1}`, status: "done", steps: [], answer: `Απάντηση ${i + 1}`, draft: null, sources: [], error: null }));
    const history = historyOf(turns);
    expect(history).toHaveLength(HISTORY_TURNS);
    expect(history[0]!.question).toBe("Ερώτηση 4");
    expect(history.at(-1)!.question).toBe(`Ερώτηση ${HISTORY_TURNS + 3}`);
  });

  it("never sends more sources for a turn than the server takes: an answer with many must not break the next question", () => {
    const many = Array.from({ length: HISTORY_SOURCES + 25 }, (_, i) => mail(`M${String(i).padStart(6, "0")}`));
    const [turn] = historyOf([{ id: 1, question: "Όλα;", status: "done", steps: [], answer: "Όλα.", draft: null, sources: many, error: null }]);
    expect(turn!.sources).toHaveLength(HISTORY_SOURCES);
    expect(turn!.sources[0]).toEqual({ kind: "mail", id: "message-M000000" });
    // The same number as the route's schema (src/server/routes/chat.ts).
    expect(HISTORY_SOURCES).toBe(60);
  });
});

describe("chat store: when there is no answer", () => {
  it("says what the server said", async () => {
    const { ask, calls } = manualAsk();
    const store = new ChatStore(ask);
    await exchange(store, calls, "Κάτι", { type: "error", code: "too_slow", message: "That took too long, so I stopped." });
    expect(store.getSnapshot()).toMatchObject({ busy: false, exchanges: [{ status: "failed", error: "That took too long, so I stopped.", answer: null }] });
  });

  it("says the answer was cut short when the stream ends without one", async () => {
    const { ask, calls } = manualAsk();
    const store = new ChatStore(ask);
    const done = store.ask("Κάτι");
    calls[0]!.emit({ type: "step", label: "Searching your mail" });
    calls[0]!.end();
    await done;
    expect(store.getSnapshot()).toMatchObject({ busy: false, exchanges: [{ status: "failed", error: CUT_SHORT, steps: ["Searching your mail"] }] });
  });

  it("puts a refusal in the user's words", async () => {
    const { ask, calls } = manualAsk();
    const store = new ChatStore(ask);
    const done = store.ask("Κάτι");
    calls[0]!.fail(new ApiRequestError(429, "rate_limited", "You've reached today's limit of questions. Try again tomorrow."));
    await done;
    expect(store.getSnapshot()).toMatchObject({ busy: false, exchanges: [{ status: "failed", error: "You've reached today's limit of questions. Try again tomorrow." }] });

    expect(chatErrorText(new ApiRequestError(429, "rate_limited", null))).toBe("Too many attempts. Try again in a moment.");
    expect(chatErrorText(new ApiRequestError(404, "not_found", "Not found"))).toBe("“Ask your mail” isn't switched on here.");
    expect(chatErrorText(new ApiRequestError(422, "invalid", "question: Too big"))).toBe("This question can't be sent as it is. Make it shorter and try again.");
    expect(chatErrorText(new ApiRequestError(0, "network", null))).toBe("No connection to the server.");
    expect(chatErrorText(new ApiRequestError(401, "unauthorized", null))).toBe("Your session has expired. Sign in again.");
    expect(chatErrorText(new Error("boom"))).toBe("Something went wrong. Try again.");
  });

  it("keeps the answer it has when the connection breaks after it", async () => {
    const { ask, calls } = manualAsk();
    const store = new ChatStore(ask);
    const done = store.ask("Κάτι");
    calls[0]!.emit(answer("Ναι."));
    calls[0]!.fail(new ApiRequestError(0, "network", null));
    await done;
    expect(store.getSnapshot()).toMatchObject({ busy: false, exchanges: [{ status: "done", answer: "Ναι.", error: null }] });
  });
});

describe("chat store: stop, ask again, start over", () => {
  it("stops the running question; what arrives afterwards belongs to nobody", async () => {
    const { ask, calls } = manualAsk();
    const store = new ChatStore(ask);
    const first = store.ask("Κάτι αργό");
    calls[0]!.emit({ type: "step", label: "Searching your mail" });
    store.stop();
    expect(calls[0]!.signal.aborted).toBe(true);
    expect(store.getSnapshot()).toMatchObject({ busy: false, exchanges: [{ status: "stopped", steps: ["Searching your mail"] }] });

    // The next question does not wait for the stopped one to let go.
    const second = store.ask("Κάτι άλλο");
    expect(calls).toHaveLength(2);
    calls[0]!.emit(answer("Πολύ αργά."));
    calls[0]!.fail(new ApiRequestError(0, "network", null));
    await first;
    expect(store.getSnapshot()).toMatchObject({ busy: true, exchanges: [{ status: "stopped", answer: null }, { status: "running" }] });

    calls[1]!.emit(answer("Εντάξει."));
    calls[1]!.end();
    await second;
    expect(store.getSnapshot()).toMatchObject({ busy: false, exchanges: [{ status: "stopped" }, { status: "done", answer: "Εντάξει." }] });
    store.stop(); // nothing runs: nothing happens
    expect(store.getSnapshot().exchanges.map((x) => x.status)).toEqual(["stopped", "done"]);
  });

  it("shows no lost connection for a request its own stop ended", async () => {
    const { ask, calls } = manualAsk();
    const store = new ChatStore(ask);
    const done = store.ask("Κάτι");
    store.stop();
    // The aborted fetch rejects, as the browser's does.
    calls[0]!.fail(new ApiRequestError(0, "network", null));
    await done;
    expect(store.getSnapshot()).toMatchObject({ busy: false, exchanges: [{ status: "stopped", error: null }] });
  });

  it("asks a failed or stopped question again, at the end of the conversation", async () => {
    const { ask, calls } = manualAsk();
    const store = new ChatStore(ask);
    await exchange(store, calls, "Πρώτη", { type: "error", code: "no_answer", message: "No answer came out." });
    await exchange(store, calls, "Δεύτερη", answer("Ναι."));
    const [failed, answered] = store.getSnapshot().exchanges;

    await store.retry(answered!.id); // an answered one is not asked again
    expect(calls).toHaveLength(2);

    const again = store.retry(failed!.id);
    expect(store.getSnapshot().exchanges.map((x) => [x.question, x.status])).toEqual([
      ["Δεύτερη", "done"],
      ["Πρώτη", "running"],
    ]);
    // The answered turn goes along as context; the failed attempt does not.
    expect(calls[2]!.req).toMatchObject({ question: "Πρώτη", history: [{ question: "Δεύτερη", answer: "Ναι." }] });
    await store.retry(failed!.id); // gone from the list, and something is running anyway
    expect(calls).toHaveLength(3);
    calls[2]!.emit(answer("Τώρα ναι."));
    calls[2]!.end();
    await again;
    expect(store.getSnapshot().exchanges.map((x) => x.answer)).toEqual(["Ναι.", "Τώρα ναι."]);
    // Ids are never reused: the screen keys its rows by them.
    expect(store.getSnapshot().exchanges.map((x) => x.id)).toEqual([answered!.id, failed!.id + 2]);
  });

  it("“New conversation” forgets everything, a running question included", async () => {
    const { ask, calls } = manualAsk();
    const store = new ChatStore(ask);
    await exchange(store, calls, "Πρώτη", answer("Ναι."));
    const running = store.ask("Δεύτερη");
    store.reset();
    expect(calls[1]!.signal.aborted).toBe(true);
    expect(store.getSnapshot()).toEqual({ exchanges: [], busy: false });
    calls[1]!.emit(answer("Πολύ αργά."));
    calls[1]!.end();
    await running;
    expect(store.getSnapshot()).toEqual({ exchanges: [], busy: false });

    // The next conversation starts without the old turns.
    const next = store.ask("Τρίτη");
    expect(calls[2]!.req.history).toEqual([]);
    calls[2]!.end();
    await next;
  });

  it("belongs to one signed-in user: another one starts from nothing", async () => {
    const { ask, calls } = manualAsk();
    const store = new ChatStore(ask);
    store.bindUser("u1");
    await exchange(store, calls, "Πρώτη", answer("Ναι."));
    store.bindUser("u1");
    expect(store.getSnapshot().exchanges).toHaveLength(1);
    store.bindUser("u2");
    expect(store.getSnapshot()).toEqual({ exchanges: [], busy: false });
  });
});

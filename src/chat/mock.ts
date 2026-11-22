/**
 * A chat model that calls nobody (CHAT_MODE=mock): for development and tests of everything around the model —
 * the lookups, the limits, the stream, the screen. It searches for the question's longer words, then lists what
 * came back. It reads only the transcript it is given, like a real model.
 */
import { ZERO_USAGE } from "../ai/pricing.js";
import type { ChatModel, ChatModelCall, ChatModelResult } from "./model.js";
import { foldText } from "./search.js";

const unescape = (s: string): string => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');

function lastQuestion(user: string): string {
  const all = [...user.matchAll(/<question>([\s\S]*?)<\/question>/g)];
  return unescape(all.at(-1)?.[1] ?? "").trim();
}

function words(question: string): string[] {
  const out: string[] = [];
  for (const w of foldText(question).split(/[^\p{L}\p{N}@.]+/u)) {
    const stem = w.length > 6 ? w.slice(0, w.length - 2) : w;
    if (stem.length >= 4 && !out.includes(stem)) out.push(stem);
  }
  return out.slice(0, 8);
}

const EMPTY = { all_of: [], any_of: [], person: "", after: "", before: "", sender: "anyone", handle: "", status: "open" } as const;

export function createMockChatModel(): ChatModel {
  async function complete(call: ChatModelCall): Promise<ChatModelResult> {
    const started = performance.now();
    const done = (step: unknown): ChatModelResult => ({ ok: true, text: JSON.stringify(step), model: "mock", usage: ZERO_USAGE, costUsd: 0, latencyMs: Math.round(performance.now() - started) });
    if (call.signal?.aborted) return { ok: false, kind: "aborted", error: "aborted", model: "mock", usage: null, costUsd: 0, latencyMs: 0 };

    // Only this question's rounds: what follows the last <question> block.
    const tail = call.user.slice(call.user.lastIndexOf("<question>"));
    if (!/<round n="/.test(tail)) {
      const any = words(lastQuestion(call.user));
      return done({
        lookups: [
          { ...EMPTY, tool: "search_mail", any_of: any },
          { ...EMPTY, tool: "search_tasks", any_of: any, status: "any" },
        ],
        answer: "",
        draft: "",
        sources: [],
      });
    }

    const mails = [...tail.matchAll(/<mail handle="(M[0-9a-f]+)"[^>]*? subject="([^"]*)"/g)].map((m) => ({ handle: m[1]!, label: unescape(m[2]!) }));
    const tasks = [...tail.matchAll(/<task handle="(#\d+)"[^>]*>\s*<title>([\s\S]*?)<\/title>/g)].map((m) => ({ handle: m[1]!, label: unescape(m[2]!) }));
    const seen = new Set<string>();
    const found = [...tasks, ...mails].filter((x) => (seen.has(x.handle) ? false : (seen.add(x.handle), true))).slice(0, 8);
    const lines = found.map((x) => `- ${x.label} [${x.handle}]`);
    const answer = found.length
      ? `Test mode (no AI). This is what matches the words of your question:\n${lines.join("\n")}`
      : "Test mode (no AI). I found no mail or task with the words of your question.";
    return done({ lookups: [], answer, draft: "", sources: found.map((x) => x.handle) });
  }

  return { name: "mock", id: "mock", complete };
}

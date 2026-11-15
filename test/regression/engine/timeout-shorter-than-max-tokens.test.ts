// Regression for review finding timeout-shorter-than-max-tokens (no repro in the review). The extractor used a
// non-streaming call with a 180 s timeout while max_tokens allowed a much longer generation, so the
// "max_tokens → retry → park" path was unreachable and long responses looped as TRANSIENT timeouts forever.
// Now: streamed (`stream().finalMessage()`), the SDK timeout bounds only the wait for headers, the generation has a
// deadline derived from max_tokens, a failure after the stream connected is TRANSIENT (never GLOBAL), and a message
// that overruns the deadline repeatedly is parked.
import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessage, BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createClaudeExtractor, generationDeadlineMs, STREAM_DEADLINE_ERROR, type ClaudeExtractorConfig, type ClaudeRequestOptions } from "../../../src/ai/claude.js";
import * as s from "../../../src/db/schema.js";
import type { ExtractorResult } from "../../../src/domain/types.js";
import { drainMailbox, MAX_DEADLINE_ATTEMPTS } from "../../../src/engine/pipeline.js";
import { createTestDb, insertMessage, insertThread, seedOrgUserMailbox, type TestDb } from "../../helpers/db.js";
import { fakeExtractor, pipelineDeps, testClock } from "../../engine-db/fixtures.js";
import { betaMessage, fakeClient, Hang, makeInput, MidStream, VALID_OUTPUT, VALID_TEXT } from "../../ai/helpers.js";

function cfg(over: Partial<ClaudeExtractorConfig> = {}): ClaudeExtractorConfig {
  return {
    model: "claude-opus-5",
    effort: "high",
    fallbacks: "default",
    cacheTtl: "1h",
    maxTokens: 16_000,
    timeoutMs: 180_000,
    maxRetries: 0,
    strictEnums: false,
    componentVersions: { cleaner: "c1", resolver: "r2" },
    ...over,
  };
}
const input = makeInput();

describe("timeout-shorter-than-max-tokens — streamed extractor", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("the generation deadline covers max_tokens at a slow output rate (the SDK itself budgets 450 s for 16k non-streaming)", () => {
    const sdkEstimateMs = (60 * 60 * 1000 * 16_000) / 128_000;
    expect(generationDeadlineMs(16_000)).toBeGreaterThan(sdkEstimateMs);
    expect(generationDeadlineMs(16_000)).toBeGreaterThan(180_000);
    expect(generationDeadlineMs(32_000)).toBeGreaterThan(2 * sdkEstimateMs);
  });

  it("a 5-minute generation (longer than the old 180 s request timeout) completes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const calls: ClaudeRequestOptions[] = [];
    const client = {
      beta: {
        messages: {
          stream(_p: BetaMessageStreamParams, options?: ClaudeRequestOptions) {
            calls.push(options ?? {});
            let onConnect = () => {};
            return {
              on(_e: "connect", l: () => void) {
                onConnect = l;
                return this;
              },
              async finalMessage(): Promise<BetaMessage> {
                onConnect();
                await new Promise((r) => setTimeout(r, 5 * 60_000));
                if (options?.signal?.aborted) throw new Anthropic.APIUserAbortError();
                return betaMessage();
              },
            };
          },
        },
      },
    };
    const pending = createClaudeExtractor(cfg({ client })).extract(input);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    const res = await pending;
    expect(res.ok).toBe(true);
    expect(calls[0]).toMatchObject({ timeout: 180_000 });
  });

  it("reaching max_tokens is reachable again: one bump, then PER_MESSAGE max_tokens (parked)", async () => {
    const { client, calls } = fakeClient([betaMessage({ stop_reason: "max_tokens" }), betaMessage({ stop_reason: "max_tokens" })]);
    const res = await createClaudeExtractor(cfg({ client })).extract(input);
    expect(res).toMatchObject({ ok: false, errorClass: "PER_MESSAGE", error: "max_tokens" });
    expect(calls.map((c) => c.params.max_tokens)).toEqual([16_000, 32_000]);
  });

  it("a generation past its deadline → TRANSIENT «deadline», keeping the partial usage it was billed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const partial = betaMessage({ content: [], stop_reason: null, usage: { input_tokens: 3000, output_tokens: 1, cache_read_input_tokens: 0 } });
    const { client } = fakeClient([new Hang(partial)]);
    const pending = createClaudeExtractor(cfg({ client })).extract(input);
    await vi.advanceTimersByTimeAsync(generationDeadlineMs(16_000) + 1);
    const res = await pending;
    expect(res).toMatchObject({ ok: false, errorClass: "TRANSIENT", error: STREAM_DEADLINE_ERROR, retryAfterSec: 30 });
    expect(res.usage?.inputTokens).toBe(3000);
    expect(res.costUsd).toBeGreaterThan(0);
  });

  it("failures after the stream connected are TRANSIENT, before it connected they keep their HTTP class", async () => {
    const dropped = new Anthropic.AnthropicError("terminated");
    const a = await createClaudeExtractor(cfg({ client: fakeClient([new MidStream(dropped)]).client })).extract(input);
    expect(a).toMatchObject({ ok: false, errorClass: "TRANSIENT", error: "stream_interrupted" });
    // The same SDK-level error before "connect" is SDK misuse → GLOBAL (unchanged).
    const b = await createClaudeExtractor(cfg({ client: fakeClient([new Anthropic.AnthropicError("Streaming is required")]).client })).extract(input);
    expect(b).toMatchObject({ ok: false, errorClass: "GLOBAL" });
  });
});

// ── Through the real SDK (stream + finalMessage) over a fake fetch ─────────────

type SseEvent = [string, unknown];
const enc = new TextEncoder();

function sse(events: SseEvent[], end: "close" | "network" = "close"): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const [event, data] of events) controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      if (end === "network") controller.error(new TypeError("terminated"));
      else controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream", "request-id": "req_test" } });
}

const messageStart: SseEvent = [
  "message_start",
  {
    type: "message_start",
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-opus-5",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      stop_details: null,
      usage: { input_tokens: 1000, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 8000 },
    },
  },
];
const text = (t: string): SseEvent[] => [
  ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "", citations: null } }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } }],
  ["content_block_stop", { type: "content_block_stop", index: 0 }],
];
const end = (stop = "end_turn"): SseEvent[] => [
  ["message_delta", { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null, stop_details: null }, usage: { output_tokens: 500 } }],
  ["message_stop", { type: "message_stop" }],
];

function sdkClient(responses: Array<() => Response>) {
  const requests: Array<{ body: Record<string, unknown> }> = [];
  const fetchImpl = async (_url: unknown, init?: { body?: unknown }) => {
    requests.push({ body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    const next = responses.shift();
    if (!next) throw new Error("no response queued");
    return next();
  };
  const client = new Anthropic({ apiKey: "test-key", maxRetries: 0, fetch: fetchImpl as unknown as typeof globalThis.fetch });
  return { client, requests };
}

describe("timeout-shorter-than-max-tokens — real SDK stream", () => {
  it("a streamed response is parsed, priced and requested with stream: true", async () => {
    const { client, requests } = sdkClient([() => sse([messageStart, ...text(VALID_TEXT), ...end()])]);
    const res = await createClaudeExtractor(cfg({ client })).extract(input);
    if (!res.ok) throw new Error(`expected ok, got ${res.errorClass} ${res.error}`);
    expect(res.output).toEqual(VALID_OUTPUT);
    expect(res.usage).toMatchObject({ inputTokens: 1000, outputTokens: 500, cacheReadInputTokens: 8000 });
    expect(res.costUsd).toBeGreaterThan(0);
    expect(requests[0]!.body).toMatchObject({ stream: true, max_tokens: 16_000, model: "claude-opus-5" });
  });

  it("invalid JSON text (end_turn) twice → PER_MESSAGE invalid_json, not a thrown SDK parse error", async () => {
    const { client } = sdkClient([() => sse([messageStart, ...text("{not json"), ...end()]), () => sse([messageStart, ...text("still not json"), ...end()])]);
    const res = await createClaudeExtractor(cfg({ client })).extract(input);
    expect(res).toMatchObject({ ok: false, errorClass: "PER_MESSAGE", error: "invalid_json" });
  });

  it("stop_reason max_tokens arrives over the stream → one bump → PER_MESSAGE", async () => {
    const { client, requests } = sdkClient([() => sse([messageStart, ...text('{"message_cla'), ...end("max_tokens")]), () => sse([messageStart, ...text('{"message_cla'), ...end("max_tokens")])]);
    const res = await createClaudeExtractor(cfg({ client })).extract(input);
    expect(res).toMatchObject({ ok: false, errorClass: "PER_MESSAGE", error: "max_tokens" });
    expect(requests.map((r) => r.body.max_tokens)).toEqual([16_000, 32_000]);
  });

  it("an in-stream `event: error` (overloaded) → TRANSIENT, never GLOBAL", async () => {
    const { client } = sdkClient([() => sse([messageStart, ["error", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }]])]);
    const res = await createClaudeExtractor(cfg({ client })).extract(input);
    expect(res).toMatchObject({ ok: false, errorClass: "TRANSIENT", error: "stream:overloaded_error", retryAfterSec: 60 });
  });

  it("a stream that ends before message_stop → TRANSIENT", async () => {
    const { client } = sdkClient([() => sse([messageStart, ...text('{"message_class":"FY')])]);
    const res = await createClaudeExtractor(cfg({ client })).extract(input);
    expect(res).toMatchObject({ ok: false, errorClass: "TRANSIENT", error: "stream_interrupted" });
  });

  it("a connection dropped mid-body → TRANSIENT", async () => {
    const { client } = sdkClient([() => sse([messageStart, ...text("{")], "network")]);
    const res = await createClaudeExtractor(cfg({ client })).extract(input);
    expect(res).toMatchObject({ ok: false, errorClass: "TRANSIENT", error: "stream_interrupted" });
  });

  it("an HTTP 401 before the stream → GLOBAL, as before", async () => {
    const { client } = sdkClient([
      () => new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }), { status: 401, headers: { "content-type": "application/json" } }),
    ]);
    const res = await createClaudeExtractor(cfg({ client })).extract(input);
    expect(res).toMatchObject({ ok: false, errorClass: "GLOBAL", error: "http_401:authentication_error" });
  });
});

// ── Pipeline: repeated deadline overruns are parked; connection timeouts never are ─

describe("timeout-shorter-than-max-tokens — pipeline", () => {
  let t: TestDb;
  let ctx: Awaited<ReturnType<typeof seedOrgUserMailbox>>;
  beforeEach(async () => {
    t = await createTestDb();
    ctx = await seedOrgUserMailbox(t.db);
  });
  afterEach(() => t.close());

  const transient = (error: string): ExtractorResult => ({ ok: false, errorClass: "TRANSIENT", error, retryAfterSec: 30, model: null, stopReason: null, usage: null, costUsd: 0, latencyMs: 5, request: { model: "claude-test" } });

  async function drainRepeatedly(error: string, times: number) {
    const thread = await insertThread(t.db, ctx.mailbox.id);
    const m = await insertMessage(t.db, { mailboxId: ctx.mailbox.id, threadId: thread.id, sortTs: new Date("2026-09-10T08:00:00Z") });
    const clock = testClock("2026-09-10T09:00:00Z");
    const ex = fakeExtractor(() => transient(error));
    for (let i = 0; i < times; i++) {
      await drainMailbox(pipelineDeps(t, ex, clock), ctx.mailbox.id, { fullCycleAt: clock.now() });
      clock.advance(2 * 3600_000); // past any backoff
    }
    return { row: (await t.db.select().from(s.messages).where(eq(s.messages.id, m.id)))[0]!, calls: ex.calls.length };
  }

  it(`${MAX_DEADLINE_ATTEMPTS} deadline overruns → parked “Not analysed” (PER_MESSAGE), the queue moves on`, async () => {
    const { row, calls } = await drainRepeatedly(STREAM_DEADLINE_ERROR, MAX_DEADLINE_ATTEMPTS + 2);
    expect(calls).toBe(MAX_DEADLINE_ATTEMPTS);
    expect(row).toMatchObject({ state: "failed", lastError: `PER_MESSAGE: ${STREAM_DEADLINE_ERROR}_repeated` });
  });

  it("connection/header timeouts (an outage) keep the message at the head, never parked", async () => {
    const { row, calls } = await drainRepeatedly("timeout", MAX_DEADLINE_ATTEMPTS + 2);
    expect(calls).toBe(MAX_DEADLINE_ATTEMPTS + 2);
    expect(row.state).toBe("pending");
  });
});

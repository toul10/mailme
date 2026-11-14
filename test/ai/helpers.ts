import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessage, BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { ClaudeRequestOptions } from "../../src/ai/claude.js";
import type { ExtractionInput, ParticipantRef, Segment, TaskCard } from "../../src/domain/types.js";
import type { ExtractionOutput } from "../../src/ai/schema.js";

const ZONE = "Europe/Athens";

export function participant(handle: ParticipantRef["handle"], over: Partial<ParticipantRef> = {}): ParticipantRef {
  const isOwner = handle === "P1";
  return {
    handle,
    address: isOwner ? "ilias@contoso.example" : `p${handle.slice(1)}@client${handle.slice(1)}.gr`,
    name: isOwner ? "Ηλίας Αλεξίου" : `Επαφή ${handle}`,
    isOwner,
    isInternal: isOwner,
    company: isOwner ? "Contoso" : `Πελάτης ${handle}`,
    roles: [],
    ...over,
  };
}

export function segment(id: string, kind: Segment["kind"], text: string, anchor: string | null = null, author: string | null = null): Segment & { anchor: string | null } {
  return { id, kind, text, author, date: null, truncated: false, anchor };
}

export function taskCard(handle: TaskCard["handle"], over: Partial<TaskCard> = {}): TaskCard {
  return {
    handle,
    scope: "THREAD_OPEN",
    title: "Προσφορά για ηχεία",
    status: "ACTION_REQUIRED",
    ownerHandle: "P1",
    counterpartyHandle: "P2",
    company: "ABC",
    dueDate: null,
    duePhrase: null,
    items: [],
    originEvidence: null,
    originDate: null,
    lastEvent: null,
    lastEventDate: null,
    closedBy: null,
    ...over,
  };
}

/** A small valid ExtractionInput; override any part. */
export function makeInput(over: { message?: Partial<ExtractionInput["message"]> } & Partial<Omit<ExtractionInput, "message">> = {}): ExtractionInput {
  const { message, ...rest } = over;
  return {
    owner: { name: "Ηλίας Αλεξίου", address: "ilias@contoso.example", aliases: [], internalDomains: ["contoso.example"] },
    zone: ZONE,
    participants: [participant("P1", { roles: ["to"] }), participant("P2", { roles: ["from"], company: "ABC Α.Ε.", address: "g@abc-gr.example", name: "Γιώργος" })],
    taskCards: [],
    threadDigest: [],
    lowLinkConfidence: false,
    ...rest,
    message: {
      direction: "INBOUND",
      sentAnchor: "Tuesday 2026-09-15 10:12 (Europe/Athens)",
      subject: "Προσφορά",
      fromHandle: "P2",
      toHandles: ["P1"],
      ccHandles: [],
      attachments: [],
      segments: [segment("S1", "NEW", "Καλημέρα, μπορείτε να μας στείλετε προσφορά μέχρι την Παρασκευή;", "Tuesday 2026-09-15 10:12 (Europe/Athens)")],
      calendar: null,
      late: false,
      ...message,
    },
  };
}

export const VALID_OUTPUT: ExtractionOutput = {
  message_class: "ACTIONABLE",
  suspicious_instructions: false,
  operations: [
    {
      op: "COMPLETE",
      task: "K1",
      evidence: { source: "NEW", segment_id: "S1", quote: "Σας επισυνάπτω την προσφορά" },
      certainty: "EXPLICIT",
      confidence: 0.95,
      reason: "sent",
    },
  ],
};

type Content = BetaMessage["content"];

/** A BetaMessage as the API would return it (non-streaming). */
export function betaMessage(over: { content?: Content; text?: string; stop_reason?: BetaMessage["stop_reason"]; model?: string; usage?: Partial<BetaMessage["usage"]>; stop_details?: unknown } = {}): BetaMessage {
  const content: Content = over.content ?? [{ type: "text", text: over.text ?? JSON.stringify(VALID_OUTPUT), citations: null }];
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    container: null,
    context_management: null,
    diagnostics: null,
    model: over.model ?? "claude-opus-5",
    content,
    stop_reason: over.stop_reason === undefined ? "end_turn" : over.stop_reason,
    stop_sequence: null,
    stop_details: (over.stop_details ?? null) as BetaMessage["stop_details"],
    usage: {
      input_tokens: 1000,
      output_tokens: 500,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 8000,
      cache_creation: null,
      fallback_credit: null,
      inference_geo: "us",
      iterations: null,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: "standard",
      speed: null,
      ...over.usage,
    } as BetaMessage["usage"],
  } as BetaMessage;
}

/** A failure after the stream connected (headers received), optionally with the partial message accumulated so far. */
export class MidStream {
  constructor(
    readonly error: Error,
    readonly partial: BetaMessage | null = null,
  ) {}
}

/** Never finishes on its own: connects, then waits until the request's abort signal fires (the generation deadline). */
export class Hang {
  constructor(readonly partial: BetaMessage | null = null) {}
}

/**
 * Fake SDK client (`beta.messages.stream(...).finalMessage()`): returns or throws the queued responses in order and
 * records every call. An Error is thrown before "connect" (HTTP error, connection failure); a {@link MidStream} after it.
 */
export function fakeClient(queue: Array<BetaMessage | Error | MidStream | Hang>) {
  const calls: Array<{ params: BetaMessageStreamParams; options: ClaudeRequestOptions | undefined }> = [];
  const client = {
    beta: {
      messages: {
        stream(params: BetaMessageStreamParams, options?: ClaudeRequestOptions) {
          calls.push({ params: structuredClone(params), options: options && { ...options } });
          const next = queue.shift();
          let onConnect: (() => void) | null = null;
          let current: BetaMessage | undefined;
          return {
            on(event: "connect", listener: () => void) {
              if (event === "connect") onConnect = listener;
              return this;
            },
            get currentMessage() {
              return current;
            },
            async finalMessage(): Promise<BetaMessage> {
              await Promise.resolve();
              if (!next) throw new Error("fake client: no queued response");
              if (next instanceof Error) throw next;
              onConnect?.();
              if (next instanceof MidStream) {
                current = next.partial ?? undefined;
                throw next.error;
              }
              if (next instanceof Hang) {
                current = next.partial ?? undefined;
                const signal = options?.signal;
                await new Promise<void>((resolve) => (signal?.aborted ? resolve() : signal?.addEventListener("abort", () => resolve(), { once: true })));
                throw new Anthropic.APIUserAbortError();
              }
              return next;
            },
          };
        },
      },
    },
  };
  return { client, calls };
}

/**
 * One invented email for checking an AI configuration end to end (`pnpm cli ai:check`): the key, the billing behind
 * it, the model id, the JSON schema and the shape of the answer. A wrong one of these fails the first real message
 * with a GLOBAL error, which pauses AI for every mailbox: better found here, before any mail is read.
 *
 * Nobody in it is real (example.* addresses). A customer asks for a quote by Friday; the answer should create one
 * task for the owner.
 */
import type { AiUsage, ExtractionInput, Extractor, ExtractorErrorClass } from "../domain/types.js";
import { AI_PROVIDER_LABELS, type AiProvider } from "./providers.js";

const SENT = "Tuesday 2026-09-15 10:12 (Europe/Athens)";

export const PROBE_INPUT: ExtractionInput = {
  owner: { name: "Maria Sample", address: "maria@example.com", aliases: [], internalDomains: ["example.com"] },
  zone: "Europe/Athens",
  participants: [
    { handle: "P1", address: "maria@example.com", name: "Maria Sample", isOwner: true, isInternal: true, company: "Example", roles: ["to"] },
    { handle: "P2", address: "george@example.org", name: "George Placeholder", isOwner: false, isInternal: false, company: "Placeholder Ltd", roles: ["from"] },
  ],
  taskCards: [],
  threadDigest: [],
  lowLinkConfidence: false,
  message: {
    direction: "INBOUND",
    sentAnchor: SENT,
    subject: "Quote for speakers",
    fromHandle: "P2",
    toHandles: ["P1"],
    ccHandles: [],
    attachments: [],
    segments: [
      {
        id: "S1",
        kind: "NEW",
        text: "Good morning, could you please send us a quote for 4 speakers by Friday? Thank you, George",
        author: null,
        date: null,
        truncated: false,
        anchor: SENT,
      },
    ],
    calendar: null,
    late: false,
  },
};

export interface ProbeReport {
  ok: boolean;
  extractor: string;
  pipelineVersion: string;
  /** The model that answered, as the provider names it. */
  model: string | null;
  messageClass: string | null;
  /** The operations of the answer, by name ("CREATE", …). */
  operations: string[];
  /** The answer is the expected one: ACTIONABLE with exactly one new task. */
  asExpected: boolean;
  errorClass: ExtractorErrorClass | null;
  /** Status and code only, as the extractor reports it (never a provider message). */
  error: string | null;
  usage: AiUsage | null;
  costUsd: number;
  latencyMs: number;
}

/** One call with {@link PROBE_INPUT}. Never throws for a provider failure: the report carries it. */
export async function probeExtractor(extractor: Extractor): Promise<ProbeReport> {
  const res = await extractor.extract(PROBE_INPUT);
  const base = { extractor: extractor.name, pipelineVersion: extractor.pipelineVersion, model: res.model, usage: res.usage, costUsd: res.costUsd, latencyMs: res.latencyMs };
  if (!res.ok) return { ...base, ok: false, messageClass: null, operations: [], asExpected: false, errorClass: res.errorClass, error: res.error };
  const operations = res.output.operations.map((o) => o.op);
  return {
    ...base,
    ok: true,
    messageClass: res.output.message_class,
    operations,
    asExpected: res.output.message_class === "ACTIONABLE" && operations.length === 1 && operations[0] === "CREATE",
    errorClass: null,
    error: null,
  };
}

/**
 * What an operator should do about a failed check, from the error tag alone ("http_<status>:<code>" in every
 * adapter). `provider` only names the service in the text. Null: no specific advice.
 */
export function probeAdvice(error: string | null, provider: AiProvider | null = null): string | null {
  const e = error ?? "";
  const who = provider ? AI_PROVIDER_LABELS[provider] : "the provider";
  // Billing first: OpenAI and xAI report an empty balance as a 429 with one of these codes.
  if (/^http_402\b|billing|insufficient_quota|credit_balance|spend_limit|usage_limit/.test(e)) {
    return provider === "gemini"
      ? "The prepaid credits of the Gemini billing account are used up: buy credits in AI Studio (Billing). The queue continues by itself afterwards."
      : `The account at ${who} has no credit left or reached its spending limit: fix the billing there, then run \`pnpm cli ai:resume\`.`;
  }
  if (/API_KEY_|^http_401\b|authentication_error|invalid_api_key/.test(e)) return `${who} refuses the API key: check that the stored key is the right one and is not restricted or deleted (Admin → AI).`;
  if (/^http_404\b|model_not_found/.test(e)) return `${who} does not know this model id: choose a model from the list in Admin → AI.`;
  if (/^http_403\b/.test(e)) return `${who} refuses this account or project (permission, billing or region): check it in the provider's console.`;
  if (/^http_(400|422)\b/.test(e)) return `${who} refused the request itself (the JSON schema, the model's settings or another parameter): do not use this configuration for real mail.`;
  if (/^http_429\b/.test(e)) return "Rate limit or quota: try again later; if it persists, check the account's limits.";
  if (/^schema_invalid|^invalid_json|^no_text/.test(e)) return "The model answered, but not in the required shape: this model does not follow the schema reliably.";
  if (/^max_tokens|^finish:MAX_TOKENS/.test(e)) return "The answer did not fit in AI_MAX_TOKENS (thinking counts too): lower the thinking level or raise AI_MAX_TOKENS.";
  if (/^(connection|timeout|aborted)$/.test(e)) return `${who} could not be reached from this machine: check the network, then try again.`;
  return null;
}

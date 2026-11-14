import { forwardRuleFor, mentionsTopic, topicText, type MailRule } from "../domain/rules.js";
import type { ExtractionInput, Extractor, ExtractorResult } from "../domain/types.js";
import { stripSubjectPrefixes } from "../mail/subject.js";
import { OUTPUT_LIMITS, type ExtractionOutput } from "./schema.js";

/**
 * The owner's forward rule (src/domain/rules.ts), in front of the real extractor: a new inbound mail from a known
 * external sender whose subject is about the rule's topics, with the rule's target in neither To nor Cc, becomes one
 * task “Forward to <target>: <subject>” and never reaches the AI (an order is never the owner's task, only passing
 * it on is). Everything else goes to the wrapped extractor unchanged.
 *
 * The output goes through the normal reconcile/apply path. Its evidence is the new text's line about the topic (or
 * its first line), verbatim; only a mail with no new text falls back to the subject, which the reconciler sends to
 * review. Same pipelineVersion as the wrapped extractor: the result is told apart by model "rules".
 */
export function withMailRules(inner: Extractor): Extractor {
  return {
    name: inner.name,
    pipelineVersion: inner.pipelineVersion,
    async extract(input) {
      const rule = forwardDecision(input);
      return rule ? forwardResult(input, rule) : inner.extract(input);
    },
  };
}

/** The forward rule this message falls under, if any. */
export function forwardDecision(input: ExtractionInput): MailRule | null {
  const r = input.rules;
  if (!r || input.message.direction !== "INBOUND" || !r.external || r.reply || !r.senderKnown) return null;
  return forwardRuleFor(r.list, { subject: input.message.subject, recipients: r.recipients });
}

function forwardResult(input: ExtractionInput, rule: MailRule): ExtractorResult {
  const target = rule.target!;
  const subject = input.message.subject;
  const base = stripSubjectPrefixes(subject).base || subject;
  const owner = "P1" as const;
  const addressee = input.message.toHandles.includes(owner) ? "OWNER_TO" : input.message.ccHandles.includes(owner) ? "OWNER_CC" : "OTHER";
  const counterparty = input.message.fromHandle === "OTHER" ? null : input.message.fromHandle;
  const output: ExtractionOutput = {
    message_class: "ACTIONABLE",
    suspicious_instructions: false,
    operations: [
      {
        op: "CREATE",
        title: cap(`Forward to ${target}: ${base}`, OUTPUT_LIMITS.maxTitle),
        status: "ACTION_REQUIRED",
        owner,
        counterparty,
        company: null,
        items: [],
        due: null,
        expect_reply: null,
        priority: "NORMAL",
        next_action: cap(`Forward the email to ${target}`, OUTPUT_LIMITS.maxNextAction),
        summary: cap(`${target} was not among the recipients (rule “${rule.text}”).`, OUTPUT_LIMITS.maxSummary),
        addressee,
        evidence: evidenceFor(input, rule),
        certainty: "EXPLICIT",
        confidence: 1,
        reason: `owner rule ${rule.id}: subject about ${rule.topics!.join("/")} without ${target} in To/Cc`,
      },
    ],
  };
  return {
    ok: true,
    output,
    model: "rules",
    stopReason: "rule",
    usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    costUsd: 0,
    latencyMs: 0,
    request: { extractor: "rules", rule: rule.id },
  };
}

/** A verbatim line of the first NEW segment: the one about the rule's topics, else the first non-empty one. */
function evidenceFor(input: ExtractionInput, rule: MailRule): ExtractionOutput["operations"][number]["evidence"] {
  const seg = input.message.segments.find((sg) => sg.kind === "NEW" && sg.text.trim());
  const lines = seg ? seg.text.split("\n").map((l) => l.trim()).filter((l) => l.length >= 3) : [];
  const line = lines.find((l) => mentionsTopic(topicText(l), rule.topics)) ?? lines[0];
  if (!seg || !line) return { source: "SUBJECT", segment_id: null, quote: input.message.subject };
  return { source: "NEW", segment_id: seg.id, quote: line.slice(0, 300).trimEnd() };
}

function cap(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

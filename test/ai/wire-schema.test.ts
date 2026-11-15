import { describe, expect, it } from "vitest";
import { extractionOutputFormat } from "../../src/ai/claude.js";
import { portableExtractionSchema } from "../../src/ai/portable-schema.js";
import { PROMPT_EXAMPLES } from "../../src/ai/prompt-examples.js";
import { type ExtractionOutput, ExtractionWire, fromWire, NONE, type Operation, parseWireOutput, toWire, type WireDueSpec } from "../../src/ai/schema.js";
import { VALID_OUTPUT } from "./helpers.js";

type Json = Record<string, unknown>;

/**
 * Union-typed, null-typed and optional properties anywhere in a JSON schema. Structured outputs compile the schema
 * into a grammar; unions and optional properties multiply its size, and the Claude API rejected the contract's own
 * schema (dozens of nullable fields inside a 5-way union) as "The compiled grammar is too large".
 */
function census(node: unknown, at = "#", acc = { unions: [] as string[], nulls: [] as string[], optional: [] as string[] }) {
  if (Array.isArray(node)) {
    node.forEach((n, i) => census(n, `${at}/${i}`, acc));
    return acc;
  }
  if (!node || typeof node !== "object") return acc;
  const o = node as Json;
  if (Array.isArray(o.anyOf) || Array.isArray(o.oneOf) || Array.isArray(o.type)) acc.unions.push(at);
  if (o.type === "null") acc.nulls.push(at);
  if (o.properties && typeof o.properties === "object") {
    const required = new Set((o.required as string[] | undefined) ?? []);
    for (const k of Object.keys(o.properties as Json)) if (!required.has(k)) acc.optional.push(`${at}/properties/${k}`);
  }
  for (const [k, v] of Object.entries(o)) census(v, `${at}/${k}`, acc);
  return acc;
}

const KIND_ORDER: Operation["op"][] = ["CREATE", "UPDATE", "COMPLETE", "REOPEN", "SUGGEST_DISMISS"];
/** The contract with its operations in fromWire's order (a stable sort keeps the order within a kind). */
const canonical = (out: ExtractionOutput): ExtractionOutput => ({ ...out, operations: [...out.operations].sort((a, b) => KIND_ORDER.indexOf(a.op) - KIND_ORDER.indexOf(b.op)) });

const NO_DUE: WireDueSpec = { phrase: "", kind: NONE, absolute_date: "", weekday: NONE, amount: 0, segment_id: "", model_date: "" };
const evidence = { source: "NEW" as const, segment_id: "S1", quote: "Θα σας στείλω την προσφορά" };
const wire = (over: Partial<ExtractionWire> = {}): ExtractionWire => ({
  message_class: "ACTIONABLE",
  suspicious_instructions: false,
  create: [],
  update: [],
  complete: [],
  reopen: [],
  suggest_dismiss: [],
  ...over,
});

describe("wire schema (what every provider is asked to return)", () => {
  const schemas: Array<[string, unknown]> = [
    ["Claude default (SDK helper)", extractionOutputFormat(false).schema],
    ["Claude strict enums", extractionOutputFormat(true).schema],
    ["OpenAI / Grok / Gemini (portable)", portableExtractionSchema()],
  ];

  for (const [name, schema] of schemas) {
    it(`${name}: no union, no null type, no optional property`, () => {
      expect(census(schema)).toEqual({ unions: [], nulls: [], optional: [] });
    });
  }

  it("round-trips every prompt example and the test fixture (up to operation order)", () => {
    for (const out of [VALID_OUTPUT, ...PROMPT_EXAMPLES.map((e) => e.output)]) {
      const w = toWire(out);
      expect(ExtractionWire.safeParse(w).success).toBe(true);
      expect(fromWire(w)).toEqual(canonical(out));
      expect(parseWireOutput(JSON.parse(JSON.stringify(w)))).toEqual({ ok: true, output: canonical(out) });
    }
  });

  it("maps every empty wire value to the contract's null", () => {
    const out = fromWire(
      wire({
        create: [
          {
            title: "Quote for 40 ceiling speakers",
            status: "WAITING_FOR_ME",
            owner: NONE,
            counterparty: NONE,
            company: "  ",
            items: [],
            due: NO_DUE,
            expect_reply: { ...NO_DUE, phrase: "την Παρασκευή", kind: "WEEKDAY", weekday: "FRI", amount: 3, segment_id: "S1" },
            priority: "NORMAL",
            next_action: "",
            summary: "s",
            addressee: "OWNER_TO",
            evidence: { ...evidence, source: "SUBJECT", segment_id: "" },
            certainty: "EXPLICIT",
            confidence: 0.9,
            reason: "r",
          },
        ],
        update: [
          {
            task: "K1",
            changes: { status: NONE, due: { ...NO_DUE, phrase: "σήμερα", kind: "RELATIVE_DAYS", amount: 0, segment_id: "S1", model_date: "2026-09-14" }, expect_reply: NO_DUE, priority: NONE, next_action: "", summary: "", add_items: ["cables"] },
            evidence,
            certainty: "EXPLICIT",
            confidence: 0.8,
            reason: "r",
          },
        ],
      }),
    );
    const [create, update] = out.operations;
    expect(create).toMatchObject({ op: "CREATE", owner: null, counterparty: null, company: null, due: null, next_action: null, evidence: { source: "SUBJECT", segment_id: null } });
    // A kind without an amount drops the model's stray amount; empty strings become null.
    expect(create!.op === "CREATE" && create!.expect_reply).toEqual({ phrase: "την Παρασκευή", kind: "WEEKDAY", absolute_date: null, weekday: "FRI", amount: null, segment_id: "S1", model_date: null });
    // A counted kind keeps 0 ("today").
    expect(update).toMatchObject({ op: "UPDATE", task: "K1", changes: { status: null, priority: null, next_action: null, summary: null, expect_reply: null, add_items: ["cables"], due: { kind: "RELATIVE_DAYS", amount: 0 } } });
  });

  it("orders operations by kind and keeps the order within a kind", () => {
    const t = (task: "K1" | "K2") => ({ task, evidence, certainty: "EXPLICIT" as const, confidence: 0.9, reason: "r" });
    const out = fromWire(wire({ suggest_dismiss: [t("K1")], complete: [t("K2"), t("K1")] }));
    expect(out.operations.map((o) => [o.op, "task" in o ? o.task : null])).toEqual([
      ["COMPLETE", "K2"],
      ["COMPLETE", "K1"],
      ["SUGGEST_DISMISS", "K1"],
    ]);
  });

  it("rejects the contract's own shape on the wire, naming issue paths only", () => {
    const res = parseWireOutput(VALID_OUTPUT);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/^schema_invalid:/);
    expect(res.error).not.toContain("Σας επισυνάπτω");
    const secret = parseWireOutput({ ...wire(), message_class: "SECRET-CONTENT" });
    expect(secret).toEqual({ ok: false, error: "schema_invalid:message_class:invalid_value" });
  });
});

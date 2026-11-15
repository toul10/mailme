/**
 * The extraction schema in the subset every non-Claude provider accepts as-is:
 * - OpenAI strict structured outputs: root object, every property required, closed objects, anyOf/$defs/$ref,
 *   no allOf;
 * - xAI (Grok): the same, plus const (rewritten anyway);
 * - Gemini `responseJsonSchema`: no const and no allOf, and a `$ref` node may carry only `$` keys.
 *
 * It starts from the schema Claude uses with AI_STRICT_ENUMS: the wire format (ExtractionWire, no unions) through
 * z.toJSONSchema + strictifyJsonSchema, which keeps enum/const, closes every object and drops numeric/length/pattern
 * constraints (the reconciler enforces those). It then rewrites `const: v` as `enum: [v]` and refuses anything
 * outside the subset. The zod schema re-validates every response.
 */
import { z } from "zod";
import { ExtractionWire } from "./schema.js";
import { strictifyJsonSchema } from "./strict-schema.js";

type Json = Record<string, unknown>;

/** Keywords outside the common subset: building the schema fails if one survives strictification. */
const UNPORTABLE = new Set(["allOf", "oneOf", "not", "if", "then", "else", "dependentRequired", "dependentSchemas"]);

let cached: Json | null = null;

export function portableExtractionSchema(): Json {
  cached ??= buildPortableSchema(z.toJSONSchema(ExtractionWire, { reused: "ref" }) as Json);
  return cached;
}

/** Exported for tests: the rewrite on any JSON schema. */
export function buildPortableSchema(source: Json): Json {
  const out = portable(strictifyJsonSchema(source), "#");
  if (out.type !== "object") throw new Error("portable schema: the root must be an object");
  return out;
}

function portable(node: Json, at: string): Json {
  // A reference node keeps only its `$` keys (Gemini rejects siblings of $ref).
  if (typeof node.$ref === "string") return Object.fromEntries(Object.entries(node).filter(([k]) => k.startsWith("$")));
  const out: Json = {};
  for (const [key, value] of Object.entries(node)) {
    if (UNPORTABLE.has(key)) throw new Error(`portable schema: unsupported keyword "${key}" at ${at}`);
    switch (key) {
      case "const":
        if (node.enum === undefined) out.enum = [value];
        break;
      case "properties":
      case "$defs":
        out[key] = Object.fromEntries(Object.entries(value as Record<string, Json>).map(([name, s]) => [name, portable(s, `${at}/${key}/${name}`)]));
        break;
      case "items":
        out.items = portable(value as Json, `${at}/items`);
        break;
      case "anyOf":
        out.anyOf = (value as Json[]).map((s, i) => portable(s, `${at}/anyOf/${i}`));
        break;
      default:
        // type, enum, description, title, required, additionalProperties, minItems, format: plain values.
        out[key] = value;
    }
  }
  return out;
}

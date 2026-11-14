/**
 * JSON-schema strictifier for structured outputs (AI_STRICT_ENUMS=true).
 *
 * The SDK's `zodOutputFormat` moves `enum`/`const` into descriptions. This variant keeps them, and otherwise
 * reduces the schema to what structured outputs accepts: every object closed (`additionalProperties: false`)
 * with all properties required, `oneOf` → `anyOf`, and numeric/length/pattern constraints dropped (the
 * reconciler enforces those).
 */

type Json = Record<string, unknown>;

const SUPPORTED_STRING_FORMATS = new Set(["date-time", "time", "date", "duration", "email", "hostname", "uri", "ipv4", "ipv6", "uuid"]);

/** Keys copied through unchanged when present. */
const PASSTHROUGH = ["type", "enum", "const", "description", "title"] as const;

export function strictifyJsonSchema(schema: Json): Json {
  return strictify(structuredClone(schema));
}

function strictify(node: Json): Json {
  const out: Json = {};

  if (node.$defs && typeof node.$defs === "object") {
    out.$defs = Object.fromEntries(Object.entries(node.$defs as Record<string, Json>).map(([k, v]) => [k, strictify(v)]));
  }
  if (typeof node.$ref === "string") {
    out.$ref = node.$ref;
    return out;
  }

  const variants = (node.anyOf ?? node.oneOf) as Json[] | undefined;
  if (Array.isArray(variants)) out.anyOf = variants.map((v) => strictify(v));
  if (Array.isArray(node.allOf)) out.allOf = (node.allOf as Json[]).map((v) => strictify(v));

  for (const key of PASSTHROUGH) {
    if (node[key] !== undefined) out[key] = node[key];
  }

  const types = Array.isArray(node.type) ? (node.type as string[]) : typeof node.type === "string" ? [node.type] : [];

  if (types.includes("object") || node.properties) {
    const props = (node.properties ?? {}) as Record<string, Json>;
    out.properties = Object.fromEntries(Object.entries(props).map(([k, v]) => [k, strictify(v)]));
    out.required = Object.keys(props);
    out.additionalProperties = false;
  }
  if (types.includes("array") && node.items && typeof node.items === "object") {
    out.items = strictify(node.items as Json);
    if (node.minItems === 0 || node.minItems === 1) out.minItems = node.minItems;
  }
  if (types.includes("string") && typeof node.format === "string" && SUPPORTED_STRING_FORMATS.has(node.format)) {
    out.format = node.format;
  }

  // `$schema` and every other keyword (minimum, maximum, minLength, pattern, default, …) are dropped.
  return out;
}

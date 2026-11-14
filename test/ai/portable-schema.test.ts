import { describe, expect, it } from "vitest";
import { buildPortableSchema, portableExtractionSchema } from "../../src/ai/portable-schema.js";

type Json = Record<string, unknown>;

/** Every schema node (objects inside properties, $defs, items, anyOf), with its path. */
function nodes(root: Json): Array<[string, Json]> {
  const out: Array<[string, Json]> = [];
  const walk = (n: Json, at: string) => {
    out.push([at, n]);
    for (const key of ["properties", "$defs"] as const) {
      const map = n[key] as Record<string, Json> | undefined;
      if (map) for (const [name, s] of Object.entries(map)) walk(s, `${at}/${key}/${name}`);
    }
    if (n.items && typeof n.items === "object") walk(n.items as Json, `${at}/items`);
    if (Array.isArray(n.anyOf)) (n.anyOf as Json[]).forEach((s, i) => walk(s, `${at}/anyOf/${i}`));
  };
  walk(root, "#");
  return out;
}

describe("portableExtractionSchema", () => {
  const schema = portableExtractionSchema();
  const all = nodes(schema);

  it("is built once", () => {
    expect(portableExtractionSchema()).toBe(schema);
  });

  it("has an object root with the three output fields", () => {
    expect(schema.type).toBe("object");
    expect(Object.keys(schema.properties as Json)).toEqual(["message_class", "suspicious_instructions", "operations"]);
  });

  it("keeps no keyword outside the common subset, anywhere", () => {
    const text = JSON.stringify(schema);
    for (const k of ["const", "allOf", "oneOf", "not", "if", "then", "else", "dependentRequired", "dependentSchemas"]) {
      expect(text, k).not.toContain(`"${k}":`);
    }
  });

  it("writes the operation literals as one-value enums", () => {
    const enums = all.map(([, n]) => n.enum).filter(Array.isArray) as unknown[][];
    for (const op of ["CREATE", "UPDATE", "COMPLETE", "REOPEN", "SUGGEST_DISMISS"]) expect(enums).toContainEqual([op]);
  });

  it("gives $ref nodes no siblings, and every $ref resolves to a $defs entry", () => {
    const defs = schema.$defs as Json;
    const refs = all.filter(([, n]) => typeof n.$ref === "string");
    expect(refs.length).toBeGreaterThan(0);
    for (const [at, n] of refs) {
      expect(Object.keys(n).every((k) => k.startsWith("$")), at).toBe(true);
      const name = String(n.$ref).replace(/^#\/\$defs\//, "");
      expect(defs[name], at).toBeDefined();
    }
  });

  it("closes every object and requires every property (OpenAI strict mode)", () => {
    const objects = all.filter(([, n]) => n.type === "object");
    expect(objects.length).toBeGreaterThan(3);
    for (const [at, n] of objects) {
      expect(n.additionalProperties, at).toBe(false);
      expect([...((n.required as string[]) ?? [])].sort(), at).toEqual(Object.keys((n.properties as Json) ?? {}).sort());
    }
  });
});

describe("buildPortableSchema", () => {
  it("rewrites const as a one-value enum, keeps an existing enum, and strips $ref siblings", () => {
    const out = buildPortableSchema({
      type: "object",
      properties: {
        k: { type: "string", const: "X" },
        e: { enum: ["Y"], const: "Y" },
        r: { $ref: "#/$defs/A", description: "dropped" },
        list: { type: "array", items: { anyOf: [{ const: "P" }, { type: "null" }] } },
      },
      required: ["k", "e", "r", "list"],
      $defs: { A: { type: "string" } },
    });
    const props = out.properties as Record<string, Json>;
    expect(props.k).toEqual({ type: "string", enum: ["X"] });
    expect(props.e).toEqual({ enum: ["Y"] });
    expect(props.r).toEqual({ $ref: "#/$defs/A" });
    expect(props.list).toEqual({ type: "array", items: { anyOf: [{ enum: ["P"] }, { type: "null" }] } });
  });

  it("refuses allOf (strictification keeps it; OpenAI strict mode and Gemini do not take it)", () => {
    expect(() => buildPortableSchema({ type: "object", properties: { a: { allOf: [{ type: "string" }] } }, required: ["a"] })).toThrow('"allOf"');
  });

  it("never emits not / if / then / else (strictification drops them; zod still checks every answer)", () => {
    const out = buildPortableSchema({
      type: "object",
      properties: { a: { type: "string", not: { const: "x" } }, b: { type: "string", if: { const: "y" }, then: { minLength: 1 }, else: { maxLength: 2 } } },
      required: ["a", "b"],
    });
    expect(JSON.stringify(out)).not.toMatch(/"(not|if|then|else)":/);
    expect(out.properties).toEqual({ a: { type: "string" }, b: { type: "string" } });
  });

  it("refuses a root that is not an object", () => {
    expect(() => buildPortableSchema({ type: "string" })).toThrow(/root must be an object/);
  });
});

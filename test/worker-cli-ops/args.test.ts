import { describe, expect, it } from "vitest";
import { formatCommandHelp, parseArgs, UsageError, type OptSpec } from "../../src/cli/args.js";

const spec: Record<string, OptSpec> = {
  user: { type: "string", required: true, description: "user" },
  port: { type: "number", default: 993, description: "port" },
  admin: { type: "boolean", description: "admin" },
  settle: { type: "boolean", default: true, description: "settle" },
  enable: { type: "list", description: "enable" },
  aliases: { type: "csv", description: "aliases" },
};

describe("parseArgs", () => {
  it("parses strings, numbers, booleans, lists and csv", () => {
    const a = parseArgs(["--user", "a@b-gr.example", "--port=143", "--admin", "--enable", "INBOX", "--enable=Sent Items", "--aliases", "x@b-gr.example, y@b-gr.example", "--aliases=z@b-gr.example"], spec);
    expect(a.str("user")).toBe("a@b-gr.example");
    expect(a.num("port")).toBe(143);
    expect(a.bool("admin")).toBe(true);
    expect(a.bool("settle")).toBe(true);
    expect(a.list("enable")).toEqual(["INBOX", "Sent Items"]);
    expect(a.list("aliases")).toEqual(["x@b-gr.example", "y@b-gr.example", "z@b-gr.example"]);
  });

  it("applies defaults, negation and tri-state booleans", () => {
    const a = parseArgs(["--user=u", "--no-settle"], spec);
    expect(a.num("port")).toBe(993);
    expect(a.bool("settle")).toBe(false);
    expect(a.flag("admin")).toBeUndefined();
    expect(parseArgs(["--user=u", "--admin=false"], spec).flag("admin")).toBe(false);
    expect(() => parseArgs(["--user=u", "--admin=maybe"], spec)).toThrow(UsageError);
  });

  it("never lets a boolean swallow a positional; handles -- and positional bounds", () => {
    const pos = { name: "files", min: 1, max: Number.POSITIVE_INFINITY };
    const a = parseArgs(["--user", "u", "--admin", "dir/", "b.eml"], spec, pos);
    expect(a.bool("admin")).toBe(true);
    expect(a.positionals).toEqual(["dir/", "b.eml"]);
    expect(parseArgs(["--user", "u", "--", "--weird-file.eml"], spec, pos).positionals).toEqual(["--weird-file.eml"]);
    expect(() => parseArgs(["--user", "u"], spec, pos)).toThrow(/Missing files/);
    expect(() => parseArgs(["--user", "u", "extra"], spec)).toThrow(/Unexpected argument/);
  });

  it("rejects unknown options, missing values, bad numbers, duplicates and missing required options", () => {
    expect(() => parseArgs(["--user", "u", "--nope"], spec)).toThrow(/Unknown option --nope/);
    expect(() => parseArgs(["--user", "u", "-x"], spec)).toThrow(/Unknown option -x/);
    expect(() => parseArgs(["--user"], spec)).toThrow(/needs a value/);
    expect(() => parseArgs(["--user", "--admin"], spec)).toThrow(/needs a value/);
    expect(() => parseArgs(["--user", "u", "--port", "abc"], spec)).toThrow(/must be a number/);
    expect(() => parseArgs(["--user", "u", "--user", "v"], spec)).toThrow(/more than once/);
    expect(() => parseArgs([], spec)).toThrow(/--user is required/);
    expect(parseArgs(["--help"], spec).help).toBe(true);
    expect(parseArgs(["--user", "u", "--port", "-1"], spec).num("port")).toBe(-1);
  });

  it("formats help", () => {
    const h = formatCommandHelp("mailbox:add", "Connect a mailbox", spec, null);
    expect(h).toContain("pnpm cli mailbox:add [options]");
    expect(h).toMatch(/--user <value>\s+user \(required\)/);
    expect(h).toMatch(/--aliases <value>\s+aliases \(repeatable\)/);
  });
});

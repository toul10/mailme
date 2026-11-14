/**
 * Hand-rolled argument parsing for `pnpm cli <command> [options] [args]`.
 * Options are declared per command, so a boolean flag never swallows the next positional.
 *   --name value | --name=value      string / number
 *   --flag | --no-flag | --flag=false boolean
 *   --opt a --opt b                   list (repeatable)
 *   --opt a,b                         csv (comma-separated, repeatable)
 *   --                                end of options
 */

export type OptType = "string" | "number" | "boolean" | "list" | "csv";

export interface OptSpec {
  type: OptType;
  description: string;
  required?: boolean;
  default?: string | number | boolean;
  /** Placeholder shown in help, e.g. "<email>". */
  arg?: string;
}

export interface PositionalSpec {
  name: string;
  min: number;
  /** Infinity for variadic. */
  max: number;
}

export class UsageError extends Error {}

export class ParsedArgs {
  constructor(
    readonly opts: Record<string, string | number | boolean | string[] | undefined>,
    readonly positionals: string[],
    readonly help: boolean,
  ) {}

  str(name: string): string | undefined {
    const v = this.opts[name];
    return typeof v === "string" ? v : undefined;
  }

  /** A required string option (the parser already enforced `required`; this narrows the type). */
  req(name: string): string {
    const v = this.str(name);
    if (v === undefined || v === "") throw new UsageError(`--${name} is required`);
    return v;
  }

  num(name: string): number | undefined {
    const v = this.opts[name];
    return typeof v === "number" ? v : undefined;
  }

  bool(name: string): boolean {
    return this.opts[name] === true;
  }

  /** undefined when the flag was not given at all (tri-state booleans such as --digest-enabled / --no-digest-enabled). */
  flag(name: string): boolean | undefined {
    const v = this.opts[name];
    return typeof v === "boolean" ? v : undefined;
  }

  list(name: string): string[] {
    const v = this.opts[name];
    return Array.isArray(v) ? v : [];
  }
}

export function parseArgs(argv: string[], options: Record<string, OptSpec>, positional: PositionalSpec | null = null): ParsedArgs {
  const opts: Record<string, string | number | boolean | string[] | undefined> = {};
  const positionals: string[] = [];
  let help = false;
  let onlyPositionals = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (onlyPositionals) {
      positionals.push(arg);
      continue;
    }
    if (arg === "--") {
      onlyPositionals = true;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      let name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
      const inline = eq >= 0 ? arg.slice(eq + 1) : undefined;
      let negated = false;
      if (!options[name] && name.startsWith("no-") && options[name.slice(3)]?.type === "boolean") {
        name = name.slice(3);
        negated = true;
      }
      const spec = options[name];
      if (!spec) throw new UsageError(`Unknown option --${name}`);
      if (spec.type === "boolean") {
        if (negated && inline !== undefined) throw new UsageError(`--no-${name} takes no value`);
        opts[name] = negated ? false : inline === undefined ? true : parseBool(name, inline);
        continue;
      }
      let value = inline;
      if (value === undefined) {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) throw new UsageError(`--${name} needs a value`);
        value = next;
        i++;
      }
      switch (spec.type) {
        case "string":
          if (opts[name] !== undefined) throw new UsageError(`--${name} given more than once`);
          opts[name] = value;
          break;
        case "number": {
          const n = Number(value);
          if (value.trim() === "" || !Number.isFinite(n)) throw new UsageError(`--${name} must be a number`);
          opts[name] = n;
          break;
        }
        case "list":
          opts[name] = [...((opts[name] as string[] | undefined) ?? []), value];
          break;
        case "csv":
          opts[name] = [
            ...((opts[name] as string[] | undefined) ?? []),
            ...value
              .split(",")
              .map((v) => v.trim())
              .filter(Boolean),
          ];
          break;
      }
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1 && !/^-\d/.test(arg)) throw new UsageError(`Unknown option ${arg}`);
    positionals.push(arg);
  }

  if (help) return new ParsedArgs(opts, positionals, true);
  for (const [name, spec] of Object.entries(options)) {
    if (opts[name] === undefined && spec.default !== undefined) opts[name] = spec.default;
    if (spec.required && (opts[name] === undefined || opts[name] === "")) throw new UsageError(`--${name} is required`);
  }
  const min = positional?.min ?? 0;
  const max = positional?.max ?? 0;
  if (positionals.length < min) throw new UsageError(`Missing ${positional?.name ?? "argument"}`);
  if (positionals.length > max) throw new UsageError(`Unexpected argument "${positionals[max]}"`);
  return new ParsedArgs(opts, positionals, false);
}

function parseBool(name: string, v: string): boolean {
  if (/^(true|1|yes|on)$/i.test(v)) return true;
  if (/^(false|0|no|off)$/i.test(v)) return false;
  throw new UsageError(`--${name} must be true or false`);
}

/** Help text for one command. */
export function formatCommandHelp(name: string, summary: string, options: Record<string, OptSpec>, positional: PositionalSpec | null): string {
  const pos = positional ? ` ${positional.min > 0 ? `<${positional.name}>` : `[${positional.name}]`}${positional.max > 1 ? "..." : ""}` : "";
  const lines = [`pnpm cli ${name}${Object.keys(options).length ? " [options]" : ""}${pos}`, "", `  ${summary}`];
  const entries = Object.entries(options);
  if (entries.length) {
    lines.push("", "Options:");
    const left = entries.map(([n, s]) => {
      const argName = s.arg ?? (s.type === "number" ? "<n>" : s.type === "boolean" ? "" : "<value>");
      return `  --${n}${argName ? " " + argName : ""}`;
    });
    const width = Math.max(...left.map((l) => l.length));
    entries.forEach(([, s], i) => {
      const extra = [s.required ? "required" : null, s.type === "list" || s.type === "csv" ? "repeatable" : null, s.default !== undefined ? `default ${String(s.default)}` : null]
        .filter(Boolean)
        .join(", ");
      lines.push(`${left[i]!.padEnd(width)}  ${s.description}${extra ? ` (${extra})` : ""}`);
    });
  }
  return lines.join("\n");
}

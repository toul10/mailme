import type { OptSpec, ParsedArgs, PositionalSpec } from "../args.js";
import type { CliContext } from "../context.js";

export interface Command {
  name: string;
  summary: string;
  options: Record<string, OptSpec>;
  positional?: PositionalSpec;
  /** Returns the process exit code (default 0). */
  run(ctx: CliContext, args: ParsedArgs): Promise<number | void>;
}

export const yesOpt: OptSpec = { type: "boolean", description: "Do not ask for confirmation" };

import { formatCommandHelp, parseArgs, UsageError } from "./args.js";
import { mailboxCommands } from "./commands/mailbox.js";
import { messageCommands } from "./commands/messages.js";
import { opsCommands } from "./commands/ops.js";
import { pipelineCommands } from "./commands/pipeline.js";
import { ruleCommands } from "./commands/rules.js";
import { setupCommands } from "./commands/setup.js";
import type { Command } from "./commands/types.js";
import type { CliContext } from "./context.js";

export const COMMANDS: Command[] = [...setupCommands, ...mailboxCommands, ...pipelineCommands, ...messageCommands, ...ruleCommands, ...opsCommands];

const GROUPS: Array<[string, string[]]> = [
  ["Setup", ["secrets:generate", "keys:generate", "keys:rotate", "db:migrate", "org:create", "user:create", "user:update", "user:mfa-reset"]],
  ["Mailboxes", ["mailbox:add", "mailbox:probe", "mailbox:folders", "mailbox:ingest-token", "mailbox:resume", "ai:resume", "ai:check", "chat:check"]],
  ["Pipeline", ["import:eml", "sync:once", "drain:once", "messages:parked", "messages:retry", "messages:ack", "digest:preview", "digest:send-now"]],
  ["Rules", ["rules:list", "rules:import", "rules:apply"]],
  ["Operations", ["kpi", "audit:sample", "audit:label", "purge:run", "health:run", "backup:dump"]],
];

export function usage(): string {
  const byName = new Map(COMMANDS.map((c) => [c.name, c]));
  const width = Math.max(...COMMANDS.map((c) => c.name.length));
  const lines = ["MailMe CLI — pnpm cli <command> [options]   (pnpm cli <command> --help for its options)"];
  for (const [title, names] of GROUPS) {
    lines.push("", `${title}:`);
    for (const n of names) {
      const c = byName.get(n);
      if (c) lines.push(`  ${c.name.padEnd(width)}  ${c.summary}`);
    }
  }
  return lines.join("\n");
}

/** Parse and run one command. Returns the process exit code; never calls process.exit. */
export async function runCli(argv: string[], ctx: CliContext): Promise<number> {
  const [name, ...rest] = argv;
  if (!name || name === "help" || name === "--help" || name === "-h") {
    ctx.io.out(usage());
    return name ? 0 : 2;
  }
  const cmd = COMMANDS.find((c) => c.name === name);
  if (!cmd) {
    ctx.io.err(`Unknown command "${name}".\n`);
    ctx.io.err(usage());
    return 2;
  }
  try {
    const args = parseArgs(rest, cmd.options, cmd.positional ?? null);
    if (args.help) {
      ctx.io.out(formatCommandHelp(cmd.name, cmd.summary, cmd.options, cmd.positional ?? null));
      return 0;
    }
    return (await cmd.run(ctx, args)) ?? 0;
  } catch (err) {
    if (err instanceof UsageError) {
      ctx.io.err(`${cmd.name}: ${err.message}`);
      ctx.io.err(`Run: pnpm cli ${cmd.name} --help`);
      return 2;
    }
    ctx.io.err(`${cmd.name} failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

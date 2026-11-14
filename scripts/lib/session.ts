/**
 * Runs MailMe CLI commands in-process for the setup and demo scripts: the same commands, options and checks as
 * `pnpm cli …`, one database connection for the whole script, and the output captured when a step needs it.
 */
import { loadConfig, type Config } from "../../src/config.js";
import { defaultServices, type CliContext } from "../../src/cli/context.js";
import type { CliIO } from "../../src/cli/io.js";
import { runCli } from "../../src/cli/run.js";
import { createLogger } from "../../src/lib/log.js";
import { readOpsEnv, type OpsEnv } from "../../src/ops/env.js";
import { createRuntime, type Runtime } from "../../src/worker/runtime.js";

export interface RunResult {
  code: number;
  out: string[];
  err: string[];
}

export interface RunOptions {
  /** Don't print the command's output (it is still returned). Errors are printed unless `quietErrors`. */
  quiet?: boolean;
  quietErrors?: boolean;
  /** Answers for the command's prompts, in order (e.g. a generated password). Other prompts go to the terminal. */
  answers?: string[];
}

export interface Session {
  config(): Config;
  runtime(): Promise<Runtime>;
  /** `argv` is what you would type after `pnpm cli`. */
  run(argv: string[], opts?: RunOptions): Promise<RunResult>;
  close(): Promise<void>;
}

/** Call only after the environment is final (.env loaded): the configuration is read once. */
export function openSession(io: CliIO, env: NodeJS.ProcessEnv = process.env): Session {
  let cfg: Config | null = null;
  let ops: OpsEnv | null = null;
  let runtime: Promise<Runtime> | null = null;
  const config = () => (cfg ??= loadConfig(env));
  const getRuntime = () =>
    (runtime ??= createRuntime(config(), {
      keys: "lazy",
      log: createLogger(/debug|trace/.test(config().LOG_LEVEL) ? config().LOG_LEVEL : "warn", { proc: "setup" }),
    }));

  return {
    config,
    runtime: getRuntime,
    async run(argv, opts = {}) {
      const out: string[] = [];
      const err: string[] = [];
      const answers = [...(opts.answers ?? [])];
      const stepIo: CliIO = {
        out(text) {
          out.push(...text.split("\n"));
          if (!opts.quiet) io.out(text);
        },
        err(text) {
          err.push(...text.split("\n"));
          if (!opts.quietErrors) io.err(text);
        },
        prompt: (question, o) => (answers.length ? Promise.resolve(answers.shift()!) : io.prompt(question, o)),
        confirm: (question) => io.confirm(question),
        close: () => undefined,
      };
      const ctx: CliContext = {
        io: stepIo,
        config,
        tryConfig: () => {
          try {
            return config();
          } catch {
            return null;
          }
        },
        ops: () => (ops ??= readOpsEnv(env)),
        runtime: getRuntime,
        services: defaultServices,
        now: () => new Date(),
      };
      const code = await runCli(argv, ctx);
      return { code, out, err };
    },
    async close() {
      if (runtime) await (await runtime.catch(() => null))?.close();
      runtime = null;
    },
  };
}

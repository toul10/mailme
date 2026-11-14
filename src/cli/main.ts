import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig, type Config } from "../config.js";
import { createLogger } from "../lib/log.js";
import { loadDotEnv, readOpsEnv, type OpsEnv } from "../ops/env.js";
import { createRuntime, type Runtime } from "../worker/runtime.js";
import { defaultServices, type CliContext } from "./context.js";
import { createTerminalIO } from "./io.js";
import { runCli } from "./run.js";

/** `pnpm cli <command>` — see src/cli/run.ts for the command list. */
async function main(): Promise<number> {
  loadDotEnv(".env");
  const io = createTerminalIO();
  let cfg: Config | null = null;
  let ops: OpsEnv | null = null;
  const opened: { runtime: Promise<Runtime> | null } = { runtime: null };
  const config = () => (cfg ??= loadConfig(process.env));
  const ctx: CliContext = {
    io,
    config,
    tryConfig: () => {
      try {
        return config();
      } catch {
        return null;
      }
    },
    ops: () => (ops ??= readOpsEnv(process.env)),
    // CLI output is for humans: library logs stay at warn unless LOG_LEVEL=debug/trace is asked for.
    runtime: () => (opened.runtime ??= createRuntime(config(), { keys: "lazy", log: createLogger(/debug|trace/.test(config().LOG_LEVEL) ? config().LOG_LEVEL : "warn", { proc: "cli" }) })),
    services: defaultServices,
    now: () => new Date(),
  };
  try {
    return await runCli(process.argv.slice(2), ctx);
  } finally {
    io.close();
    if (opened.runtime) await (await opened.runtime.catch(() => null))?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}

import readline from "node:readline";
import { Writable } from "node:stream";

/** Terminal I/O for the CLI. Commands only talk to this interface, so tests can script answers. */
export interface CliIO {
  out(text: string): void;
  err(text: string): void;
  /** Ask for one line. `secret`: nothing is echoed on a TTY (passwords). Piped stdin is read line by line. */
  prompt(question: string, opts?: { secret?: boolean }): Promise<string>;
  /** y/N question (the Greek ν/ναι, "yes", is accepted too). */
  confirm(question: string): Promise<boolean>;
  close(): void;
}

export function isYes(answer: string): boolean {
  return /^(y|yes|ν|ναι)$/i.test(answer.trim());
}

export function createTerminalIO(opts: { input?: NodeJS.ReadableStream & { isTTY?: boolean }; output?: NodeJS.WritableStream; error?: NodeJS.WritableStream } = {}): CliIO {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const error = opts.error ?? process.stderr;
  const tty = Boolean(input.isTTY);
  let muted = false;
  // readline echoes typed characters through its output stream; muting that stream hides a password.
  const echo = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      if (!muted) output.write(chunk);
      cb();
    },
  });

  let rl: readline.Interface | null = null;
  const buffered: string[] = [];
  const waiting: Array<{ resolve(line: string): void; reject(err: Error): void }> = [];
  let closed = false;

  const iface = () => {
    if (rl) return rl;
    rl = readline.createInterface({ input, output: echo, terminal: tty, prompt: "" });
    rl.on("line", (line) => {
      const w = waiting.shift();
      if (w) w.resolve(line);
      else buffered.push(line);
    });
    rl.on("close", () => {
      closed = true;
      for (const w of waiting.splice(0)) w.reject(new Error("input closed"));
    });
    rl.on("SIGINT", () => {
      output.write("\n");
      process.exit(130);
    });
    return rl;
  };

  const readLine = (): Promise<string> => {
    iface();
    const line = buffered.shift();
    if (line !== undefined) return Promise.resolve(line);
    if (closed) return Promise.reject(new Error("input closed"));
    return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
  };

  const io: CliIO = {
    out: (text) => void output.write(text + "\n"),
    err: (text) => void error.write(text + "\n"),
    async prompt(question, o) {
      output.write(question);
      if (o?.secret && tty) muted = true;
      try {
        return await readLine();
      } finally {
        if (muted) {
          muted = false;
          output.write("\n");
        }
      }
    },
    async confirm(question) {
      return isYes(await io.prompt(`${question} [y/N] `));
    },
    close() {
      rl?.close();
    },
  };
  return io;
}

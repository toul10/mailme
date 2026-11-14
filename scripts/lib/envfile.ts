/**
 * A .env file edited line by line, so its comments, order and every value someone already set survive.
 * Parsing follows Node's own loader (process.loadEnvFile), which is what the API, the worker and the CLI use.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const KEY_LINE = (key: string) => new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=(.*)$`);
const COMMENTED_KEY_LINE = (key: string) => new RegExp(`^\\s*#\\s*${key}\\s*=`);

function unquote(raw: string): string {
  const v = raw.trim();
  const q = v[0];
  if ((q === '"' || q === "'" || q === "`") && v.length >= 2) {
    const end = v.indexOf(q, 1);
    if (end > 0) return v.slice(1, end);
  }
  const hash = v.indexOf("#");
  return (hash >= 0 ? v.slice(0, hash) : v).trim();
}

/** Value as written to the file: bare when safe, else double-quoted. Node's loader has no escapes. */
export function formatValue(value: string): string {
  if (/[\r\n"]/.test(value)) throw new Error("A .env value cannot contain a newline or a double quote");
  return /^[A-Za-z0-9_\-+/=.:@,]*$/.test(value) ? value : `"${value}"`;
}

export class EnvFile {
  private lines: string[];
  readonly existed: boolean;

  private constructor(text: string, existed: boolean) {
    this.lines = text.replace(/\r\n/g, "\n").split("\n");
    this.existed = existed;
  }

  /** The file at `path`, or — when there is none yet — a new file that starts from `template`. */
  static open(path: string, template: string): EnvFile {
    return existsSync(path) ? new EnvFile(readFileSync(path, "utf8"), true) : new EnvFile(template, false);
  }

  /** The value of `key`; an empty `KEY=` and a commented-out key both count as unset. */
  get(key: string): string | undefined {
    const re = KEY_LINE(key);
    for (const line of this.lines) {
      const m = line.match(re);
      if (m) {
        const v = unquote(m[1]!);
        return v === "" ? undefined : v;
      }
    }
    return undefined;
  }

  /**
   * Give `key` a value if it has none. A value that is already there is never replaced.
   * Returns "set" or "kept".
   */
  setIfUnset(key: string, value: string): "set" | "kept" {
    if (this.get(key) !== undefined) return "kept";
    const line = `${key}=${formatValue(value)}`;
    const re = KEY_LINE(key);
    const empty = this.lines.findIndex((l) => re.test(l));
    if (empty >= 0) {
      this.lines[empty] = line;
      return "set";
    }
    const commented = this.lines.findIndex((l) => COMMENTED_KEY_LINE(key).test(l));
    if (commented >= 0) {
      this.lines[commented] = line;
      return "set";
    }
    while (this.lines.length && this.lines[this.lines.length - 1] === "") this.lines.pop();
    this.lines.push(line, "");
    return "set";
  }

  /** Set `key`, replacing any value. Only for a file just created from the template, never for someone's own .env. */
  forceSet(key: string, value: string): void {
    const re = KEY_LINE(key);
    const line = `${key}=${formatValue(value)}`;
    const at = this.lines.findIndex((l) => re.test(l));
    if (at >= 0) this.lines[at] = line;
    else this.setIfUnset(key, value);
  }

  /** Write with owner-only permissions (the file holds secrets). */
  save(path: string): void {
    writeFileSync(path, this.lines.join("\n"), { mode: 0o600 });
    chmodSync(path, 0o600); // writeFileSync keeps the mode of an existing file
  }
}

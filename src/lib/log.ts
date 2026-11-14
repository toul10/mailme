import pino from "pino";
import type { Logger } from "../domain/types.js";

/**
 * Structured JSON logs. Allow-list policy: log ids, counts, durations, error codes.
 * Never log bodies, subjects, addresses, prompts or model outputs.
 */
const REDACT = [
  "password",
  "*.password",
  "authorization",
  "*.authorization",
  "cookie",
  "*.cookie",
  "token",
  "*.token",
  "subject",
  "*.subject",
  "body",
  "*.body",
  "text",
  "*.text",
  "html",
  "*.html",
  "quote",
  "*.quote",
  "prompt",
  "*.prompt",
  "output",
  "*.output",
  "from",
  "*.from",
  "to",
  "*.to",
  "address",
  "*.address",
];

export function createLogger(level: string = "info", bindings: object = {}): Logger {
  return pino({ level, redact: { paths: REDACT, censor: "[redacted]" }, base: { svc: "mailme", ...bindings } }) as unknown as Logger;
}

export const nullLogger: Logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child() {
    return nullLogger;
  },
};

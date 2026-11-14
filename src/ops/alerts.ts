import type { Config } from "../config.js";
import type { Logger } from "../domain/types.js";
import { nullLogger } from "../lib/log.js";

/**
 * Operator alerts over a channel independent of the mail server: ntfy (plain-text POST with
 * Title/Priority/Tags headers) when the URL host contains "ntfy", otherwise a generic JSON webhook.
 * Alerts carry ids and counts only — never subjects, addresses or any other email content.
 */

export type AlertSeverity = "critical" | "warning" | "info";

export interface Alert {
  title: string;
  body: string;
  severity: AlertSeverity;
}

export type FetchFn = typeof fetch;

export interface AlertOptions {
  fetch?: FetchFn;
  log?: Logger;
  timeoutMs?: number;
  now?: Date;
}

export interface AlertRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
}

const MAX_TITLE = 200;
const MAX_BODY = 4000;

const NTFY_PRIORITY: Record<AlertSeverity, string> = { critical: "5", warning: "4", info: "3" };
const NTFY_TAGS: Record<AlertSeverity, string> = { critical: "rotating_light", warning: "warning", info: "white_check_mark" };

export function isNtfyUrl(url: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase().includes("ntfy");
  } catch {
    return false;
  }
}

/** RFC 2047 encoded-word for non-ASCII header values (fetch rejects header chars above U+00FF). */
export function encodeHeaderValue(value: string): string {
  const clean = value.replace(/[\r\n\t]+/g, " ").trim();
  return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}

/** Pure request builder (tested for formatting). Credentials embedded in the URL become a Basic header. */
export function buildAlertRequest(rawUrl: string, alert: Alert, now: Date = new Date()): AlertRequest {
  const url = new URL(rawUrl);
  const headers: Record<string, string> = {};
  if (url.username || url.password) {
    const user = decodeURIComponent(url.username);
    const pass = decodeURIComponent(url.password);
    headers["Authorization"] = `Basic ${Buffer.from(`${user}:${pass}`, "utf8").toString("base64")}`;
    url.username = "";
    url.password = "";
  }
  const title = clip(alert.title.replace(/\s+/g, " ").trim(), MAX_TITLE);
  const body = clip(alert.body.trim(), MAX_BODY);
  if (isNtfyUrl(rawUrl)) {
    headers["Content-Type"] = "text/plain; charset=utf-8";
    headers["Title"] = encodeHeaderValue(title);
    headers["Priority"] = NTFY_PRIORITY[alert.severity];
    headers["Tags"] = NTFY_TAGS[alert.severity];
    return { url: url.toString(), method: "POST", headers, body };
  }
  headers["Content-Type"] = "application/json";
  return {
    url: url.toString(),
    method: "POST",
    headers,
    body: JSON.stringify({ source: "mailme", severity: alert.severity, title, body, at: now.toISOString() }),
  };
}

/**
 * Deliver one alert. Never throws. Without ALERT_WEBHOOK_URL the alert goes to the log only (and counts as
 * delivered, so health de-duplication still works on a dev machine).
 */
export async function sendAlert(config: Pick<Config, "ALERT_WEBHOOK_URL">, alert: Alert, opts: AlertOptions = {}): Promise<boolean> {
  const log = opts.log ?? nullLogger;
  if (!config.ALERT_WEBHOOK_URL) {
    log.warn({ severity: alert.severity, alertTitle: alert.title }, "alert (no ALERT_WEBHOOK_URL configured)");
    return true;
  }
  try {
    const req = buildAlertRequest(config.ALERT_WEBHOOK_URL, alert, opts.now);
    const res = await (opts.fetch ?? fetch)(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
    if (!res.ok) {
      log.warn({ status: res.status }, "alert delivery rejected");
      return false;
    }
    return true;
  } catch (err) {
    log.warn({ code: errorCode(err) }, "alert delivery failed");
    return false;
  }
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

/** Error name/code only — error messages can echo URLs with tokens. */
export function errorCode(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { code?: unknown; name?: unknown; cause?: { code?: unknown } };
    if (typeof e.code === "string") return e.code;
    if (e.cause && typeof e.cause.code === "string") return e.cause.code;
    if (typeof e.name === "string") return e.name;
  }
  return "unknown";
}

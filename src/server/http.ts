import type { z } from "zod";
import type { ApiError } from "./api-types.js";

/** Error with an HTTP status and an API error code; the error handler turns it into `ApiError`. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ApiError["code"],
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const badRequest = (msg = "Invalid request") => new HttpError(400, "invalid", msg);
export const unauthorized = (msg = "Please sign in") => new HttpError(401, "unauthorized", msg);
export const mfaRequired = (msg = "A verification code (TOTP) is required") => new HttpError(401, "mfa_required", msg);
export const forbidden = (msg = "Not allowed") => new HttpError(403, "forbidden", msg);
export const notFound = (msg = "Not found") => new HttpError(404, "not_found", msg);
export const conflict = (msg = "This record changed in the meantime — refresh the page") => new HttpError(409, "conflict", msg);
export const rateLimited = (retryAfterSec: number) =>
  new HttpError(429, "rate_limited", "Too many attempts. Try again later.", { "retry-after": String(retryAfterSec) });

export function apiError(code: ApiError["code"], error: string): ApiError {
  return { error, code };
}

/** Parse with zod; any failure is a 400 naming the first offending field (never echoing the value). */
export function parseWith<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const res = schema.safeParse(input ?? {});
  if (res.success) return res.data;
  const issue = res.error.issues[0];
  const where = issue && issue.path.length ? ` (${issue.path.join(".")})` : "";
  throw badRequest(`Invalid data${where}`);
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Route param that must be a uuid; anything else is simply "not found" (no SQL cast errors). */
export function uuidParam(value: unknown): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) throw notFound();
  return value.toLowerCase();
}

/** Path part of a request URL (never log or compare the query string). */
export function pathOf(url: string): string {
  const q = url.indexOf("?");
  return q < 0 ? url : url.slice(0, q);
}

export const isApiPath = (path: string) => path === "/api" || path.startsWith("/api/");
export const isActionPath = (path: string) => path === "/a" || path.startsWith("/a/");

/** Escape a string for use inside a LIKE/ILIKE pattern (default escape character `\`). */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

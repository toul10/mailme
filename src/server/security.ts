import type { FastifyReply } from "fastify";
import type { IncomingHttpHeaders } from "node:http";
import { isActionPath, isApiPath } from "./http.js";

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

/** Headers on every response. One-click pages get `no-referrer` (the URL carries a token). */
export function applySecurityHeaders(reply: FastifyReply, path: string, https: boolean): void {
  reply.header("content-security-policy", CONTENT_SECURITY_POLICY);
  reply.header("x-content-type-options", "nosniff");
  reply.header("x-frame-options", "DENY");
  reply.header("cross-origin-opener-policy", "same-origin");
  reply.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
  if (https) reply.header("strict-transport-security", "max-age=31536000");
  if (isActionPath(path)) {
    reply.header("referrer-policy", "no-referrer");
    reply.header("x-robots-tag", "noindex, nofollow");
  } else {
    reply.header("referrer-policy", "strict-origin-when-cross-origin");
  }
  if (isApiPath(path) || isActionPath(path)) {
    reply.header("cache-control", "no-store");
    reply.header("pragma", "no-cache");
  }
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Same-origin check for state-changing form posts.
 * A page served with `Referrer-Policy: no-referrer` makes browsers send `Origin: null` even for same-origin
 * POSTs, so a null/absent Origin is accepted only with `Sec-Fetch-Site: same-origin` (browser-set, not
 * forgeable by pages) or, for browsers without Fetch Metadata, a same-origin Referer.
 */
export function isSameOriginRequest(headers: IncomingHttpHeaders, appOrigin: string): boolean {
  const origin = typeof headers.origin === "string" ? headers.origin.trim() : "";
  if (origin && origin !== "null") return origin === appOrigin;
  const site = headers["sec-fetch-site"];
  if (typeof site === "string" && site) return site === "same-origin";
  const referer = typeof headers.referer === "string" ? headers.referer : "";
  if (referer) return originOf(referer) === appOrigin;
  return false;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isLocalHttpOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    return u.protocol === "http:" && LOCAL_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

/**
 * Origin check for JSON endpoints without a CSRF token yet (login): a present Origin must be ours.
 * With a plain-http localhost base URL (development) any localhost origin passes, so the Vite dev server's
 * proxy (another port) works.
 */
export function originAllowedIfPresent(headers: IncomingHttpHeaders, appOrigin: string, localDev = false): boolean {
  const origin = typeof headers.origin === "string" ? headers.origin.trim() : "";
  if (!origin) return true;
  if (origin === "null") return headers["sec-fetch-site"] === "same-origin";
  if (origin === appOrigin) return true;
  return localDev && isLocalHttpOrigin(origin);
}

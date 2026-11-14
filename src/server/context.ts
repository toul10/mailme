import type { ServerDeps } from "./app.js";
import type { CookieConfig } from "./auth/sessions.js";
import type { HostResolver } from "./host-policy.js";
import type { RateLimiter } from "./rate-limit.js";

/** Per-server-instance state shared by the route modules (created in buildServer; nothing module-global). */
export interface AppContext {
  deps: ServerDeps;
  limiter: RateLimiter;
  cookies: CookieConfig;
  /** Origin of APP_BASE_URL, e.g. "https://mailme.contoso.example". */
  appOrigin: string;
  https: boolean;
  linkSecret: string;
  /** DNS lookup used by the SSRF guard (ServerDeps.resolveHost or the system resolver). */
  resolveHost: HostResolver;
}

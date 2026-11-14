import type { Clock, Logger } from "../domain/types.js";
import { systemClock } from "../domain/types.js";
import { nullLogger } from "../lib/log.js";
import { errorCode, type FetchFn } from "./alerts.js";

/**
 * External dead-man's switch (e.g. healthchecks.io): pinged after each full sync cycle and each digest
 * delivery. If pings stop, the external service alerts — this covers "the whole Mac/VPS is down".
 */
export interface HealthPinger {
  ping(reason: "cycle" | "digest"): Promise<boolean>;
}

export function createHealthPinger(
  url: string | undefined,
  opts: { fetch?: FetchFn; log?: Logger; clock?: Clock; timeoutMs?: number; minIntervalMs?: number } = {},
): HealthPinger {
  const log = opts.log ?? nullLogger;
  const clock = opts.clock ?? systemClock;
  const minInterval = opts.minIntervalMs ?? 30_000;
  let lastPingAt = Number.NEGATIVE_INFINITY;
  return {
    async ping(reason) {
      if (!url) return false;
      const now = clock.now().getTime();
      // Several mailboxes can finish a cycle within seconds; one ping per window is enough for a dead-man's switch.
      if (reason === "cycle" && now - lastPingAt < minInterval) return false;
      lastPingAt = now;
      try {
        const res = await (opts.fetch ?? fetch)(url, { method: "GET", signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000) });
        if (!res.ok) log.warn({ status: res.status, reason }, "healthcheck ping rejected");
        return res.ok;
      } catch (err) {
        log.warn({ code: errorCode(err), reason }, "healthcheck ping failed");
        return false;
      }
    },
  };
}

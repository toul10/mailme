/**
 * "Check now": start one worker pass (the Cloud Run tick job, src/worker/tick.ts) on demand.
 *
 * The API never syncs a mailbox itself: it cannot open a mailbox password. It only asks Cloud Run to start the job
 * exactly as deployed. Its service account holds roles/run.invoker on that one job, i.e. run.jobs.run, never
 * run.jobs.runWithOverrides, so it cannot change the job's args, env or image (deploy/gcp/40-deploy.sh).
 */
export interface SyncNowTrigger {
  /**
   * Resolves once Cloud Run has accepted the execution. Callers await it before replying: the API runs with
   * request-based CPU, and anything left running after the response is not guaranteed to finish.
   */
  start(): Promise<void>;
}

/** Access tokens of the service's own account, from the Cloud Run metadata server. */
export const METADATA_TOKEN_URL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const TIMEOUT_MS = 10_000;
/** Renew this long before the token expires. */
const TOKEN_MARGIN_MS = 60_000;

export interface CloudRunJobTriggerOptions {
  fetch?: typeof fetch;
  now?: () => number;
}

/** `job` is the full resource name: projects/<project>/locations/<region>/jobs/<job> (config TICK_JOB). */
export function cloudRunJobTrigger(job: string, opts: CloudRunJobTriggerOptions = {}): SyncNowTrigger {
  const fetchFn = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  let token: { value: string; expiresAt: number } | null = null;

  const accessToken = async (): Promise<string> => {
    if (token && token.expiresAt - TOKEN_MARGIN_MS > now()) return token.value;
    const res = await fetchFn(METADATA_TOKEN_URL, { headers: { "metadata-flavor": "Google" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`metadata token: HTTP ${res.status}`);
    const body = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== "string" || !body.access_token) throw new Error("metadata token: no access_token");
    const ttlSec = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 300;
    token = { value: body.access_token, expiresAt: now() + ttlSec * 1000 };
    return token.value;
  };

  return {
    async start() {
      const res = await fetchFn(`https://run.googleapis.com/v2/${job}:run`, {
        method: "POST",
        headers: { authorization: `Bearer ${await accessToken()}`, "content-type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      // The answer is a long-running operation; the execution runs on its own, nothing to wait for here.
      await res.text().catch(() => undefined);
      if (!res.ok) throw new Error(`run job: HTTP ${res.status}`);
    },
  };
}

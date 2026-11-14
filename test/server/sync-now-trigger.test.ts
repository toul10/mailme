import { describe, expect, it, vi } from "vitest";
import { cloudRunJobTrigger, METADATA_TOKEN_URL } from "../../src/server/sync-now.js";

const JOB = "projects/contosot-data/locations/europe-west1/jobs/mailme-tick";

function fakeFetch(opts: { runStatus?: number; tokenStatus?: number } = {}) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  let tokens = 0;
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === METADATA_TOKEN_URL) {
      tokens++;
      return new Response(JSON.stringify({ access_token: `tok-${tokens}`, expires_in: 3600, token_type: "Bearer" }), { status: opts.tokenStatus ?? 200 });
    }
    return new Response(JSON.stringify({ name: "operations/x" }), { status: opts.runStatus ?? 200 });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

describe("cloudRunJobTrigger (src/server/sync-now.ts)", () => {
  it("takes a token from the metadata server, then runs the job as deployed (no overrides)", async () => {
    const f = fakeFetch();
    await cloudRunJobTrigger(JOB, { fetch: f.fn }).start();
    expect(f.calls.map((c) => c.url)).toEqual([METADATA_TOKEN_URL, `https://run.googleapis.com/v2/${JOB}:run`]);
    expect(new Headers(f.calls[0]!.init?.headers).get("metadata-flavor")).toBe("Google");
    const run = f.calls[1]!.init!;
    expect(run.method).toBe("POST");
    expect(new Headers(run.headers).get("authorization")).toBe("Bearer tok-1");
    expect(run.body).toBe("{}");
  });

  it("reuses the token until a minute before it expires", async () => {
    const f = fakeFetch();
    let now = 0;
    const trigger = cloudRunJobTrigger(JOB, { fetch: f.fn, now: () => now });
    await trigger.start();
    now = 3_000_000; // 50 min later: still valid
    await trigger.start();
    now = 3_550_000; // within the last minute of the hour: renewed
    await trigger.start();
    expect(f.calls.filter((c) => c.url === METADATA_TOKEN_URL)).toHaveLength(2);
    expect(new Headers(f.calls.at(-1)!.init?.headers).get("authorization")).toBe("Bearer tok-2");
  });

  it("throws when Cloud Run refuses the run or the metadata server has no token", async () => {
    await expect(cloudRunJobTrigger(JOB, { fetch: fakeFetch({ runStatus: 403 }).fn }).start()).rejects.toThrow("HTTP 403");
    await expect(cloudRunJobTrigger(JOB, { fetch: fakeFetch({ tokenStatus: 404 }).fn }).start()).rejects.toThrow("metadata token");
  });
});

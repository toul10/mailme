import { afterEach, describe, expect, it } from "vitest";
import { makeHarness, type Harness } from "../../server/helpers.js";

/**
 * Cloud Run's front end reserves URL paths ending in "z": GET /healthz on a Cloud Run URL gets Google's own
 * "Error 404 (Not Found)!!1" page and never reaches the container (seen on the first deploy, 2026-10-02). The same
 * liveness probe is therefore also served on /health, which deploy/gcp uses; /healthz stays for compose and Caddy.
 */
describe("cloud-run-reserved-healthz", () => {
  let h: Harness;
  afterEach(async () => {
    await h?.close();
  });

  it("serves the unauthenticated liveness probe on /health as well as /healthz", async () => {
    h = await makeHarness();
    for (const url of ["/health", "/healthz"]) {
      const res = await h.app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
    }
  });
});

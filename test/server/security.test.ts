import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ephemeralSealingKeys } from "../../src/lib/sealed.js";
import { buildServer } from "../../src/server/app.js";
import { cookieConfig } from "../../src/server/auth/sessions.js";
import { RateLimiter } from "../../src/server/rate-limit.js";
import { deriveLinkSecret } from "../../src/server/secrets.js";
import { CONTENT_SECURITY_POLICY, isSameOriginRequest } from "../../src/server/security.js";
import { createTestDb } from "../helpers/db.js";
import { FakeClock, makeHarness, spyLogger, testConfig, type Harness, type LogCall } from "./helpers.js";

vi.mock("../../src/digest/links.js", () => ({ createLinkFactory: vi.fn(), redeemActionToken: vi.fn(async () => null) }));

const SPA = fileURLToPath(new URL("../fixtures/server/spa", import.meta.url));

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

function expectSecurityHeaders(headers: Record<string, unknown>, kind: "api" | "page" | "action") {
  expect(headers["content-security-policy"]).toBe(CONTENT_SECURITY_POLICY);
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["referrer-policy"]).toBe(kind === "action" ? "no-referrer" : "strict-origin-when-cross-origin");
  if (kind !== "page") expect(headers["cache-control"]).toBe("no-store");
}

describe("security headers", () => {
  it("uses the strict CSP", () => {
    expect(CONTENT_SECURITY_POLICY).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
  });

  it("are present on API successes, errors, 404s and 415s", async () => {
    h = await makeHarness();
    const cases: Array<[Promise<{ statusCode: number; headers: Record<string, unknown> }>, number, "api" | "action" | "page"]> = [
      [h.app.inject({ method: "GET", url: "/healthz" }), 200, "page"],
      [h.app.inject({ method: "GET", url: "/api/me" }), 401, "api"],
      [h.app.inject({ method: "GET", url: "/api/nope?q=secret" }), 404, "api"],
      [h.app.inject({ method: "POST", url: "/api/auth/login", headers: { "content-type": "application/xml" }, payload: "<x/>" }), 415, "api"],
      [h.app.inject({ method: "POST", url: "/api/auth/login", headers: { "content-type": "application/json" }, payload: "{not json" }), 400, "api"],
      [h.app.inject({ method: "GET", url: "/a/whatever" }), 410, "action"],
      [h.app.inject({ method: "GET", url: "/nothing-here" }), 404, "page"],
    ];
    for (const [p, status, kind] of cases) {
      const res = await p;
      expect(res.statusCode).toBe(status);
      expectSecurityHeaders(res.headers, kind);
    }
  });

  it("tolerates body-less JSON posts", async () => {
    h = await makeHarness();
    const res = await h.app.inject({ method: "POST", url: "/api/auth/logout", headers: { "content-type": "application/json" } });
    expect(res.statusCode).toBe(200);
  });
});

describe("SPA hosting", () => {
  it("serves web/dist with an index.html fallback for client routes only", async () => {
    h = await makeHarness({ webDist: SPA });
    const root = await h.app.inject({ method: "GET", url: "/" });
    expect(root.statusCode).toBe(200);
    expect(root.body).toContain('<div id="root">');
    expectSecurityHeaders(root.headers, "page");
    expect(root.headers["cache-control"]).toBe("no-cache");

    const deep = await h.app.inject({ method: "GET", url: "/tasks/123?tab=todo" });
    expect(deep.statusCode).toBe(200);
    expect(deep.body).toContain('<div id="root">');
    expect(deep.headers["cache-control"]).toBe("no-cache");

    const asset = await h.app.inject({ method: "GET", url: "/assets/app-abc123.js" });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["cache-control"]).toContain("immutable");
    expect(asset.headers["content-security-policy"]).toBe(CONTENT_SECURITY_POLICY);

    expect((await h.app.inject({ method: "GET", url: "/assets/missing.js" })).statusCode).toBe(404);
    const api404 = await h.app.inject({ method: "GET", url: "/api/unknown" });
    expect(api404.statusCode).toBe(404);
    expect(api404.json()).toEqual({ error: "Not found", code: "not_found" });
    expect((await h.app.inject({ method: "POST", url: "/tasks/123" })).statusCode).toBe(404);
  });

  it("has no SPA fallback without webDist", async () => {
    h = await makeHarness();
    expect((await h.app.inject({ method: "GET", url: "/" })).statusCode).toBe(404);
  });
});

describe("errors and logging", () => {
  it("hides internal error details and logs route patterns, never URLs", async () => {
    const t = await createTestDb();
    const logs: LogCall[] = [];
    const keys = ephemeralSealingKeys();
    const app = await buildServer({
      db: t.db,
      clock: new FakeClock(),
      log: spyLogger(logs),
      config: testConfig(),
      sealingKeys: keys,
      probe: async () => {
        throw new Error("unused");
      },
      ingest: async () => {
        throw new Error("unused");
      },
    });
    app.get("/api/boom", async () => {
      throw new Error("relation failed for client@abc-gr.example");
    });
    app.get("/api/boom2", async () => {
      const err = new Error("Failed query: select * from tasks where search_text ilike $1\nparams: %σύμβαση%,partner@xyz.example");
      (err as Error & { cause?: unknown }).cause = Object.assign(new Error("inner"), { code: "22P02" });
      throw err;
    });
    await app.ready();
    try {
      const res = await app.inject({ method: "GET", url: "/api/boom?q=Προσφορά" });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: "Internal error", code: "internal" });
      const token = "x".repeat(300);
      await app.inject({ method: "GET", url: `/a/${token}` });
      expect((await app.inject({ method: "GET", url: "/api/boom2" })).statusCode).toBe(500);
      const logged = JSON.stringify(logs);
      expect(logged).not.toContain("partner@xyz.example");
      expect(logged).not.toContain("σύμβαση");
      expect(logged).not.toContain("search_text");
      expect(logs.filter((l) => l.level === "error").map((l) => (l.obj as { err: { code?: string } }).err.code)).toContain("22P02");
      expect(logged).not.toContain("client@abc-gr.example");
      expect(logged).not.toContain("Προσφορά");
      expect(logged).not.toContain(token);
      expect(logged).toContain('"route":"/api/boom"');
      expect(logged).toContain('"route":"/a/:token"');
      expect(logs.find((l) => l.level === "error")?.obj).toMatchObject({ route: "/api/boom", err: { name: "Error" } });
    } finally {
      await app.close();
      await t.close();
    }
  });
});

describe("building blocks", () => {
  it("token buckets refill continuously and prune", () => {
    let now = 0;
    const rl = new RateLimiter(() => now);
    for (let i = 0; i < 30; i++) expect(rl.take("oneClick", "1.2.3.4").ok).toBe(true);
    const refused = rl.take("oneClick", "1.2.3.4");
    expect(refused).toEqual({ ok: false, retryAfterSec: 2 });
    expect(rl.take("oneClick", "5.6.7.8").ok).toBe(true);
    expect(rl.take("login", "1.2.3.4").ok).toBe(true);
    now += 2_000;
    expect(rl.take("oneClick", "1.2.3.4").ok).toBe(true);
    expect(rl.take("oneClick", "1.2.3.4").ok).toBe(false);
    now += 3600_000;
    for (let i = 0; i < 1000; i++) rl.take("ingest", `ip-${i % 3}`);
    expect(rl.size).toBeLessThanOrEqual(3);
  });

  it("cookie names follow the base URL", () => {
    expect(cookieConfig("http://localhost:3000")).toEqual({ session: "mm", device: "mm-td", secure: false });
    expect(cookieConfig("http://127.0.0.1:3000")).toEqual({ session: "mm", device: "mm-td", secure: false });
    expect(cookieConfig("https://mailme.contoso.example")).toEqual({ session: "__Host-mm", device: "__Host-mm-td", secure: true });
    expect(cookieConfig("http://mailme.lan")).toEqual({ session: "__Host-mm", device: "__Host-mm-td", secure: true });
  });

  it("same-origin checks for form posts", () => {
    const app = "https://mailme.contoso.example";
    expect(isSameOriginRequest({ origin: app }, app)).toBe(true);
    expect(isSameOriginRequest({ origin: "https://evil.example" }, app)).toBe(false);
    expect(isSameOriginRequest({ origin: "https://evil.example", "sec-fetch-site": "same-origin" }, app)).toBe(false);
    expect(isSameOriginRequest({ origin: "null", "sec-fetch-site": "same-origin" }, app)).toBe(true);
    expect(isSameOriginRequest({ origin: "null", "sec-fetch-site": "same-site" }, app)).toBe(false);
    expect(isSameOriginRequest({ origin: "null" }, app)).toBe(false);
    expect(isSameOriginRequest({ referer: `${app}/a/x` }, app)).toBe(true);
    expect(isSameOriginRequest({ referer: "https://mailme.contoso.example.evil.example/" }, app)).toBe(false);
    expect(isSameOriginRequest({}, app)).toBe(false);
  });

  it("derives the link secret from APP_SECRET unless LINK_SECRET is set", () => {
    const derived = deriveLinkSecret(testConfig());
    expect(derived).toBe(deriveLinkSecret(testConfig()));
    expect(derived).not.toBe(testConfig().APP_SECRET);
    expect(derived.length).toBeGreaterThanOrEqual(43);
    expect(deriveLinkSecret(testConfig({ LINK_SECRET: "L".repeat(40) }))).toBe("L".repeat(40));
  });
});

import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ephemeralSealingKeys } from "../../../src/lib/sealed.js";
import { buildServer } from "../../../src/server/app.js";
import { createTestDb } from "../../helpers/db.js";
import { FakeClock, makeHarness, spyLogger, testConfig, type Harness, type LogCall } from "../../server/helpers.js";

/**
 * Docker deployment: Caddy runs in its own container and reaches `api:3000` from its fixed address on the compose
 * network (not loopback), with the real client in X-Forwarded-For. The api must trust exactly that address: trusting
 * nothing makes request.ip Caddy's address for every client (every per-IP bucket global), and trusting the whole subnet
 * lets the subnet's gateway (processes on a Linux host) choose its own rate-limit key.
 *
 * The repro asserted the precondition of the bug (compose never mentions TRUST_PROXY); this regression test reads
 * the effective TRUST_PROXY and the pinned subnet from docker-compose.yml instead (no YAML dependency: regexes).
 */
const root = path.resolve(__dirname, "../../..");
const compose = readFileSync(path.join(root, "docker-compose.yml"), "utf8");

/** `${VAR:-default}` → default (the value compose uses when .env does not set VAR). */
const expandDefaults = (v: string) => v.replace(/\$\{[A-Z_]+:-([^}]*)\}/g, "$1").replace(/^["']|["']$/g, "");

/** The api service block (up to the next top-level service). */
function serviceBlock(name: string): string {
  const m = new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][\\w-]*:\\n|^\\S)`, "m").exec(compose);
  if (!m) throw new Error(`service ${name} not found in docker-compose.yml`);
  return m[1]!;
}

const apiTrustProxy = (() => {
  const m = /^\s+TRUST_PROXY:\s*(.+)$/m.exec(serviceBlock("api"));
  return m ? expandDefaults(m[1]!.trim()) : null;
})();

const networks = /^networks:\n([\s\S]*?)(?=^\S)/m.exec(compose)?.[1] ?? "";
const pinned = (key: string) => {
  const m = new RegExp(`${key}:\\s*(.+)$`, "m").exec(networks);
  return m ? expandDefaults(m[1]!.trim()) : null;
};
const pinnedSubnet = pinned("subnet");
const dynamicRange = pinned("ip_range");
const caddyIp = (() => {
  const m = /^\s+ipv4_address:\s*(.+)$/m.exec(serviceBlock("caddy"));
  return m ? expandDefaults(m[1]!.trim()) : null;
})();

const ipv4 = (ip: string) => ip.split(".").reduce((n, part) => n * 256 + Number(part), 0);
/** "172.30.0.250" in "172.30.0.0/24". */
function inCidr(ip: string, cidr: string): boolean {
  const [base, bits] = cidr.split("/");
  const size = 2 ** (32 - Number(bits));
  return Math.floor(ipv4(ip) / size) === Math.floor(ipv4(base!) / size);
}

/** An address inside a /24 or wider IPv4 subnet ("172.30.0.0/24" → "172.30.0.5"). */
function addressIn(cidr: string, host: number): string {
  const [base] = cidr.split("/");
  const parts = base!.split(".").map(Number);
  parts[3] = host;
  return parts.join(".");
}

describe("docker-trust-proxy-global-ratelimit", () => {
  let h: Harness;
  afterEach(async () => {
    await h?.close();
  });

  it("compose pins the network and Caddy's address, and the api trusts exactly Caddy", () => {
    expect(pinnedSubnet).toMatch(/^\d+\.\d+\.\d+\.\d+\/(1[6-9]|2[0-9])$/);
    expect(dynamicRange).toMatch(/^\d+\.\d+\.\d+\.\d+\/\d+$/);
    expect(caddyIp).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(inCidr(dynamicRange!.split("/")[0]!, pinnedSubnet!)).toBe(true);
    expect(inCidr(caddyIp!, pinnedSubnet!)).toBe(true);
    // No other container can be handed Caddy's address.
    expect(inCidr(caddyIp!, dynamicRange!)).toBe(false);
    expect(apiTrustProxy).toBe(caddyIp);
    // Nothing publishes the api's port: Caddy is the only peer on that network that sets X-Forwarded-For.
    expect(serviceBlock("api")).not.toMatch(/^\s+ports:/m);
  });

  it("per-client login buckets stay per client behind Caddy with the documented Docker config", async () => {
    h = await makeHarness({ config: { TRUST_PROXY: apiTrustProxy! } });
    const viaCaddy = (clientIp: string, email: string) =>
      h.app.inject({
        method: "POST",
        url: "/api/auth/login",
        remoteAddress: caddyIp!,
        headers: { "x-forwarded-for": clientIp },
        payload: { email, password: "wrong-password" },
      });

    // An anonymous attacker burns the login bucket from one address.
    for (let i = 0; i < 10; i++) expect((await viaCaddy("203.0.113.1", "nobody@evil.example")).statusCode).toBe(401);
    expect((await viaCaddy("203.0.113.1", "nobody@evil.example")).statusCode).toBe(429);

    // A different client (real user) must not be locked out by the attacker.
    const victim = await viaCaddy("198.51.100.7", "owner@contoso.example");
    expect(victim.statusCode).not.toBe(429);
  });

  it.each([
    ["an outside address", () => "192.0.2.50"],
    ["the subnet's gateway (a process on the Linux host)", () => addressIn(pinnedSubnet!, 1)],
    ["another container on the network", () => addressIn(pinnedSubnet!, 5)],
  ])("%s cannot choose its rate-limit key with X-Forwarded-For", async (_what, peer) => {
    h = await makeHarness({ config: { TRUST_PROXY: apiTrustProxy! } });
    const outsider = (spoofed: string) =>
      h.app.inject({
        method: "POST",
        url: "/api/auth/login",
        remoteAddress: peer(),
        headers: { "x-forwarded-for": spoofed },
        payload: { email: "nobody@evil.example", password: "wrong-password" },
      });
    for (let i = 0; i < 10; i++) expect((await outsider(`198.51.100.${i + 1}`)).statusCode).toBe(401);
    expect((await outsider("198.51.100.200")).statusCode).toBe(429);
  });

  it("warns at startup when a production API on all interfaces trusts only loopback proxies", async () => {
    const t = await createTestDb();
    const logs: LogCall[] = [];
    const keys = ephemeralSealingKeys("k-test");
    const app = await buildServer({
      db: t.db,
      clock: new FakeClock(),
      log: spyLogger(logs),
      config: testConfig({ NODE_ENV: "production", HOST: "0.0.0.0", TRUST_PROXY: "loopback" }),
      sealingKeys: { kid: keys.kid, publicKey: keys.publicKey },
      probe: async () => {
        throw new Error("unused");
      },
      ingest: async () => {
        throw new Error("unused");
      },
      webDist: null,
    });
    try {
      expect(logs.some((l) => l.level === "warn" && (l.obj as { code?: string }).code === "trust_proxy_loopback")).toBe(true);
    } finally {
      await app.close();
      await t.close();
    }
    h = await makeHarness({ config: { NODE_ENV: "production", HOST: "0.0.0.0", TRUST_PROXY: apiTrustProxy! } });
    expect(h.logs.some((l) => (l.obj as { code?: string }).code === "trust_proxy_loopback")).toBe(false);
  });
});

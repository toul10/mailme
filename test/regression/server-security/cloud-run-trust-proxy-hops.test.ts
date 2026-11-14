import { afterEach, describe, expect, it } from "vitest";
import { parseTrustProxy } from "../../../src/server/app.js";
import { makeHarness, type Harness } from "../../server/helpers.js";

/**
 * Cloud Run (deploy/gcp/README.md): the container's only peer is Google's front end, which APPENDS the address it saw
 * to whatever X-Forwarded-For the client sent. TRUST_PROXY=1 trusts that one hop: request.ip is the rightmost entry,
 * so a client cannot pick its own rate-limit key by sending a forged header. Trusting more (true, or 2) would hand the
 * key to the client.
 */
describe("cloud-run-trust-proxy-hops", () => {
  let h: Harness;
  afterEach(async () => {
    await h?.close();
  });

  it("a hop count trusts exactly that many proxies (hop 0 is the socket peer)", () => {
    const one = parseTrustProxy("1") as (address: string, hop: number) => boolean;
    expect([one("169.254.8.1", 0), one("203.0.113.1", 1), one("10.0.0.1", 2)]).toEqual([true, false, false]);
    expect(parseTrustProxy(" 2 ")).toBeTypeOf("function");
    expect(parseTrustProxy("loopback")).toBe("loopback");
    expect(parseTrustProxy("172.30.0.0/24, 10.0.0.0/8")).toEqual(["172.30.0.0/24", "10.0.0.0/8"]);
  });

  it("TRUST_PROXY=1: a client forging X-Forwarded-For on every try still lands in its own login bucket", async () => {
    h = await makeHarness({ config: { TRUST_PROXY: "1" } });
    const frontEnd = "169.254.8.1";
    const login = (xff: string, email: string) =>
      h.app.inject({ method: "POST", url: "/api/auth/login", remoteAddress: frontEnd, headers: { "x-forwarded-for": xff }, payload: { email, password: "wrong-password" } });

    // A new forged leftmost entry each time; the front end appends the attacker's real address.
    for (let i = 0; i < 10; i++) expect((await login(`10.0.0.${i}, 203.0.113.1`, "nobody@evil.example")).statusCode).toBe(401);
    expect((await login("10.9.9.9, 203.0.113.1", "nobody@evil.example")).statusCode).toBe(429);

    // Another client, through the same front end, is not locked out by the attacker.
    expect((await login("198.51.100.7", "owner@contoso.example")).statusCode).not.toBe(429);
  });
});

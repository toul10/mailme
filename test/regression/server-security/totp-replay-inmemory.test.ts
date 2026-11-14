import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../src/db/schema.js";
import { totpCode, totpCounter } from "../../../src/lib/totp.js";
import { buildServer } from "../../../src/server/app.js";
import { cookiesFrom, makeHarness, PASSWORD, setCredentials, spyLogger, type Harness } from "../../server/helpers.js";

const SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

async function login(app: FastifyInstance) {
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "owner@contoso.example", password: PASSWORD } });
  const body = res.json() as { next: string; csrfToken: string };
  return { cookies: cookiesFrom(res), csrf: body.csrfToken, next: body.next };
}

async function loginAndVerify(app: FastifyInstance, code: string) {
  const l = await login(app);
  expect(l.next).toBe("totp");
  return app.inject({
    method: "POST",
    url: "/api/auth/totp/verify",
    cookies: l.cookies,
    headers: { "x-csrf-token": l.csrf },
    payload: { code, rememberDevice: false },
  });
}

describe("totp-replay-inmemory", () => {
  let h: Harness;
  let restarted: FastifyInstance | null = null;
  beforeEach(async () => {
    h = await makeHarness();
    await setCredentials(h, h.seed.user.id, { totpSecret: SECRET });
  });
  afterEach(async () => {
    await restarted?.close();
    restarted = null;
    await h.close();
  });

  it("a used TOTP code is still refused after the API restarts within its validity window", async () => {
    const code = totpCode(SECRET, h.clock.now().getTime());
    expect((await loginAndVerify(h.app, code)).statusCode).toBe(200);

    // API restart (deploy / crash / docker restart): same DB, same clock, 20 s later.
    h.clock.advance(20_000);
    restarted = await buildServer({
      db: h.t.db,
      clock: h.clock,
      log: spyLogger([]),
      config: h.config,
      sealingKeys: { kid: h.keys.kid, publicKey: h.keys.publicKey },
      probe: h.probe,
      ingest: h.ingest,
      webDist: null,
    });
    await restarted.ready();

    const replay = await loginAndVerify(restarted, code);
    expect(replay.statusCode).toBe(400);
    // The accepted step is persisted.
    const [u] = await h.t.db.select({ step: s.users.totpLastStep }).from(s.users).where(eq(s.users.id, h.seed.user.id));
    expect(u!.step).toBe(totpCounter(h.clock.now().getTime() - 20_000));
  });

  it("two concurrent verifications with the same code: only one wins", async () => {
    const code = totpCode(SECRET, h.clock.now().getTime());
    const [a, b] = await Promise.all([loginAndVerify(h.app, code), loginAndVerify(h.app, code)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 400]);
  });

  it("the next code (a later step) is accepted after a used one", async () => {
    const t0 = h.clock.now().getTime();
    expect((await loginAndVerify(h.app, totpCode(SECRET, t0))).statusCode).toBe(200);
    h.clock.advance(30_000);
    expect((await loginAndVerify(h.app, totpCode(SECRET, h.clock.now().getTime()))).statusCode).toBe(200);
  });

  it("the code that confirmed enrolment cannot be replayed for a login", async () => {
    await h.t.db.update(s.users).set({ totpEnabled: false, totpSecretEnc: null }).where(eq(s.users.id, h.seed.user.id));
    const l = await login(h.app);
    expect(l.next).toBe("totp_enroll");
    const headers = { "x-csrf-token": l.csrf };
    const enroll = await h.app.inject({ method: "POST", url: "/api/auth/totp/enroll", cookies: l.cookies, headers });
    const secret = (enroll.json() as { secret: string }).secret;
    const code = totpCode(secret, h.clock.now().getTime());
    const confirm = await h.app.inject({ method: "POST", url: "/api/auth/totp/confirm", cookies: l.cookies, headers, payload: { code } });
    expect(confirm.statusCode).toBe(200);
    h.clock.advance(10_000);
    expect((await loginAndVerify(h.app, code)).statusCode).toBe(400);
  });
});

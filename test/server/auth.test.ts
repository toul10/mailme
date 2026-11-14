import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as s from "../../src/db/schema.js";
import { decryptSecret } from "../../src/lib/crypto.js";
import { totpCode } from "../../src/lib/totp.js";
import { hashPassword, verifyPassword } from "../../src/server/auth/passwords.js";
import { sha256Hex } from "../../src/server/secrets.js";
import { addUser, api, cookiesFrom, makeHarness, MASTER_KEY, PASSWORD, setCookieHeaders, setCredentials, type Harness, type Session } from "./helpers.js";

const SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

async function login(h: Harness, email = "owner@contoso.example", password = PASSWORD, cookies: Record<string, string> = {}, headers: Record<string, string> = {}) {
  const res = await h.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password }, cookies, headers });
  const body = res.json() as { ok: boolean; next: string; csrfToken: string; code?: string };
  const session: Session = { cookies: { ...cookies, ...cookiesFrom(res) }, csrf: body.csrfToken };
  return { res, body, session };
}

async function auditEvents(h: Harness): Promise<string[]> {
  const rows = await h.t.db.select().from(s.securityAudit).orderBy(s.securityAudit.id);
  return rows.map((r) => r.event);
}

describe("auth: passwords", () => {
  it("hashes with argon2id and verifies", async () => {
    const hash = await hashPassword("pässwörd");
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword(hash, "pässwörd")).toBe(true);
    expect(await verifyPassword(hash, "passwörd")).toBe(false);
    expect(await verifyPassword("not-a-hash", "x")).toBe(false);
  });
});

describe("auth: login, MFA, sessions", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it("rejects a wrong password and an unknown user with the same 401, and audits both", async () => {
    await setCredentials(h, h.seed.user.id);
    const bad = await login(h, "owner@contoso.example", "wrong");
    expect(bad.res.statusCode).toBe(401);
    expect(bad.body.code).toBe("unauthorized");
    expect(setCookieHeaders(bad.res)).toHaveLength(0);
    const unknown = await login(h, "nobody@contoso.example", "wrong");
    expect(unknown.res.statusCode).toBe(401);
    expect(unknown.res.json()).toEqual(bad.res.json());
    const rows = await h.t.db.select().from(s.securityAudit);
    expect(rows.map((r) => [r.event, r.detail])).toEqual([
      ["auth.login_fail", { reason: "bad_password" }],
      ["auth.login_fail", { reason: "unknown_user" }],
    ]);
    // No addresses or passwords in the audit trail.
    expect(JSON.stringify(rows)).not.toContain("nobody@");
    expect(JSON.stringify(rows)).not.toContain("wrong");
  });

  it("first login requires TOTP enrolment; enroll → confirm unlocks the app with the same CSRF token", async () => {
    await setCredentials(h, h.seed.user.id);
    const { res, body, session } = await login(h, "OWNER@contoso.example ");
    expect(res.statusCode).toBe(200);
    expect(body).toMatchObject({ ok: true, next: "totp_enroll" });
    const cookie = setCookieHeaders(res)[0]!;
    expect(cookie).toMatch(/^mm=/);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).not.toContain("Secure");

    const me = await api(h, session, "GET", "/api/me");
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ email: "owner@contoso.example", mfaVerified: false, csrfToken: body.csrfToken, timezone: "Europe/Athens", role: "member" });

    const blocked = await api(h, session, "GET", "/api/companies");
    expect(blocked.statusCode).toBe(401);
    expect(blocked.json().code).toBe("mfa_required");

    const enroll = await api(h, session, "POST", "/api/auth/totp/enroll");
    expect(enroll.statusCode).toBe(200);
    const { secret, otpauthUri } = enroll.json() as { secret: string; otpauthUri: string };
    expect(otpauthUri).toContain(`secret=${secret}`);
    expect(otpauthUri).toContain("issuer=MailMe");
    const [u] = await h.t.db.select().from(s.users).where(eq(s.users.id, h.seed.user.id));
    expect(u!.totpEnabled).toBe(false);
    expect(u!.totpSecretEnc).not.toContain(secret);
    expect(decryptSecret(u!.totpSecretEnc!, MASTER_KEY)).toBe(secret);

    const wrong = await api(h, session, "POST", "/api/auth/totp/confirm", { code: "000000" === totpCode(secret, h.clock.now().getTime()) ? "111111" : "000000" });
    expect(wrong.statusCode).toBe(400);

    const ok = await api(h, session, "POST", "/api/auth/totp/confirm", { code: totpCode(secret, h.clock.now().getTime()) });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true });
    // Session id rotated on elevation; the CSRF token from login stays valid.
    const elevated: Session = { cookies: { ...session.cookies, ...cookiesFrom(ok) }, csrf: body.csrfToken };
    expect(elevated.cookies["mm"]).not.toBe(session.cookies["mm"]);
    expect((await api(h, session, "GET", "/api/me")).statusCode).toBe(401);
    const me2 = await api(h, elevated, "GET", "/api/me");
    expect(me2.json()).toMatchObject({ mfaVerified: true, csrfToken: body.csrfToken });
    expect((await api(h, elevated, "GET", "/api/companies")).statusCode).toBe(200);
    expect((await api(h, elevated, "POST", "/api/auth/totp/enroll")).statusCode).toBe(409);

    expect(await auditEvents(h)).toEqual(["auth.login_ok", "auth.mfa_enroll_start", "auth.mfa_verify_fail", "auth.mfa_enrolled"]);
  });

  it("TOTP verification: wrong code, right code, and no replay of a used code", async () => {
    await setCredentials(h, h.seed.user.id, { totpSecret: SECRET });
    const first = await login(h);
    expect(first.body.next).toBe("totp");
    expect((await api(h, first.session, "GET", "/api/tasks")).json().code).toBe("mfa_required");
    const code = totpCode(SECRET, h.clock.now().getTime());
    expect((await api(h, first.session, "POST", "/api/auth/totp/verify", { code: code === "123456" ? "654321" : "123456", rememberDevice: false })).statusCode).toBe(400);
    const ok = await api(h, first.session, "POST", "/api/auth/totp/verify", { code, rememberDevice: false });
    expect(ok.statusCode).toBe(200);
    const full: Session = { cookies: cookiesFrom(ok), csrf: first.body.csrfToken };
    expect((await api(h, full, "GET", "/api/tasks")).statusCode).toBe(200);
    // No device cookie without rememberDevice.
    expect(cookiesFrom(ok)["mm-td"]).toBeUndefined();

    // The same code can't be used again (replay within the ±1 step window).
    const second = await login(h);
    const replay = await api(h, second.session, "POST", "/api/auth/totp/verify", { code, rememberDevice: false });
    expect(replay.statusCode).toBe(400);
    // Next time step works.
    h.clock.advance(30_000);
    const later = await api(h, second.session, "POST", "/api/auth/totp/verify", { code: totpCode(SECRET, h.clock.now().getTime()), rememberDevice: false });
    expect(later.statusCode).toBe(200);
  });

  it("a trusted device skips TOTP for 30 days, for its own user only", async () => {
    await setCredentials(h, h.seed.user.id, { totpSecret: SECRET });
    const first = await login(h);
    const ok = await api(h, first.session, "POST", "/api/auth/totp/verify", { code: totpCode(SECRET, h.clock.now().getTime()), rememberDevice: true });
    expect(ok.statusCode).toBe(200);
    const device = cookiesFrom(ok)["mm-td"];
    expect(device).toBeTruthy();
    const deviceCookie = setCookieHeaders(ok).find((c) => c.startsWith("mm-td="))!;
    expect(deviceCookie).toContain("Max-Age=2592000");
    expect(deviceCookie).toContain("HttpOnly");
    const [row] = await h.t.db.select().from(s.trustedDevices);
    expect(row!.id).toBe(sha256Hex(device!));

    const again = await login(h, undefined, undefined, { "mm-td": device! });
    expect(again.body.next).toBe("none");
    expect((await api(h, again.session, "GET", "/api/tasks")).statusCode).toBe(200);

    // Another user presenting this device cookie still needs TOTP.
    const other = await addUser(h, { email: "colleague@contoso.example" });
    await setCredentials(h, other.id, { totpSecret: SECRET });
    expect((await login(h, "colleague@contoso.example", PASSWORD, { "mm-td": device! })).body.next).toBe("totp");

    h.clock.advance(31 * 24 * 3600_000);
    expect((await login(h, undefined, undefined, { "mm-td": device! })).body.next).toBe("totp");
    expect(await auditEvents(h)).toContain("auth.trusted_device_used");
  });

  it("CSRF: mutations need the session's x-csrf-token header", async () => {
    await setCredentials(h, h.seed.user.id);
    const h2 = await makeHarness({ config: { AUTH_REQUIRE_MFA: "false" } });
    try {
      await setCredentials(h2, h2.seed.user.id);
      const { body, session } = await login(h2);
      expect(body.next).toBe("none");
      const noHeader = await h2.app.inject({ method: "POST", url: "/api/mailboxes/00000000-0000-4000-8000-000000000000/ingest-token", cookies: session.cookies });
      expect(noHeader.statusCode).toBe(403);
      expect(noHeader.json().code).toBe("forbidden");
      const wrong = await h2.app.inject({
        method: "POST",
        url: "/api/mailboxes/00000000-0000-4000-8000-000000000000/ingest-token",
        cookies: session.cookies,
        headers: { "x-csrf-token": "nope" },
      });
      expect(wrong.statusCode).toBe(403);
      const right = await api(h2, session, "POST", "/api/mailboxes/00000000-0000-4000-8000-000000000000/ingest-token");
      expect(right.statusCode).toBe(404);
      expect((await api(h2, session, "GET", "/api/mailboxes")).statusCode).toBe(200);
    } finally {
      await h2.close();
    }
  });

  it("logout deletes the session and clears the cookie; login rotates any previous session", async () => {
    const h2 = await makeHarness({ config: { AUTH_REQUIRE_MFA: "false" } });
    try {
      await setCredentials(h2, h2.seed.user.id);
      const a = await login(h2);
      const b = await login(h2, undefined, undefined, a.session.cookies);
      expect(b.session.cookies["mm"]).not.toBe(a.session.cookies["mm"]);
      expect((await api(h2, a.session, "GET", "/api/me")).statusCode).toBe(401);
      expect((await h2.t.db.select().from(s.sessions)).length).toBe(1);

      const noCsrf = await h2.app.inject({ method: "POST", url: "/api/auth/logout", cookies: b.session.cookies });
      expect(noCsrf.statusCode).toBe(403);
      const out = await api(h2, b.session, "POST", "/api/auth/logout");
      expect(out.statusCode).toBe(200);
      const cleared = setCookieHeaders(out)[0]!;
      expect(cleared).toMatch(/^mm=;/);
      expect(cleared).toContain("Path=/");
      expect((await api(h2, b.session, "GET", "/api/me")).statusCode).toBe(401);
      expect((await h2.t.db.select().from(s.sessions)).length).toBe(0);
      // Logging out without a session is harmless.
      expect((await h2.app.inject({ method: "POST", url: "/api/auth/logout" })).statusCode).toBe(200);
    } finally {
      await h2.close();
    }
  });

  it("sessions expire when idle and the pre-MFA session is short-lived", async () => {
    await setCredentials(h, h.seed.user.id, { totpSecret: SECRET });
    const pre = await login(h);
    h.clock.advance(16 * 60_000);
    expect((await api(h, pre.session, "GET", "/api/me")).statusCode).toBe(401);

    const again = await login(h);
    const ok = await api(h, again.session, "POST", "/api/auth/totp/verify", { code: totpCode(SECRET, h.clock.now().getTime()), rememberDevice: false });
    const full: Session = { cookies: cookiesFrom(ok), csrf: again.body.csrfToken };
    h.clock.advance(47 * 3600_000);
    expect((await api(h, full, "GET", "/api/me")).statusCode).toBe(200);
    h.clock.advance(49 * 3600_000);
    expect((await api(h, full, "GET", "/api/me")).statusCode).toBe(401);
  });

  it("disabled users can't log in and lose their sessions", async () => {
    await setCredentials(h, h.seed.user.id, { totpSecret: SECRET });
    const pre = await login(h);
    await h.t.db.update(s.users).set({ disabledAt: h.clock.now() }).where(eq(s.users.id, h.seed.user.id));
    expect((await api(h, pre.session, "GET", "/api/me")).statusCode).toBe(401);
    expect((await login(h)).res.statusCode).toBe(401);
  });

  it("rate-limits login per IP (10 per 15 min) with Retry-After", async () => {
    await setCredentials(h, h.seed.user.id);
    for (let i = 0; i < 10; i++) expect((await login(h, "owner@contoso.example", "wrong")).res.statusCode).toBe(401);
    const limited = await login(h);
    expect(limited.res.statusCode).toBe(429);
    expect(limited.res.json().code).toBe("rate_limited");
    expect(Number(limited.res.headers["retry-after"])).toBeGreaterThan(0);
    h.clock.advance(15 * 60_000);
    expect((await login(h)).res.statusCode).toBe(200);
  });

  it("rate-limits TOTP attempts per user", async () => {
    await setCredentials(h, h.seed.user.id, { totpSecret: SECRET });
    const { session } = await login(h);
    const wrongCode = totpCode(SECRET, h.clock.now().getTime()) === "000000" ? "111111" : "000000";
    for (let i = 0; i < 10; i++) expect((await api(h, session, "POST", "/api/auth/totp/verify", { code: wrongCode, rememberDevice: false })).statusCode).toBe(400);
    expect((await api(h, session, "POST", "/api/auth/totp/verify", { code: wrongCode, rememberDevice: false })).statusCode).toBe(429);
  });

  it("refuses cross-origin and form-encoded login attempts", async () => {
    await setCredentials(h, h.seed.user.id);
    const cross = await login(h, undefined, undefined, {}, { origin: "https://evil.example" });
    expect(cross.res.statusCode).toBe(403);
    const same = await login(h, undefined, undefined, {}, { origin: "http://localhost:3000" });
    expect(same.res.statusCode).toBe(200);
    // Local development: the Vite dev server proxies from another localhost port.
    const vite = await login(h, undefined, undefined, {}, { origin: "http://localhost:5173" });
    expect(vite.res.statusCode).toBe(200);
    const form = await h.app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: `email=owner%40contoso.example&password=${encodeURIComponent(PASSWORD)}`,
    });
    expect(form.statusCode).toBe(415);
    const text = await h.app.inject({ method: "POST", url: "/api/auth/login", headers: { "content-type": "text/plain" }, payload: "{}" });
    expect(text.statusCode).toBe(415);
  });

  it("uses Secure __Host- cookies for an https base URL", async () => {
    const h2 = await makeHarness({ config: { APP_BASE_URL: "https://mailme.contoso.example", AUTH_REQUIRE_MFA: "false" } });
    try {
      await setCredentials(h2, h2.seed.user.id);
      const localOrigin = await h2.app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin: "http://localhost:5173" },
        payload: { email: "owner@contoso.example", password: PASSWORD },
      });
      expect(localOrigin.statusCode).toBe(403);
      const res = await h2.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "owner@contoso.example", password: PASSWORD } });
      const cookie = setCookieHeaders(res)[0]!;
      expect(cookie).toMatch(/^__Host-mm=/);
      expect(cookie).toContain("Secure");
      expect(cookie).toContain("Path=/");
      expect(cookie).not.toContain("Domain");
      expect(res.headers["strict-transport-security"]).toBeDefined();
      const out = await h2.app.inject({
        method: "POST",
        url: "/api/auth/logout",
        cookies: cookiesFrom(res),
        headers: { "x-csrf-token": (res.json() as { csrfToken: string }).csrfToken },
      });
      const cleared = setCookieHeaders(out)[0]!;
      expect(cleared).toMatch(/^__Host-mm=;/);
      expect(cleared).toContain("Secure");
      expect(cleared).toContain("Path=/");
    } finally {
      await h2.close();
    }
  });
});

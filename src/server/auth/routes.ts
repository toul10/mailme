import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sessions, trustedDevices, users } from "../../db/schema.js";
import { decryptSecret, encryptSecret } from "../../lib/crypto.js";
import { generateTotpSecret, matchTotpStep, otpauthUri } from "../../lib/totp.js";
import type { LoginResponse, Me, TotpEnrollStart } from "../api-types.js";
import { audit } from "../audit.js";
import type { AppContext } from "../context.js";
import { badRequest, conflict, forbidden, notFound, parseWith, rateLimited, unauthorized } from "../http.js";
import { originAllowedIfPresent } from "../security.js";
import { safeEqual } from "../secrets.js";
import { authOf, rateLimit, requireAuth } from "./guard.js";
import { burnPasswordCheck, hashPassword, MIN_PASSWORD, verifyPassword } from "./passwords.js";
import { findBySetupToken } from "./setup-links.js";
import {
  clearSessionCookie,
  createSession,
  createTrustedDevice,
  deleteSessionByToken,
  elevateSession,
  isTrustedDevice,
  loadSession,
  purgeExpiredSessions,
  setDeviceCookie,
  setSessionCookie,
} from "./sessions.js";

export const TOTP_ISSUER = "MailMe";

const LoginBody = z.object({ email: z.string().trim().min(3).max(320), password: z.string().min(1).max(1024) });
const TotpVerifyBody = z.object({ code: z.string().trim().min(6).max(12), rememberDevice: z.boolean().optional().default(false) });
const TotpConfirmBody = z.object({ code: z.string().trim().min(6).max(12) });
const SetupCheckBody = z.object({ token: z.string().min(1).max(200) });
const SetupBody = z.object({ token: z.string().min(1).max(200), password: z.string().max(1024) });
const SETUP_GONE = "This link is no longer valid (it was used or has expired). Ask your admin for a new one.";

/** Auth endpoints: login (password), TOTP verify/enroll/confirm, logout, /api/me. */
export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, clock, config } = ctx.deps;

  async function loadUser(userId: string) {
    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user || user.disabledAt) throw unauthorized();
    return user;
  }

  /**
   * Verify a code and refuse a step that was already used (replay within the ±1 window). The last accepted step
   * lives in users.totp_last_step and is advanced with a compare-and-set, so a used code stays used across API
   * restarts and between API instances, and two concurrent requests with the same code cannot both win.
   */
  async function acceptTotp(userId: string, secret: string, code: string): Promise<boolean> {
    const step = matchTotpStep(secret, code, clock.now().getTime());
    if (step === null) return false;
    const won = await db
      .update(users)
      .set({ totpLastStep: step })
      .where(and(eq(users.id, userId), or(isNull(users.totpLastStep), lt(users.totpLastStep, step))))
      .returning({ id: users.id });
    return won.length === 1;
  }

  function takeUserTotpToken(userId: string): void {
    const r = ctx.limiter.take("totp", `user:${userId}`);
    if (!r.ok) throw rateLimited(r.retryAfterSec);
  }

  app.post("/api/auth/login", { onRequest: [rateLimit(ctx, "login")] }, async (request, reply) => {
    if (!originAllowedIfPresent(request.headers, ctx.appOrigin, !ctx.cookies.secure)) throw forbidden();
    const body = parseWith(LoginBody, request.body);
    const email = body.email.toLowerCase();
    const now = clock.now();
    const [user] = await db.select().from(users).where(sql`lower(${users.email}) = ${email}`).limit(1);
    if (!user || !user.passwordHash || user.disabledAt) {
      await burnPasswordCheck(body.password);
      const reason = !user ? "unknown_user" : user.disabledAt ? "disabled" : "no_password";
      await audit(db, { orgId: user?.orgId, userId: user?.id, event: "auth.login_fail", detail: { reason }, ip: request.ip });
      throw unauthorized("Wrong email or password");
    }
    if (!(await verifyPassword(user.passwordHash, body.password))) {
      await audit(db, { orgId: user.orgId, userId: user.id, event: "auth.login_fail", detail: { reason: "bad_password" }, ip: request.ip });
      throw unauthorized("Wrong email or password");
    }

    // Rotation: whatever session this browser had is dropped; a new id is issued.
    await deleteSessionByToken(db, request.cookies[ctx.cookies.session]);
    await purgeExpiredSessions(db, user.id, now);

    let next: LoginResponse["next"];
    let trusted = false;
    if (user.totpEnabled) {
      trusted = await isTrustedDevice(db, request.cookies[ctx.cookies.device], user.id, now);
      next = trusted ? "none" : "totp";
    } else {
      next = config.AUTH_REQUIRE_MFA ? "totp_enroll" : "none";
    }
    const s = await createSession(db, user.id, next === "none", now);
    setSessionCookie(reply, ctx.cookies, s.token, s.ttlMs);
    await audit(db, { orgId: user.orgId, userId: user.id, event: "auth.login_ok", detail: { next }, ip: request.ip });
    if (trusted) await audit(db, { orgId: user.orgId, userId: user.id, event: "auth.trusted_device_used", ip: request.ip });
    const res: LoginResponse = { ok: true, next, csrfToken: s.csrfToken };
    return res;
  });

  app.post(
    "/api/auth/totp/verify",
    { onRequest: [rateLimit(ctx, "totp")], preHandler: requireAuth(ctx, "password") },
    async (request, reply) => {
      const auth = authOf(request);
      takeUserTotpToken(auth.userId);
      const body = parseWith(TotpVerifyBody, request.body);
      const user = await loadUser(auth.userId);
      if (!user.totpEnabled || !user.totpSecretEnc) throw conflict("Verification codes (TOTP) are not set up");
      const now = clock.now();
      if (!(await acceptTotp(user.id, decryptSecret(user.totpSecretEnc, config.MASTER_KEY), body.code))) {
        await audit(db, { orgId: user.orgId, userId: user.id, event: "auth.mfa_verify_fail", ip: request.ip });
        throw badRequest("Wrong code");
      }
      const s = await elevateSession(db, auth, now);
      setSessionCookie(reply, ctx.cookies, s.token, s.ttlMs);
      await audit(db, { orgId: user.orgId, userId: user.id, event: "auth.mfa_verify_ok", ip: request.ip });
      if (body.rememberDevice) {
        setDeviceCookie(reply, ctx.cookies, await createTrustedDevice(db, user.id, now));
        await audit(db, { orgId: user.orgId, userId: user.id, event: "auth.trusted_device_add", ip: request.ip });
      }
      return { ok: true as const };
    },
  );

  app.post(
    "/api/auth/totp/enroll",
    { onRequest: [rateLimit(ctx, "totp")], preHandler: requireAuth(ctx, "password") },
    async (request) => {
      const auth = authOf(request);
      const user = await loadUser(auth.userId);
      // Re-enrolment would replace a working second factor: only through the CLI reset.
      if (user.totpEnabled) throw auth.mfaVerified ? conflict("Verification codes (TOTP) are already set up") : forbidden();
      const secret = generateTotpSecret();
      // A new secret starts a new replay window (codes of the old secret cannot validate against it).
      await db.update(users).set({ totpSecretEnc: encryptSecret(secret, config.MASTER_KEY), totpLastStep: null }).where(eq(users.id, user.id));
      await audit(db, { orgId: user.orgId, userId: user.id, event: "auth.mfa_enroll_start", ip: request.ip });
      const res: TotpEnrollStart = { otpauthUri: otpauthUri(secret, user.email, TOTP_ISSUER), secret };
      return res;
    },
  );

  app.post(
    "/api/auth/totp/confirm",
    { onRequest: [rateLimit(ctx, "totp")], preHandler: requireAuth(ctx, "password") },
    async (request, reply) => {
      const auth = authOf(request);
      takeUserTotpToken(auth.userId);
      const body = parseWith(TotpConfirmBody, request.body);
      const user = await loadUser(auth.userId);
      if (user.totpEnabled) throw conflict("Verification codes (TOTP) are already set up");
      if (!user.totpSecretEnc) throw conflict("Start the setup first");
      if (!(await acceptTotp(user.id, decryptSecret(user.totpSecretEnc, config.MASTER_KEY), body.code))) {
        await audit(db, { orgId: user.orgId, userId: user.id, event: "auth.mfa_verify_fail", detail: { phase: "enroll" }, ip: request.ip });
        throw badRequest("Wrong code");
      }
      await db.update(users).set({ totpEnabled: true }).where(eq(users.id, user.id));
      const s = await elevateSession(db, auth, clock.now());
      setSessionCookie(reply, ctx.cookies, s.token, s.ttlMs);
      await audit(db, { orgId: user.orgId, userId: user.id, event: "auth.mfa_enrolled", ip: request.ip });
      return { ok: true as const };
    },
  );

  // ── One-time setup link (src/server/auth/setup-links.ts): the invitee sets their own password ──────────────
  app.post("/api/auth/setup/check", { onRequest: [rateLimit(ctx, "setup")] }, async (request) => {
    if (!originAllowedIfPresent(request.headers, ctx.appOrigin, !ctx.cookies.secure)) throw forbidden();
    const { token } = parseWith(SetupCheckBody, request.body);
    const user = await findBySetupToken(db, token, clock.now());
    if (!user) throw notFound(SETUP_GONE);
    return { name: user.name, email: user.email, expiresAt: user.setupExpiresAt!.toISOString(), minPassword: MIN_PASSWORD };
  });

  app.post("/api/auth/setup", { onRequest: [rateLimit(ctx, "setup")] }, async (request, reply) => {
    if (!originAllowedIfPresent(request.headers, ctx.appOrigin, !ctx.cookies.secure)) throw forbidden();
    const body = parseWith(SetupBody, request.body);
    if (body.password.length < MIN_PASSWORD) throw badRequest(`The password needs at least ${MIN_PASSWORD} characters.`);
    const now = clock.now();
    const user = await findBySetupToken(db, body.token, now);
    if (!user) throw notFound(SETUP_GONE);
    const passwordHash = await hashPassword(body.password);
    // Single use: the token is cleared in the same statement that checks it is still this one.
    const done = await db
      .update(users)
      .set({ passwordHash, setupTokenHash: null, setupExpiresAt: null, totpEnabled: false, totpSecretEnc: null, totpLastStep: null })
      .where(and(eq(users.id, user.id), eq(users.setupTokenHash, user.setupTokenHash!)))
      .returning({ id: users.id });
    if (done.length !== 1) throw notFound(SETUP_GONE);
    // A new password and a new TOTP: every old session and remembered device of the account stops working.
    await db.delete(sessions).where(eq(sessions.userId, user.id));
    await db.delete(trustedDevices).where(eq(trustedDevices.userId, user.id));
    await deleteSessionByToken(db, request.cookies[ctx.cookies.session]);
    const next: LoginResponse["next"] = config.AUTH_REQUIRE_MFA ? "totp_enroll" : "none";
    const s = await createSession(db, user.id, next === "none", now);
    setSessionCookie(reply, ctx.cookies, s.token, s.ttlMs);
    await audit(db, { orgId: user.orgId, userId: user.id, event: "auth.setup_done", detail: { next }, ip: request.ip });
    const res: LoginResponse = { ok: true, next, csrfToken: s.csrfToken };
    return res;
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const auth = await loadSession(db, request.cookies[ctx.cookies.session], clock.now());
    if (auth) {
      const header = request.headers["x-csrf-token"];
      if (typeof header !== "string" || !safeEqual(header, auth.csrfToken)) throw forbidden("Invalid CSRF token");
      await db.delete(sessions).where(eq(sessions.id, auth.sessionId));
      await audit(db, { orgId: auth.orgId, userId: auth.userId, event: "auth.logout", ip: request.ip });
    }
    clearSessionCookie(reply, ctx.cookies);
    return { ok: true as const };
  });

  app.get("/api/me", { preHandler: requireAuth(ctx, "password") }, async (request) => {
    const auth = authOf(request);
    const user = await loadUser(auth.userId);
    const me: Me = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      mfaVerified: auth.mfaVerified,
      csrfToken: auth.csrfToken,
      timezone: auth.timezone,
      digestTime: user.digestTime,
      digestDelivery: user.digestDelivery,
      digestEnabled: user.digestEnabled,
      platformAdmin: user.platformAdmin,
      chat: Boolean(ctx.deps.chatModel),
    };
    return me;
  });
}

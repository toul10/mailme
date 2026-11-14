import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { eq, isNotNull, sql } from "drizzle-orm";
import { mailboxes, organizations, sessions, trustedDevices, users } from "../../db/schema.js";
import { openMailboxPassword, sealMailboxPassword } from "../../lib/credentials.js";
import { generateSealingKeyPair, loadSealingKeys } from "../../lib/sealed.js";
import { MIN_PASSWORD } from "../../server/auth/passwords.js";
import { issueSetupLink } from "../../server/auth/setup-links.js";
import { UsageError } from "../args.js";
import { assertHhMm, assertIsoDate, audit, findMailbox, findOrg, findUser } from "../context.js";
import { yesOpt, type Command } from "./types.js";


export const keysGenerate: Command = {
  name: "keys:generate",
  summary: "Create the X25519 key pair that seals mailbox passwords (public → API, private → worker only)",
  options: {
    force: { type: "boolean", description: "Overwrite existing key files (stored mailbox passwords become unreadable)" },
    "out-dir": { type: "string", arg: "<dir>", description: "Write credentials.pub.pem / credentials.key.pem here instead of the configured paths" },
    kid: { type: "string", arg: "<kid>", description: "Key id to put in .env (CREDENTIALS_KID)" },
  },
  async run(ctx, args) {
    const cfg = ctx.tryConfig();
    const outDir = args.str("out-dir");
    const pubPath = outDir ? path.join(outDir, "credentials.pub.pem") : (cfg?.CREDENTIALS_PUBLIC_KEY_FILE ?? "./data/keys/credentials.pub.pem");
    const keyPath = outDir ? path.join(outDir, "credentials.key.pem") : (cfg?.CREDENTIALS_PRIVATE_KEY_FILE ?? "./data/keys/credentials.key.pem");
    const existing = [pubPath, keyPath].filter((p) => existsSync(p));
    if (existing.length && !args.bool("force")) {
      ctx.io.err(`Refusing to overwrite ${existing.join(", ")}.`);
      ctx.io.err("Mailbox passwords sealed with the current key could no longer be opened. Use --out-dir for a new pair (rotation) or --force.");
      return 1;
    }
    const pair = generateSealingKeyPair();
    for (const p of [pubPath, keyPath]) mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    writeFileSync(pubPath, pair.publicPem, { mode: 0o644 });
    writeFileSync(keyPath, pair.privatePem, { mode: 0o600 });
    chmodSync(keyPath, 0o600); // writeFileSync keeps the mode of an existing file
    chmodSync(pubPath, 0o644);
    const kid = args.str("kid") ?? cfg?.CREDENTIALS_KID ?? "k1";
    ctx.io.out(`Public key:  ${pubPath}`);
    ctx.io.out(`Private key: ${keyPath} (0600 — mount it ONLY into the worker; keep it out of backups and git)`);
    ctx.io.out("");
    ctx.io.out("In .env:");
    ctx.io.out(`  CREDENTIALS_KID=${kid}`);
    ctx.io.out(`  CREDENTIALS_PUBLIC_KEY_FILE=${pubPath}`);
    ctx.io.out(`  CREDENTIALS_PRIVATE_KEY_FILE=${keyPath}`);
  },
};

export const keysRotate: Command = {
  name: "keys:rotate",
  summary: "Re-seal every stored mailbox password from the current key pair to a new one",
  options: {
    "new-public": { type: "string", required: true, arg: "<file>", description: "New public key (from keys:generate --out-dir)" },
    "new-private": { type: "string", required: true, arg: "<file>", description: "New private key" },
    "new-kid": { type: "string", required: true, arg: "<kid>", description: "Key id of the new pair (must differ from the current one)" },
    yes: yesOpt,
  },
  async run(ctx, args) {
    const rt = await ctx.runtime();
    const oldKeys = rt.sealingKeys({ requirePrivate: true });
    const newKeys = loadSealingKeys({ kid: args.req("new-kid"), publicKeyFile: args.req("new-public"), privateKeyFile: args.req("new-private") });
    if (newKeys.kid === oldKeys.kid) throw new UsageError("--new-kid must differ from the current CREDENTIALS_KID");
    const rows = await rt.db.select().from(mailboxes).where(isNotNull(mailboxes.credentialsSealed));
    const todo = rows.filter((m) => m.credentialsKid !== newKeys.kid);
    ctx.io.out(`${todo.length} mailbox credential(s) sealed with "${oldKeys.kid}" will be re-sealed with "${newKeys.kid}".`);
    if (todo.length === 0) return 0;
    if (!args.bool("yes") && !(await ctx.io.confirm("Continue?"))) return 1;
    await rt.db.transaction(async (tx) => {
      for (const m of todo) {
        const password = openMailboxPassword(m, oldKeys);
        const sealed = sealMailboxPassword(m, password, newKeys);
        if (openMailboxPassword({ ...m, credentialsSealed: sealed.credentialsSealed }, newKeys) !== password) {
          throw new Error(`Verification failed for mailbox ${m.id}; nothing was changed`);
        }
        await tx.update(mailboxes).set(sealed).where(eq(mailboxes.id, m.id));
      }
    });
    await audit(rt.db, "credentials_key_rotated", { detail: { count: todo.length, fromKid: oldKeys.kid, toKid: newKeys.kid }, now: ctx.now() });
    ctx.io.out(`Re-sealed ${todo.length} credential(s).`);
    ctx.io.out(`Next: set CREDENTIALS_KID=${newKeys.kid} and the two key paths in .env, restart api + worker, then destroy the old private key.`);
  },
};

export const secretsGenerate: Command = {
  name: "secrets:generate",
  summary: "Print fresh random values for MASTER_KEY, APP_SECRET and LINK_SECRET (.env)",
  options: {},
  async run(ctx) {
    ctx.io.out(`MASTER_KEY=${randomBytes(32).toString("base64")}`);
    ctx.io.out(`APP_SECRET=${randomBytes(48).toString("base64url")}`);
    ctx.io.out(`LINK_SECRET=${randomBytes(48).toString("base64url")}`);
  },
};

export const dbMigrate: Command = {
  name: "db:migrate",
  summary: "Apply the committed SQL migrations (drizzle/)",
  options: {},
  async run(ctx) {
    const rt = await ctx.runtime();
    await ctx.services.runMigrations(rt.handle);
    ctx.io.out("Migrations applied.");
  },
};

export const orgCreate: Command = {
  name: "org:create",
  summary: "Create an organization",
  options: {
    name: { type: "string", required: true, arg: "<name>", description: "Organization name" },
    domains: { type: "csv", arg: "<a.example,b-gr.example>", description: "Internal mail domains (colleagues)" },
    timezone: { type: "string", arg: "<zone>", description: "IANA timezone (default DEFAULT_TIMEZONE)" },
    "holy-spirit": { type: "boolean", description: "Holy Spirit Monday (Whit Monday) is a company holiday" },
  },
  async run(ctx, args) {
    const rt = await ctx.runtime();
    const name = args.req("name").trim();
    const dup = await rt.db.select({ id: organizations.id }).from(organizations).where(sql`lower(${organizations.name}) = ${name.toLowerCase()}`);
    if (dup.length) throw new UsageError(`An organization named "${name}" already exists (${dup[0]!.id})`);
    const domains = [...new Set(args.list("domains").map((d) => d.toLowerCase().replace(/^@/, "")))];
    for (const d of domains) if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) throw new UsageError(`Invalid domain: ${d}`);
    const [org] = await rt.db
      .insert(organizations)
      .values({ name, internalDomains: domains, timezone: args.str("timezone") ?? rt.config.DEFAULT_TIMEZONE, holySpiritHoliday: args.bool("holy-spirit") })
      .returning();
    await audit(rt.db, "org_created", { orgId: org!.id, now: ctx.now() });
    ctx.io.out(`Organization created: ${org!.id}`);
  },
};

async function promptNewPassword(ctx: Parameters<Command["run"]>[0], what: string): Promise<string> {
  const pw = await ctx.io.prompt(`${what}: `, { secret: true });
  if (pw.length < MIN_PASSWORD) throw new UsageError(`Password must have at least ${MIN_PASSWORD} characters`);
  const again = await ctx.io.prompt("Repeat: ", { secret: true });
  if (again !== pw) throw new UsageError("Passwords do not match");
  return pw;
}

export const userCreate: Command = {
  name: "user:create",
  summary: "Create a web-app user (prompts for the password; argon2id)",
  options: {
    org: { type: "string", required: true, arg: "<id|name>", description: "Organization" },
    email: { type: "string", required: true, arg: "<email>", description: "Login e-mail" },
    name: { type: "string", required: true, arg: "<name>", description: "Display name" },
    admin: { type: "boolean", description: "Admin role (configuration & health only, never content)" },
    "platform-admin": { type: "boolean", description: "Platform administrator: #/admin for every organization (never content)" },
    invite: { type: "boolean", description: "No password prompt: print a one-time setup link (72 h) for the person to set it" },
    "digest-time": { type: "string", arg: "<HH:MM>", description: "Daily report time (default 07:30)" },
    "digest-start": { type: "string", arg: "<YYYY-MM-DD>", description: "First report date (go-live; shadow week before)" },
  },
  async run(ctx, args) {
    const rt = await ctx.runtime();
    const org = await findOrg(rt.db, args.req("org"));
    const email = args.req("email").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new UsageError("Invalid e-mail");
    const exists = await rt.db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${email}`);
    if (exists.length) throw new UsageError(`A user with e-mail ${email} already exists`);
    const digestTime = args.str("digest-time");
    const digestStart = args.str("digest-start");
    if (digestTime) assertHhMm(digestTime, "--digest-time");
    if (digestStart) assertIsoDate(digestStart, "--digest-start");
    const invite = args.bool("invite");
    const passwordHash = invite ? null : await ctx.services.hashPassword(await promptNewPassword(ctx, "Password"));
    const [user] = await rt.db
      .insert(users)
      .values({
        orgId: org.id,
        email,
        name: args.req("name"),
        role: args.bool("admin") ? "admin" : "member",
        platformAdmin: args.bool("platform-admin"),
        passwordHash,
        ...(digestTime ? { digestTime } : {}),
        digestStartDate: digestStart ?? null,
      })
      .returning({ id: users.id });
    await audit(rt.db, "user_created", {
      orgId: org.id,
      userId: user!.id,
      detail: { role: args.bool("admin") ? "admin" : "member", platformAdmin: args.bool("platform-admin"), invite },
      now: ctx.now(),
    });
    ctx.io.out(`User created: ${user!.id}`);
    if (invite) {
      const link = await issueSetupLink(rt.db, user!.id, ctx.now(), rt.config.APP_BASE_URL);
      ctx.io.out(`One-time setup link (valid until ${link.expiresAt.toISOString()}; send it only to ${email}):`);
      ctx.io.out(link.url);
    }
    if (rt.config.AUTH_REQUIRE_MFA) ctx.io.out("TOTP enrolment is required at the first web login.");
  },
};

export const userUpdate: Command = {
  name: "user:update",
  summary: "Change a user's report settings (time, start date, delivery, mailbox, on/off)",
  options: {
    user: { type: "string", required: true, arg: "<email|id>", description: "User" },
    name: { type: "string", arg: "<name>", description: "Display name" },
    "digest-time": { type: "string", arg: "<HH:MM>", description: "Report time (org timezone)" },
    "digest-start": { type: "string", arg: "<YYYY-MM-DD|none>", description: "First report date; none = from the mailboxes' go-live (live_since)" },
    "digest-delivery": { type: "string", arg: "<append|smtp>", description: "IMAP APPEND into the inbox or SMTP" },
    "digest-mailbox": { type: "string", arg: "<mailbox>", description: "Mailbox used to deliver the report" },
    "digest-enabled": { type: "boolean", description: "Enable (--digest-enabled) or disable (--no-digest-enabled) the report" },
  },
  async run(ctx, args) {
    const rt = await ctx.runtime();
    const user = await findUser(rt.db, args.req("user"));
    const set: Partial<typeof users.$inferInsert> = {};
    const name = args.str("name");
    if (name) set.name = name;
    const time = args.str("digest-time");
    if (time) set.digestTime = assertHhMm(time, "--digest-time");
    const start = args.str("digest-start");
    if (start) set.digestStartDate = start === "none" ? null : assertIsoDate(start, "--digest-start");
    const delivery = args.str("digest-delivery");
    if (delivery) {
      if (delivery !== "append" && delivery !== "smtp") throw new UsageError("--digest-delivery must be append or smtp");
      set.digestDelivery = delivery;
    }
    const mbRef = args.str("digest-mailbox");
    if (mbRef) {
      const mb = await findMailbox(rt.db, mbRef);
      if (mb.userId !== user.id) throw new UsageError("That mailbox belongs to another user");
      set.digestMailboxId = mb.id;
    }
    const enabled = args.flag("digest-enabled");
    if (enabled !== undefined) set.digestEnabled = enabled;
    if (Object.keys(set).length === 0) throw new UsageError("Nothing to change");
    await rt.db.update(users).set(set).where(eq(users.id, user.id));
    await audit(rt.db, "user_updated", { orgId: user.orgId, userId: user.id, detail: { fields: Object.keys(set) }, now: ctx.now() });
    ctx.io.out(`Updated: ${Object.keys(set).join(", ")}`);
  },
};

export const userMfaReset: Command = {
  name: "user:mfa-reset",
  summary: "Remove a user's TOTP and trusted devices, sign out all sessions (re-enrolment at next login)",
  options: { user: { type: "string", required: true, arg: "<email|id>", description: "User" }, yes: yesOpt },
  async run(ctx, args) {
    const rt = await ctx.runtime();
    const user = await findUser(rt.db, args.req("user"));
    if (!args.bool("yes") && !(await ctx.io.confirm(`Reset MFA for user ${user.id}?`))) return 1;
    await rt.db.transaction(async (tx) => {
      await tx.update(users).set({ totpEnabled: false, totpSecretEnc: null }).where(eq(users.id, user.id));
      await tx.delete(trustedDevices).where(eq(trustedDevices.userId, user.id));
      await tx.delete(sessions).where(eq(sessions.userId, user.id));
    });
    await audit(rt.db, "mfa_reset", { orgId: user.orgId, userId: user.id, now: ctx.now() });
    ctx.io.out("MFA reset; all sessions signed out.");
  },
};

export const setupCommands: Command[] = [keysGenerate, keysRotate, secretsGenerate, dbMigrate, orgCreate, userCreate, userUpdate, userMfaReset];

/**
 * `pnpm run setup` — first-run setup of a MailMe installation (Node.js + Postgres on this machine).
 *
 *   1. writes .env: generated secrets, the database, the web address, the AI mode (values already there are kept);
 *   2. creates the key pair that seals mailbox passwords (never overwrites one);
 *   3. creates the database if needed and applies the migrations;
 *   4. creates your organization and your account, and prints a one-time setup link;
 *   5. builds the web app.
 *
 * Safe to run again: it only adds what is missing. Run again with --new-link <e-mail> when someone lost their
 * password or phone. `pnpm run setup --help` lists the options; docs/INSTALL.md is the full guide.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { sql } from "drizzle-orm";
import { IANAZone } from "luxon";
import pg from "pg";
import { audit } from "../src/cli/context.js";
import { createTerminalIO, type CliIO } from "../src/cli/io.js";
import { defaultPgUserToLogin } from "../src/db/client.js";
import { organizations, users } from "../src/db/schema.js";
import { PUBLIC_MAIL_DOMAINS } from "../src/lib/text.js";
import { loadDotEnv } from "../src/ops/env.js";
import { issueSetupLink } from "../src/server/auth/setup-links.js";
import { EnvFile } from "./lib/envfile.js";
import { openSession, type Session } from "./lib/session.js";

const HELP = `MailMe setup — pnpm run setup [options]

Asks for anything it needs; with --yes it never asks and uses the defaults below.

  --yes                    Don't ask; use the options and defaults (scripts, CI)
  --admin-email <e-mail>   Your e-mail address: your login (needed with --yes on a new installation)
  --admin-name <name>      Your name (default: from the e-mail address)
  --org <name>             Your company or team (default "My company")
  --domains <a.com,b.com>  Your company's mail domains: mail from them counts as a colleague
                           (default: the domain of --admin-email, unless it is a free-mail domain)
  --timezone <zone>        IANA timezone, e.g. Europe/London (default: this computer's)
  --database-url <url>     postgres://user:password@host:5432/mailme (default postgres://localhost:5432/mailme)
                           or pglite://./data/pglite: embedded, one process at a time (a look around only)
  --base-url <url>         Address people open in the browser (default http://localhost:3000)
  --ai-mode <mock|claude>  mock: free, no API key, rough results (default) · claude: the Claude API
  --no-create-database     Never create the database (default: create it when it is missing)
  --skip-build             Don't build the web app
  --new-link <e-mail>      Only print a fresh one-time setup link for that account (lost password or phone)
  --account-only           Only create the organization and your account (Docker: the configuration comes from
                           docker compose; see scripts/docker-setup.sh)
  --env-file <path>        Default .env
  --help

The Anthropic API key is never a command-line option (it would land in your shell history): the setup asks for
it, or you add ANTHROPIC_API_KEY to .env yourself.`;

class SetupError extends Error {}

const DEFAULTS = {
  databaseUrl: "postgres://localhost:5432/mailme",
  baseUrl: "http://localhost:3000",
  org: "My company",
  aiMode: "mock",
} as const;

/**
 * Debian and Ubuntu's Postgres trusts your login only over its local socket (peer authentication); over TCP it wants
 * a password. When that socket exists, the socket address is the default that works without one.
 */
const DEBIAN_SOCKET_DIR = "/var/run/postgresql";
const SOCKET_URL = `postgres:///mailme?host=${DEBIAN_SOCKET_DIR}`;
function defaultDatabaseUrl(): string {
  return process.platform === "linux" && existsSync(path.join(DEBIAN_SOCKET_DIR, ".s.PGSQL.5432")) ? SOCKET_URL : DEFAULTS.databaseUrl;
}

// ── Small helpers ─────────────────────────────────────────────────────────────────────────────────────────────

function systemTimezone(): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return tz && IANAZone.isValidZone(tz) ? tz : "Europe/Athens";
}

/** postgres://user:secret@host/db → postgres://user:***@host/db (never print a password). */
function redact(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return url.replace(/:[^:@/]*@/, ":***@");
  }
}

const validators = {
  email(v: string): string | null {
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? null : "That doesn't look like an e-mail address.";
  },
  url(v: string): string | null {
    try {
      const u = new URL(v);
      if (u.protocol !== "http:" && u.protocol !== "https:") return "Use an http:// or https:// address.";
      if (u.pathname !== "/" || u.search || u.hash) return "Use the bare address, without a path (https://mail.example.com).";
      return null;
    } catch {
      return "That isn't a valid address.";
    }
  },
  databaseUrl(v: string): string | null {
    if (v.startsWith("pglite://")) return null;
    try {
      const u = new URL(v);
      if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") return "Use postgres://… or pglite://….";
      if (!/^\/[A-Za-z0-9_]+$/.test(u.pathname)) return "Add the database name at the end, e.g. …:5432/mailme (letters, digits, _).";
      return null;
    } catch {
      return "That isn't a valid postgres:// address.";
    }
  },
  aiMode(v: string): string | null {
    return v === "mock" || v === "claude" ? null : "Answer mock or claude.";
  },
  timezone(v: string): string | null {
    return IANAZone.isValidZone(v) ? null : "Unknown timezone; use a name like Europe/London or America/New_York.";
  },
  domains(v: string): string | null {
    for (const d of splitDomains(v)) if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) return `Not a domain: ${d}`;
    return null;
  },
  name(v: string): string | null {
    return v.trim().length >= 1 && v.trim().length <= 200 ? null : "Give a name.";
  },
};

function splitDomains(v: string): string[] {
  return [...new Set(v.split(",").map((d) => d.trim().toLowerCase().replace(/^@/, "")).filter(Boolean))];
}

function nameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? "";
  const words = local.split(/[._-]+/).filter(Boolean);
  return words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ") || "Admin";
}

// ── Steps ─────────────────────────────────────────────────────────────────────────────────────────────────────

interface Ui {
  io: CliIO;
  yes: boolean;
  /** One question. With --yes, the default is the answer (missing → error naming the option). */
  ask(question: string, opts: { def?: string; flag: string; validate?: (v: string) => string | null; secret?: boolean; optional?: boolean }): Promise<string>;
  confirm(question: string, def: boolean): Promise<boolean>;
  step(title: string): void;
  ok(text: string): void;
  warn(text: string): void;
}

function createUi(io: CliIO, yes: boolean): Ui {
  return {
    io,
    yes,
    async ask(question, o) {
      if (yes) {
        if (o.def === undefined) {
          if (o.optional) return "";
          throw new SetupError(`${o.flag} is needed with --yes`);
        }
        const problem = o.validate?.(o.def);
        if (problem) throw new SetupError(`${o.flag}: ${problem}`);
        return o.def;
      }
      for (;;) {
        const shown = o.def ? `${question} [${o.def}]: ` : `${question}: `;
        const answer = (await io.prompt(shown, o.secret ? { secret: true } : undefined)).trim() || o.def || "";
        if (!answer && o.optional) return "";
        const problem = answer ? (o.validate?.(answer) ?? null) : "An answer is needed.";
        if (!problem) return answer;
        io.err(`  ${problem}`);
      }
    },
    async confirm(question, def) {
      if (yes) return def;
      const answer = (await io.prompt(`${question} ${def ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
      return answer === "" ? def : /^(y|yes)$/.test(answer);
    },
    step(title) {
      io.out(`\n${title}`);
    },
    ok(text) {
      io.out(`  ✓ ${text}`);
    },
    warn(text) {
      io.out(`  ! ${text}`);
    },
  };
}

type Opts = ReturnType<typeof readOptions>;

function readOptions(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      yes: { type: "boolean", short: "y" },
      "admin-email": { type: "string" },
      "admin-name": { type: "string" },
      org: { type: "string" },
      domains: { type: "string" },
      timezone: { type: "string" },
      "database-url": { type: "string" },
      "base-url": { type: "string" },
      "ai-mode": { type: "string" },
      "no-create-database": { type: "boolean" },
      "skip-build": { type: "boolean" },
      "new-link": { type: "string" },
      "account-only": { type: "boolean" },
      "env-file": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  return values;
}

/** Step 1: .env. Returns the effective values (what the processes will read). */
async function configure(ui: Ui, opts: Opts, envPath: string) {
  ui.step("1. Configuration (.env)");
  const file = EnvFile.open(envPath, readFileSync(".env.example", "utf8"));
  // A brand-new file starts from .env.example, whose defaults are only suggestions: the answers replace them.
  // In an existing file every value that is there stays.
  const fresh = !file.existed;
  const has = (key: string) => !fresh && file.get(key) !== undefined;
  const added: string[] = [];
  const set = (key: string, value: string) => {
    if (fresh) file.forceSet(key, value);
    else if (file.setIfUnset(key, value) === "kept") return;
    added.push(key);
  };

  for (const [key, bytes, enc] of [
    ["MASTER_KEY", 32, "base64"],
    ["APP_SECRET", 48, "base64url"],
    ["LINK_SECRET", 48, "base64url"],
  ] as const) {
    if (!has(key)) set(key, randomBytes(bytes).toString(enc));
  }

  if (!has("DATABASE_URL")) {
    if (!ui.yes) ui.io.out("  Database: a Postgres address, or pglite://./data/pglite to look around without Postgres (one process only).");
    set("DATABASE_URL", await ui.ask("  Database", { def: opts["database-url"] ?? defaultDatabaseUrl(), flag: "--database-url", validate: validators.databaseUrl }));
  } else if (opts["database-url"] && opts["database-url"] !== file.get("DATABASE_URL")) {
    ui.warn(`DATABASE_URL is already in ${envPath}; keeping it (edit the file to change it).`);
  }

  if (!has("APP_BASE_URL")) {
    const url = await ui.ask("  Web address of MailMe", { def: opts["base-url"] ?? DEFAULTS.baseUrl, flag: "--base-url", validate: validators.url });
    set("APP_BASE_URL", url.replace(/\/+$/, ""));
  } else if (opts["base-url"] && opts["base-url"].replace(/\/+$/, "") !== file.get("APP_BASE_URL")) {
    ui.warn(`APP_BASE_URL is already in ${envPath}; keeping it (edit the file to change it).`);
  }

  if (!has("DEFAULT_TIMEZONE")) {
    set("DEFAULT_TIMEZONE", await ui.ask("  Timezone", { def: opts.timezone ?? systemTimezone(), flag: "--timezone", validate: validators.timezone }));
  }

  if (!has("AI_MODE")) {
    if (!ui.yes) {
      ui.io.out("  AI: mock is free and needs no key, but its results are rough (fine for trying MailMe out).");
      ui.io.out("      claude reads your mail with the Claude API: needs an Anthropic API key and costs money per message.");
    }
    set("AI_MODE", await ui.ask("  AI (mock or claude)", { def: opts["ai-mode"] ?? DEFAULTS.aiMode, flag: "--ai-mode", validate: validators.aiMode }));
  } else if (opts["ai-mode"] && opts["ai-mode"] !== file.get("AI_MODE")) {
    ui.warn(`AI_MODE is already in ${envPath}; keeping it (edit the file to change it).`);
  }
  const aiMode = file.get("AI_MODE") ?? DEFAULTS.aiMode;
  if (aiMode === "claude" && file.get("ANTHROPIC_API_KEY") === undefined && !process.env.ANTHROPIC_API_KEY) {
    const key = await ui.ask("  Anthropic API key (Enter to add it to .env later)", { flag: "ANTHROPIC_API_KEY", secret: true, optional: true });
    if (key) set("ANTHROPIC_API_KEY", key);
  }

  for (const [key, value] of [
    ["CREDENTIALS_KID", "k1"],
    ["CREDENTIALS_PUBLIC_KEY_FILE", "./data/keys/credentials.pub.pem"],
    ["CREDENTIALS_PRIVATE_KEY_FILE", "./data/keys/credentials.key.pem"],
  ] as const) {
    if (!has(key)) set(key, value);
  }

  file.save(envPath);
  if (fresh) ui.ok(`${envPath} created (owner-only permissions), with new secrets`);
  else if (added.length) ui.ok(`${envPath}: added ${added.join(", ")}; every value already there was kept`);
  else ui.ok(`${envPath} is complete; nothing changed`);

  // Variables already set in the shell win over .env (for every MailMe process, not only this one).
  const overridable = ["DATABASE_URL", "APP_BASE_URL", "HOST", "PORT", "TRUST_PROXY", "AUTH_REQUIRE_MFA", "AI_MODE",
    "DEFAULT_TIMEZONE", "MASTER_KEY", "APP_SECRET", "LINK_SECRET", "CREDENTIALS_KID", "CREDENTIALS_PUBLIC_KEY_FILE",
    "CREDENTIALS_PRIVATE_KEY_FILE"];
  for (const key of overridable) {
    const shell = process.env[key];
    if (shell !== undefined && shell !== file.get(key)) ui.warn(`${key} is set in your shell and overrides ${envPath}: unset it, or MailMe uses the shell's value.`);
  }
  loadDotEnv(envPath);
  if (aiMode === "claude" && !process.env.ANTHROPIC_API_KEY) ui.warn("AI_MODE=claude but no ANTHROPIC_API_KEY yet: add it to .env before you start the worker.");
}

/** Step 2: the X25519 key pair for mailbox passwords. */
async function ensureKeys(ui: Ui, session: Session) {
  ui.step("2. Keys for mailbox passwords");
  const cfg = session.config();
  const pub = cfg.CREDENTIALS_PUBLIC_KEY_FILE;
  const priv = cfg.CREDENTIALS_PRIVATE_KEY_FILE;
  if (!priv) throw new SetupError("CREDENTIALS_PRIVATE_KEY_FILE is empty in .env; set it to ./data/keys/credentials.key.pem");
  const present = [pub, priv].filter((p) => existsSync(p));
  if (present.length === 2) {
    ui.ok(`kept the existing key pair (${pub}, ${priv})`);
    return;
  }
  if (present.length === 1) {
    throw new SetupError(
      `Only one of the two key files exists (${present[0]}). Mailbox passwords sealed with the old pair can't be opened without both. ` +
        `Restore the missing file, or — if no mailbox is connected yet — delete ${present[0]} and run the setup again.`,
    );
  }
  const r = await session.run(["keys:generate"], { quiet: true });
  if (r.code !== 0) throw new SetupError("Creating the key pair failed (see above).");
  ui.ok(`created ${pub} and ${priv} (private, owner-only: never commit or back it up with the database)`);
}

/** Step 3: reach Postgres, create the database when it's missing, apply the migrations. */
async function ensureDatabase(ui: Ui, session: Session, opts: Opts) {
  ui.step("3. Database");
  const url = session.config().DATABASE_URL;
  if (url.startsWith("pglite://")) {
    const dir = url.slice("pglite://".length);
    if (dir && dir !== "memory") mkdirSync(path.dirname(path.resolve(dir)), { recursive: true, mode: 0o700 });
    ui.ok(`embedded database (${dir}) — one MailMe process at a time`);
  } else {
    await reachPostgres(ui, url, !opts["no-create-database"]);
  }
  const r = await session.run(["db:migrate"], { quiet: true });
  if (r.code !== 0) throw new SetupError("The migrations failed (see above).");
  ui.ok("tables are up to date (migrations applied)");
}

async function reachPostgres(ui: Ui, url: string, mayCreate: boolean) {
  defaultPgUserToLogin();
  const shown = redact(url);
  const tryConnect = async (u: string) => {
    const client = new pg.Client({ connectionString: u, connectionTimeoutMillis: 8000 });
    try {
      await client.connect();
      await client.query("select 1");
      return null;
    } catch (err) {
      return err as NodeJS.ErrnoException;
    } finally {
      await client.end().catch(() => undefined);
    }
  };
  const err = await tryConnect(url);
  if (!err) {
    ui.ok(`connected to ${shown}`);
    return;
  }
  const u = new URL(url);
  if (err.code === "3D000") {
    const name = u.pathname.slice(1);
    if (!mayCreate || !(await ui.confirm(`  The database "${name}" doesn't exist yet. Create it?`, true))) {
      throw new SetupError(`The database "${name}" doesn't exist. Create it (createdb ${name}) and run the setup again.`);
    }
    let created = false;
    let lastError: unknown = null;
    for (const maintenance of ["postgres", "template1"]) {
      const admin = new URL(url);
      admin.pathname = `/${maintenance}`;
      const client = new pg.Client({ connectionString: admin.toString(), connectionTimeoutMillis: 8000 });
      try {
        await client.connect();
        await client.query(`CREATE DATABASE "${name}"`); // name checked: [A-Za-z0-9_]+
        created = true;
        break;
      } catch (e) {
        lastError = e;
      } finally {
        await client.end().catch(() => undefined);
      }
    }
    if (!created) {
      const why = lastError instanceof Error ? lastError.message : String(lastError);
      throw new SetupError(`Couldn't create the database "${name}" (${why}). Create it yourself (createdb ${name}, or as a Postgres superuser) and run the setup again.`);
    }
    ui.ok(`created the database "${name}"`);
    return;
  }
  const socket = u.searchParams.get("host");
  const where = socket ? `the socket in ${socket}` : `${u.hostname}:${u.port || 5432}`;
  const fixIt = "Fix DATABASE_URL in .env, then run the setup again.";
  if (["ECONNREFUSED", "ENOENT", "ENOTFOUND", "EHOSTUNREACH", "ETIMEDOUT"].includes(err.code ?? "") || /timeout/i.test(err.message)) {
    throw new SetupError(
      [
        `Can't reach Postgres at ${where} (${err.code ?? err.message}). Start it first, for example:`,
        "    macOS (Homebrew):  brew install postgresql@16 && brew services start postgresql@16",
        "    Debian/Ubuntu:     sudo apt install postgresql",
        "    Docker:            docker run -d --name mailme-postgres -e POSTGRES_PASSWORD=<password> -p 5432:5432 postgres:16-alpine",
        "                       (then DATABASE_URL=postgres://postgres:<password>@localhost:5432/mailme)",
        "Or look around without Postgres: DATABASE_URL=pglite://./data/pglite in .env.",
      ].join("\n"),
    );
  }
  if (err.code === "28P01" || /client password must be a string|password authentication failed|no password/i.test(err.message)) {
    throw new SetupError(
      [
        `Postgres wants a (different) password for ${shown}. Either:`,
        "    put it in the address:  postgres://<user>:<password>@localhost:5432/mailme",
        `    or, on Debian/Ubuntu, use the local socket, which needs none:  ${SOCKET_URL}`,
        `                            (once: sudo -u postgres createuser --createdb "$USER")`,
        fixIt,
      ].join("\n"),
    );
  }
  if (err.code === "28000" && /role .* does not exist/i.test(err.message)) {
    throw new SetupError(`${err.message}. Create a Postgres role for this login that may create databases (Debian/Ubuntu: sudo -u postgres createuser --createdb "$USER"), or put another user in DATABASE_URL (.env).`);
  }
  if (err.code === "28000") {
    throw new SetupError(`Postgres refused the connection to ${shown} (${err.message}). Check its pg_hba.conf, or use another address. ${fixIt}`);
  }
  throw new SetupError(`Can't use the database ${shown}: ${err.message}`);
}

/** Step 4: organization + first account (administrator of the installation), or a new setup link on a re-run. */
async function ensureAccount(ui: Ui, session: Session, opts: Opts): Promise<{ link: string | null; email: string | null }> {
  ui.step("4. Your account");
  const rt = await session.runtime();
  const cfg = session.config();

  if (opts["new-link"]) return newLink(ui, session, opts["new-link"]);

  const existingUsers = await rt.db.select({ id: users.id, email: users.email, passwordHash: users.passwordHash }).from(users);
  const wanted = opts["admin-email"]?.trim().toLowerCase();
  if (existingUsers.length > 0 && (!wanted || existingUsers.some((u) => u.email.toLowerCase() === wanted))) {
    const me = wanted ? existingUsers.find((u) => u.email.toLowerCase() === wanted)! : existingUsers[0]!;
    ui.ok(`${existingUsers.length} account(s) already exist; nothing to create`);
    // An account nobody has set up yet (its link expired?) gets a fresh link; one with a password never does unasked.
    if (existingUsers.length === 1 && !me.passwordHash) {
      if (await ui.confirm(`  ${me.email} hasn't chosen a password yet. Print a new setup link?`, true)) return newLink(ui, session, me.email);
    } else {
      ui.io.out("  Lost a password or phone? pnpm run setup --new-link <e-mail>");
    }
    return { link: null, email: me.email };
  }

  const email = (await ui.ask("  Your e-mail address (your login)", { def: opts["admin-email"], flag: "--admin-email", validate: validators.email })).toLowerCase();
  const name = await ui.ask("  Your name", { def: opts["admin-name"] ?? nameFromEmail(email), flag: "--admin-name", validate: validators.name });

  const orgs = await rt.db.select({ id: organizations.id, name: organizations.name }).from(organizations);
  let orgName: string;
  if (orgs.length === 1 && !opts.org) {
    orgName = orgs[0]!.name;
    ui.ok(`organization "${orgName}" already exists`);
  } else {
    orgName = (await ui.ask("  Your company or team", { def: opts.org ?? DEFAULTS.org, flag: "--org", validate: validators.name })).trim();
    if (orgs.some((o) => o.name.toLowerCase() === orgName.toLowerCase())) {
      ui.ok(`organization "${orgName}" already exists`);
    } else {
      const domain = email.split("@")[1]!;
      const defDomains = opts.domains ?? (PUBLIC_MAIL_DOMAINS.has(domain) ? "" : domain);
      if (!ui.yes) ui.io.out("  Company mail domains: mail from these domains counts as a colleague (empty if you use a free-mail address).");
      const domains = await ui.ask("  Domains, comma-separated", { def: defDomains || undefined, flag: "--domains", validate: validators.domains, optional: true });
      const timezone = await ui.ask("  Timezone of the organization", { def: opts.timezone ?? cfg.DEFAULT_TIMEZONE, flag: "--timezone", validate: validators.timezone });
      const argv = ["org:create", "--name", orgName, "--timezone", timezone];
      const list = splitDomains(domains);
      if (list.length) argv.push("--domains", list.join(","));
      const r = await session.run(argv, { quiet: true });
      if (r.code !== 0) throw new SetupError("Creating the organization failed (see above).");
      ui.ok(`organization "${orgName}" created`);
    }
  }

  const r = await session.run(["user:create", "--org", orgName, "--email", email, "--name", name, "--admin", "--platform-admin", "--invite"], { quiet: true });
  if (r.code !== 0) throw new SetupError("Creating your account failed (see above).");
  ui.ok(`account ${email} created (administrator of this installation)`);
  const base = cfg.APP_BASE_URL.replace(/\/+$/, "");
  const link = r.out.map((l) => l.trim()).find((l) => l.startsWith(`${base}/`)) ?? null;
  if (!link) throw new SetupError("The account was created, but no setup link was printed. Run: pnpm run setup --new-link " + email);
  return { link, email };
}

async function newLink(ui: Ui, session: Session, emailArg: string): Promise<{ link: string; email: string }> {
  const rt = await session.runtime();
  const email = emailArg.trim().toLowerCase();
  const [user] = await rt.db
    .select({ id: users.id, orgId: users.orgId, disabledAt: users.disabledAt })
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`);
  if (!user) throw new SetupError(`No account with the e-mail ${email}.`);
  if (user.disabledAt) throw new SetupError(`The account ${email} is disabled; enable it first (Admin page).`);
  const l = await issueSetupLink(rt.db, user.id, new Date(), session.config().APP_BASE_URL);
  await audit(rt.db, "setup_link", { orgId: user.orgId, userId: user.id, detail: { target: user.id }, now: new Date() });
  ui.ok(`new setup link for ${email} (any older link stopped working; using it sets a new password and two-step sign-in)`);
  return { link: l.url, email };
}

/** Step 5: the web app (web/dist), served by the API. */
function buildWeb(ui: Ui, opts: Opts) {
  ui.step("5. Web app");
  if (opts["skip-build"]) {
    ui.ok("skipped (--skip-build); build it with: pnpm build:web");
    return;
  }
  if (existsSync("web/dist/index.html")) {
    ui.ok("already built (web/dist); after an update run: pnpm build:web");
    return;
  }
  const vite = path.join("node_modules", "vite", "bin", "vite.js");
  if (!existsSync(vite)) throw new SetupError("Dependencies are missing: run pnpm install first.");
  ui.io.out("  building… (about a minute)");
  const r = spawnSync(process.execPath, [vite, "build", "--config", "web/vite.config.ts", "--logLevel", "error"], { stdio: "inherit" });
  if (r.status !== 0) throw new SetupError("The web app build failed (see above). Fix it, then run: pnpm build:web");
  ui.ok("built (web/dist)");
}

function nextSteps(ui: Ui, session: Session, account: { link: string | null; email: string | null }) {
  const cfg = session.config();
  const pglite = cfg.DATABASE_URL.startsWith("pglite://");
  const out = (s = "") => ui.io.out(s);
  out("\nDone. Next:");
  out("");
  if (pglite) {
    out("  1. Start MailMe:  pnpm start:api");
    out("     The embedded database allows one MailMe process, so there is no worker: no mail sync and no daily report.");
    out("     To read real mail, put a Postgres DATABASE_URL in .env and run pnpm run setup again.");
  } else {
    out("  1. Start MailMe, in two terminals (or see docs/INSTALL.md for running it as a service):");
    out("       pnpm start:api       the web app and API");
    out("       pnpm start:worker    reads mail, runs the AI, sends the daily report");
  }
  out("");
  if (account.link) {
    out(`  2. Open this link (valid for 72 hours; it is for ${account.email} only):`);
    out(`       ${account.link}`);
    out("     Choose your password, then scan the QR code with an authenticator app (two-step sign-in).");
  } else {
    out(`  2. Sign in at ${cfg.APP_BASE_URL}`);
  }
  const httpRemote = (() => {
    const u = new URL(cfg.APP_BASE_URL);
    return u.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  })();
  if (httpRemote) ui.warn(`${cfg.APP_BASE_URL} is plain http and not localhost: browsers won't keep the sign-in cookie. Use https (docs/INSTALL.md § HTTPS for a local install).`);
  out("");
  out("  3. Connect your mailbox: Settings → Mailboxes → + Add (Gmail, iCloud and Yahoo need an app password).");
  out("     Guide: docs/INSTALL.md § Connect a mailbox");
  if (cfg.AI_MODE === "mock") {
    out("");
    out("  AI is in mock mode (free, rough results). For real results set AI_MODE=claude and ANTHROPIC_API_KEY in .env,");
    out("  then restart the worker.");
  }
  out("");
}

// ── Main ──────────────────────────────────────────────────────────────────────────────────────────────────────

async function main(argv: string[]): Promise<number> {
  let opts: Opts;
  try {
    opts = readOptions(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error("Run: pnpm run setup --help");
    return 2;
  }
  if (opts.help) {
    console.log(HELP);
    return 0;
  }
  const major = Number(process.versions.node.split(".")[0]);
  if (!(major >= 22)) {
    console.error(`MailMe needs Node.js 22 or newer; this is ${process.version}.`);
    return 1;
  }
  // In the Docker image there is no .env.example: the configuration comes from docker compose.
  const accountOnly = Boolean(opts["new-link"] || opts["account-only"]);
  if (!existsSync("package.json") || !existsSync("drizzle") || (!accountOnly && !existsSync(".env.example"))) {
    console.error("Run the setup from the MailMe folder (the one with package.json): pnpm run setup");
    return 1;
  }
  const envPath = opts["env-file"] ?? ".env";
  const io = createTerminalIO();
  const ui = createUi(io, Boolean(opts.yes));
  let session: Session | null = null;
  try {
    io.out("MailMe setup");
    if (accountOnly) loadDotEnv(envPath);
    else await configure(ui, opts, envPath);
    session = openSession(io);
    try {
      session.config();
    } catch (err) {
      throw new SetupError(`The configuration is not valid yet: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (accountOnly) {
      const account = await ensureAccount(ui, session, opts);
      if (account.link) io.out(`\nOpen this link (valid for 72 hours; it is for ${account.email} only):\n  ${account.link}\n`);
      return 0;
    }
    await ensureKeys(ui, session);
    await ensureDatabase(ui, session, opts);
    const account = await ensureAccount(ui, session, opts);
    await session.close();
    session = null;
    buildWeb(ui, opts);
    nextSteps(ui, openSession(io), account);
    return 0;
  } catch (err) {
    if (err instanceof SetupError) {
      io.err(`\n${err.message}`);
      return 1;
    }
    if (err instanceof Error && err.message === "input closed") {
      io.err("\nSetup stopped: no more input. Run it in a terminal, or pass --yes with the options (pnpm run setup --help).");
      return 1;
    }
    throw err;
  } finally {
    await session?.close();
    io.close();
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  },
);

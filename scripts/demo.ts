/**
 * `pnpm run demo` — MailMe with sample mail, on this machine, in about two minutes.
 *
 * No Postgres, no mailbox, no API key: an embedded database in data/demo, eight sample messages dated today and
 * yesterday, the mock AI (no network), then the web app on http://localhost:3000. Every run starts a fresh demo.
 * It never reads or changes .env or your real installation; delete data/demo to remove it.
 *
 * AI_MODE is auto, as in a real installation, so Admin → AI looks the way it will there. AI keys in your shell are
 * removed first: with no AI chosen and no key, auto runs the free mock, so the demo never calls a paid AI (and never
 * pauses).
 */
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { eq, sql } from "drizzle-orm";
import { IANAZone } from "luxon";
import { AI_KEY_ENV } from "../src/ai/providers.js";
import { createTerminalIO } from "../src/cli/io.js";
import { tasks, users } from "../src/db/schema.js";
import { openSession } from "./lib/session.js";

const DEMO_DIR = path.join("data", "demo");
const MARKER = path.join(DEMO_DIR, ".mailme-demo");

const OWNER = { name: "Sam Taylor", email: "sam@contoso.example" };
const ORG = { name: "Contoso (demo)", domain: "contoso.example" };

const HELP = `MailMe demo — pnpm run demo [--port 3000] [--no-start]

Creates a throwaway demo in ${DEMO_DIR} (embedded database, sample mail, mock AI) and starts the web app.
Each run replaces the previous demo. It never touches .env or a real installation, and it ignores AI keys
in your shell: the demo never calls a paid AI.

  --port <n>     Port of the web app (default 3000)
  --no-start     Prepare the demo and stop (CI); start it later with: pnpm run demo
  --help`;

// ── Sample mail ───────────────────────────────────────────────────────────────────────────────────────────────

interface Sample {
  file: string;
  /** Minutes before now. */
  ago: number;
  outbound?: boolean;
  from: string;
  to: string;
  subject: string;
  id: string;
  inReplyTo?: string;
  headers?: string[];
  body: string;
}

const SAMPLES: Sample[] = [
  {
    file: "01-quotation-request.eml",
    ago: 50 * 60,
    from: "Priya Shah <priya@northwind.example>",
    to: `${OWNER.name} <${OWNER.email}>`,
    subject: "Quotation for 40 ceiling speakers",
    id: "demo-quote-1@northwind.example",
    body: [
      "Hi Sam,",
      "",
      "Could you send us a quotation for 40 ceiling speakers and 4 amplifiers by Friday? We need it for our budget meeting next week.",
      "",
      "Thanks,",
      "Priya Shah",
      "Purchasing, Northwind Traders",
    ].join("\n"),
  },
  {
    file: "02-quotation-promise.eml",
    ago: 49 * 60,
    outbound: true,
    from: `${OWNER.name} <${OWNER.email}>`,
    to: "Priya Shah <priya@northwind.example>",
    subject: "Re: Quotation for 40 ceiling speakers",
    id: "demo-quote-2@contoso.example",
    inReplyTo: "demo-quote-1@northwind.example",
    body: ["Hi Priya,", "", "Thanks for asking. I'll send you the quotation by Thursday.", "", "Best regards,", "Sam"].join("\n"),
  },
  {
    file: "03-delivery-address.eml",
    ago: 26 * 60,
    from: "Daniel Brooks <daniel@fabrikam.example>",
    to: `${OWNER.name} <${OWNER.email}>`,
    subject: "Delivery of order PO-2291",
    id: "demo-delivery-1@fabrikam.example",
    body: [
      "Hello Sam,",
      "",
      "The amplifiers for order PO-2291 are ready and will ship on Monday.",
      "Please confirm the delivery address by Wednesday, so the courier can book the slot.",
      "",
      "Kind regards,",
      "Daniel Brooks",
      "Fabrikam Logistics",
    ].join("\n"),
  },
  {
    file: "04-stock-question.eml",
    ago: 24 * 60,
    outbound: true,
    from: `${OWNER.name} <${OWNER.email}>`,
    to: "Jordan Lee <jordan@contoso.example>",
    subject: "HDMI cables in stock?",
    id: "demo-stock-1@contoso.example",
    body: ["Hi Jordan,", "", "Could you check how many HDMI cables we have in stock and let me know by tomorrow?", "", "Thanks,", "Sam"].join("\n"),
  },
  {
    file: "05-out-of-office.eml",
    ago: 24 * 60 - 1,
    from: "Jordan Lee <jordan@contoso.example>",
    to: `${OWNER.name} <${OWNER.email}>`,
    subject: "Automatic reply: HDMI cables in stock?",
    id: "demo-stock-2@contoso.example",
    inReplyTo: "demo-stock-1@contoso.example",
    headers: ["Auto-Submitted: auto-replied", "X-Auto-Response-Suppress: All"],
    body: ["I am out of the office until Monday and will reply when I am back.", "", "Jordan"].join("\n"),
  },
  {
    file: "06-newsletter.eml",
    ago: 3 * 60,
    from: "Tailspin Audio <news@tailspin.example>",
    to: OWNER.email,
    subject: "Tailspin Audio: this month's new speakers",
    id: "demo-news-1@tailspin.example",
    headers: ["List-Unsubscribe: <https://tailspin.example/unsubscribe>", "Precedence: bulk"],
    body: [
      "This month at Tailspin Audio: three new outdoor speakers and a 20% discount on all amplifiers.",
      "",
      "See the full range on our website.",
      "",
      "You receive this newsletter because you subscribed. Unsubscribe: https://tailspin.example/unsubscribe",
    ].join("\n"),
  },
  {
    file: "07-service-request.eml",
    ago: 60,
    from: "Alex Kim <alex@contoso.example>",
    to: `${OWNER.name} <${OWNER.email}>`,
    subject: "Woodgrove projector",
    id: "demo-service-1@contoso.example",
    body: [
      "Hi Sam,",
      "",
      "Can you handle the Woodgrove service request? Their meeting-room projector stopped working and they need an answer today, it's urgent.",
      "",
      "Alex",
    ].join("\n"),
  },
  {
    file: "08-thank-you.eml",
    ago: 20,
    from: "Lucas Martin <lucas@woodgrove.example>",
    to: `${OWNER.name} <${OWNER.email}>`,
    subject: "Thank you",
    id: "demo-thanks-1@woodgrove.example",
    body: ["Hi Sam,", "", "Thanks for the quick help with the sound system last week. Everything works perfectly now.", "", "Have a nice weekend,", "Lucas"].join("\n"),
  },
];

function toEml(s: Sample, now: Date): string {
  const date = new Date(now.getTime() - s.ago * 60_000);
  const lines = [
    `From: ${s.from}`,
    `To: ${s.to}`,
    `Subject: ${s.subject}`,
    `Date: ${date.toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${s.id}>`,
    ...(s.inReplyTo ? [`In-Reply-To: <${s.inReplyTo}>`, `References: <${s.inReplyTo}>`] : []),
    ...(s.headers ?? []),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    s.body,
    "",
  ];
  return lines.join("\r\n");
}

// ── Main ──────────────────────────────────────────────────────────────────────────────────────────────────────

function systemTimezone(): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return tz && IANAZone.isValidZone(tz) ? tz : "Europe/Athens";
}

async function main(argv: string[]): Promise<number> {
  const { values: opts } = parseArgs({
    args: argv,
    strict: true,
    options: { port: { type: "string" }, "no-start": { type: "boolean" }, help: { type: "boolean", short: "h" } },
  });
  if (opts.help) {
    console.log(HELP);
    return 0;
  }
  if (!existsSync("package.json") || !existsSync("drizzle")) {
    console.error("Run the demo from the MailMe folder (the one with package.json): pnpm run demo");
    return 1;
  }
  const port = Number(opts.port ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error("--port must be a TCP port");
    return 2;
  }

  // A fresh demo every run — but only ever delete a folder this script created.
  if (existsSync(DEMO_DIR)) {
    if (!existsSync(MARKER)) {
      console.error(`${DEMO_DIR} exists but wasn't made by the demo; move it away first.`);
      return 1;
    }
    rmSync(DEMO_DIR, { recursive: true, force: true });
  }
  mkdirSync(path.join(DEMO_DIR, "mail", "inbox"), { recursive: true, mode: 0o700 });
  mkdirSync(path.join(DEMO_DIR, "mail", "sent"), { recursive: true, mode: 0o700 });
  writeFileSync(MARKER, "Created by pnpm run demo. Safe to delete.\n");

  const password = randomBytes(12).toString("base64url");
  const timezone = systemTimezone();
  const env: Record<string, string> = {
    NODE_ENV: "development",
    LOG_LEVEL: "warn",
    DATABASE_URL: `pglite://./${DEMO_DIR}/db`,
    APP_BASE_URL: `http://localhost:${port}`,
    PORT: String(port),
    HOST: "127.0.0.1",
    MASTER_KEY: randomBytes(32).toString("base64"),
    APP_SECRET: randomBytes(48).toString("base64url"),
    LINK_SECRET: randomBytes(48).toString("base64url"),
    CREDENTIALS_KID: "demo",
    CREDENTIALS_PUBLIC_KEY_FILE: `./${DEMO_DIR}/keys/credentials.pub.pem`,
    CREDENTIALS_PRIVATE_KEY_FILE: `./${DEMO_DIR}/keys/credentials.key.pem`,
    // auto with no AI chosen and no key runs the free mock (the provider keys are removed from the environment below).
    AI_MODE: "auto",
    DEFAULT_TIMEZONE: timezone,
    // Local demo with sample data on 127.0.0.1 only: no two-step sign-in, so you can look around at once.
    AUTH_REQUIRE_MFA: "false",
    TRUST_PROXY: "loopback",
    DATA_DIR: `./${DEMO_DIR}`,
    DENY_LIST: "",
  };
  // The demo's own settings win over the shell's, and it never reads .env (the API reads MAILME_ENV_FILE instead).
  // No AI key from the shell either, so the sample mail is read by the free mock, never by a paid provider.
  const aiKeys = [...Object.values(AI_KEY_ENV), "ANTHROPIC_AUTH_TOKEN", "GOOGLE_API_KEY"];
  for (const key of ["TICK_JOB", "ALERT_WEBHOOK_URL", "HEALTHCHECK_PING_URL", "BACKUP_MARKER_FILE", "BACKUP_DIR", "PLATFORM_MAIL_DOMAIN", ...aiKeys]) delete process.env[key];
  Object.assign(process.env, env);
  const envFile = path.join(DEMO_DIR, "env");
  writeFileSync(envFile, Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
  process.env.MAILME_ENV_FILE = envFile;

  const io = createTerminalIO();
  const session = openSession(io);
  const step = async (what: string, argv: string[], answers?: string[]) => {
    const r = await session.run(argv, { quiet: true, ...(answers ? { answers } : {}) });
    if (r.code !== 0) throw new Error(`${what} failed (pnpm cli ${argv[0]}).`);
    return r;
  };
  try {
    io.out("MailMe demo");
    io.out(`  preparing a throwaway demo in ${DEMO_DIR}…`);
    await step("Creating keys", ["keys:generate"]);
    await step("Creating the database", ["db:migrate"]);
    await step("Creating the organization", ["org:create", "--name", ORG.name, "--domains", ORG.domain, "--timezone", timezone]);
    await step("Creating the demo account", ["user:create", "--org", ORG.name, "--email", OWNER.email, "--name", OWNER.name, "--admin", "--platform-admin"], [password, password]);
    await step("Creating the mailbox", [
      "mailbox:add",
      "--provider",
      "ingest",
      "--user",
      OWNER.email,
      "--address",
      OWNER.email,
      "--display-name",
      OWNER.name,
      "--live-since",
      "now",
    ]);

    const now = new Date();
    for (const s of SAMPLES) writeFileSync(path.join(DEMO_DIR, "mail", s.outbound ? "sent" : "inbox", s.file), toEml(s, now));
    await step("Importing the sample mail", ["import:eml", "--mailbox", OWNER.email, path.join(DEMO_DIR, "mail", "inbox")]);
    await step("Importing the sample sent mail", ["import:eml", "--mailbox", OWNER.email, "--outbound", path.join(DEMO_DIR, "mail", "sent")]);
    io.out(`  the mock AI reads ${SAMPLES.length} sample messages…`);
    await step("Analysing the sample mail", ["drain:once", "--mailbox", OWNER.email, "--no-settle", "--yes"]);

    const rt = await session.runtime();
    const [owner] = await rt.db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${OWNER.email}`);
    const [{ n } = { n: 0 }] = await rt.db.select({ n: sql<number>`count(*)::int` }).from(tasks).where(eq(tasks.userId, owner!.id));
    if (n === 0) throw new Error("The sample mail produced no tasks; the demo can't show anything. Please report this as a bug.");
    const report = path.join(DEMO_DIR, "daily-report.html");
    await step("Rendering the daily report", ["digest:preview", "--user", OWNER.email, "--out", report]);
    await session.close();
    io.out(`  ✓ ${n} tasks from ${SAMPLES.length} messages; daily report preview: ${report}`);

    if (!existsSync("web/dist/index.html")) {
      const vite = path.join("node_modules", "vite", "bin", "vite.js");
      if (!existsSync(vite)) throw new Error("Dependencies are missing: run pnpm install first.");
      io.out("  building the web app… (about a minute, only the first time)");
      const r = spawnSync(process.execPath, [vite, "build", "--config", "web/vite.config.ts", "--logLevel", "error"], { stdio: "inherit" });
      if (r.status !== 0) throw new Error("The web app build failed (see above).");
    }

    const signIn = [`  Open      http://localhost:${port}`, `  E-mail    ${OWNER.email}`, `  Password  ${password}`];
    if (opts["no-start"]) {
      io.out("\nDemo ready. Start it with: pnpm run demo  (a new run makes a fresh demo)");
      return 0;
    }
    io.close();
    const { startApi } = await import("../src/server/main.js");
    await startApi();
    console.log(["", "MailMe demo is running.", "", ...signIn, "", "Ctrl+C stops it. Delete data/demo to remove it.", ""].join("\n"));
    return -1; // keep running
  } catch (err) {
    await session.close();
    io.err(`\n${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exit(code);
  },
  (err: unknown) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  },
);

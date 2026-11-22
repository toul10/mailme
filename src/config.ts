import { z } from "zod";

/**
 * Process configuration, read once from the environment.
 * Every module takes what it needs from here — nothing else reads process.env.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  /** postgres://… for a real server, or pglite://<dir> / pglite://memory for embedded Postgres. */
  DATABASE_URL: z.string().default("postgres://localhost:5432/mailme"),

  /** Public base URL of the web app; used in digest links. */
  APP_BASE_URL: z.string().url().default("http://localhost:3000"),
  PORT: z.coerce.number().int().default(3000),
  HOST: z.string().default("127.0.0.1"),

  /** 32-byte key, base64. Encrypts API-side secrets (TOTP seeds). NOT used for mailbox passwords. */
  MASTER_KEY: z.string().min(1, "MASTER_KEY is required (32 random bytes, base64)"),
  /** Secret for session cookies. */
  APP_SECRET: z.string().min(32, "APP_SECRET must be at least 32 characters"),
  /** Separate secret for signed one-click action links. Falls back to APP_SECRET-derived key if unset. */
  LINK_SECRET: z.string().min(32).optional(),

  /** Sealed-box keys for mailbox credentials (src/lib/sealed.ts). The API needs only the public key. */
  CREDENTIALS_KID: z.string().default("k1"),
  CREDENTIALS_PUBLIC_KEY_FILE: z.string().default("./data/keys/credentials.pub.pem"),
  /** Only the worker (and CLI) should have this file mounted. */
  CREDENTIALS_PRIVATE_KEY_FILE: z.string().optional(),

  /**
   * auto: Admin → AI picks the provider and model (src/ai/resolve.ts); before a choice, Claude when the worker has
   * ANTHROPIC_API_KEY, else the free mock. mock: AI off whatever was chosen. claude: older .env files, same as auto.
   * Provider keys (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, XAI_API_KEY) are read by the worker from its
   * environment, never through this config.
   */
  AI_MODE: z.enum(["auto", "claude", "mock"]).default("auto"),
  /** Claude's model when nothing is chosen in Admin → AI. */
  AI_MODEL: z.string().default("claude-opus-5"),
  AI_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("high"),
  /**
   * Gemini only: how hard the model thinks (billed as output). Unset: the model's own default. The allowed levels
   * differ per model, and a refused one fails every call: check with `pnpm cli ai:check`.
   */
  GEMINI_THINKING_LEVEL: z.enum(["minimal", "low", "medium", "high", "xhigh"]).optional(),
  /** "default" enables Claude API server-side refusal fallbacks; "off" disables them. */
  AI_FALLBACKS: z.enum(["default", "off"]).default("default"),
  /** Prompt-cache TTL for the system prompt: 1h in live mode (calls are 10–20 min apart), 5m for backfill bursts. */
  AI_CACHE_TTL: z.enum(["5m", "1h"]).default("1h"),
  AI_MAX_TOKENS: z.coerce.number().int().default(16000),
  /** Per-attempt time until the response starts (the extractor streams; generation is bounded by max_tokens). */
  AI_TIMEOUT_MS: z.coerce.number().int().default(180_000),
  AI_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  /** Keep enum/const in the JSON schema sent to the API (the SDK helper moves them to descriptions). */
  AI_STRICT_ENUMS: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  /** Default per-mailbox daily caps (overridable per mailbox). */
  AI_DAILY_CALL_CAP: z.coerce.number().int().positive().default(150),
  AI_DAILY_USD_CAP: z.coerce.number().positive().default(10),

  /**
   * "Ask your mail" (src/chat): a signed-in user asks about their own mail and tasks. off: no chat (the default);
   * gemini: the Gemini API with CHAT_MODEL; mock: a keyword stand-in that calls nobody (development). API process
   * only. The chat's key is CHAT_API_KEY, read by the API from its environment and never through this config
   * (src/chat/model.ts): it is separate from the keys of Admin → AI, which only the worker can open.
   */
  CHAT_MODE: z.enum(["off", "gemini", "mock"]).default("off"),
  CHAT_MODEL: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/, "CHAT_MODEL must be a model id such as gemini-3.8-flash")
    .optional(),
  /** How hard the chat model thinks. Unset: the model's own default (slower: a question takes two to five calls). */
  CHAT_THINKING_LEVEL: z.enum(["minimal", "low", "medium", "high", "xhigh"]).optional(),
  /** Output tokens of one chat call (thinking included). */
  CHAT_MAX_TOKENS: z.coerce.number().int().min(1024).max(64_000).default(8192),
  /** Questions one user may ask per day (their time zone). */
  CHAT_DAILY_QUESTION_CAP: z.coerce.number().int().positive().default(100),
  /** What all users' questions together may cost per day, at the price table's rates (src/ai/pricing.ts). */
  CHAT_DAILY_USD_CAP: z.coerce.number().positive().default(3),

  SYNC_INTERVAL_SEC: z.coerce.number().int().min(30).default(120),
  /** STATUS-poll interval for non-INBOX folders. */
  FOLDER_POLL_SEC: z.coerce.number().int().min(60).default(300),
  /** A message is processed only after it has been known this long (late Sent APPENDs). */
  SETTLE_SEC: z.coerce.number().int().min(0).default(180),
  /** Messages larger than this are fetched as headers + text parts only. */
  MAX_FETCH_BYTES: z.coerce.number().int().default(5 * 1024 * 1024),
  BACKFILL_DAYS: z.coerce.number().int().min(0).max(90).default(21),
  /** After go-live, a message first seen with sort_ts older than this is skipped_old. */
  LATE_DISCOVERY_MAX_DAYS: z.coerce.number().int().min(1).default(7),
  BODY_RETENTION_DAYS: z.coerce.number().int().min(7).default(90),
  CLOSED_TASK_RETENTION_DAYS: z.coerce.number().int().min(30).default(540),

  /** Alerts: ntfy topic URL or generic webhook (JSON POST). Independent of the mail server. */
  ALERT_WEBHOOK_URL: z.string().url().optional(),
  /** External dead-man's switch (e.g. healthchecks.io ping URL). */
  HEALTHCHECK_PING_URL: z.string().url().optional(),

  /** Domain used in the platform's own Message-IDs (loop prevention). */
  PLATFORM_MAIL_DOMAIN: z.string().default("mailme.local"),

  DEFAULT_TIMEZONE: z.string().default("Europe/Athens"),
  /** Fastify trustProxy: "loopback" (default), "true" for a trusted reverse proxy network, a hop count ("1" on Cloud Run), or a comma-separated CIDR list. */
  TRUST_PROXY: z.string().default("loopback"),
  /**
   * "Check now": the Cloud Run job the API may start on demand, projects/<p>/locations/<r>/jobs/<job> (its service
   * account needs roles/run.invoker on that job only). Unset: no button; an always-on worker watches the mailbox itself.
   */
  TICK_JOB: z
    .string()
    .regex(/^projects\/[^/]+\/locations\/[^/]+\/jobs\/[^/]+$/, "TICK_JOB must be projects/<project>/locations/<region>/jobs/<job>")
    .optional(),
  /** Sender deny-list applied before any AI call: comma-separated addresses or "@domain" entries. */
  DENY_LIST: z
    .string()
    .default("")
    .transform((v) => v.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean)),
  /** Disable TOTP requirement (local development only). */
  AUTH_REQUIRE_MFA: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
});

export type Config = z.infer<typeof EnvSchema>;

let cached: Config | undefined;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return parsed.data;
}

export function config(): Config {
  cached ??= loadConfig();
  return cached;
}

/** Test hook: replace the cached config. */
export function setConfigForTests(overrides: Partial<Config>): Config {
  cached = loadConfig({
    MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
    APP_SECRET: "test-secret-test-secret-test-secret-1234",
    AI_MODE: "mock",
    NODE_ENV: "test",
    ...process.env,
    ...(Object.fromEntries(Object.entries(overrides).map(([k, v]) => [k, String(v)])) as NodeJS.ProcessEnv),
  });
  return cached;
}

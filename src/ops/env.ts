import { existsSync } from "node:fs";
import { z } from "zod";

/**
 * Ops-only settings that are not (yet) in src/config.ts. Entry points pass `process.env` explicitly, so
 * src/config.ts stays the only module that reads the environment on its own. Pending contract change:
 * move these keys into the config schema.
 */
const OpsEnvSchema = z.object({
  /** Data directory (keys, audit exports, previews, backups); its filesystem is watched by the disk check. */
  DATA_DIR: z.string().default("./data"),
  /** "off" skips the disk check: a Cloud Run container's filesystem is in memory and holds no data (Cloud SQL does). */
  DISK_CHECK: z.enum(["on", "off"]).default("on"),
  /** File whose mtime marks the last successful backup (written by `backup:dump`); unset = no backup check. */
  BACKUP_MARKER_FILE: z.string().optional(),
  /** Where `backup:dump` writes pg_dump files. */
  BACKUP_DIR: z.string().default("./data/backups"),
  /** Local dump files older than this are deleted by `backup:dump`. */
  BACKUP_KEEP_DAYS: z.coerce.number().int().min(1).default(30),
});

export type OpsEnv = z.infer<typeof OpsEnvSchema>;

export function readOpsEnv(env: NodeJS.ProcessEnv): OpsEnv {
  const parsed = OpsEnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid ops configuration:\n${issues}`);
  }
  return parsed.data;
}

/**
 * Load `.env` (or MAILME_ENV_FILE) into process.env for local runs. Variables already set in the environment
 * win (Docker/compose passes them directly and has no .env in the image).
 */
export function loadDotEnv(file: string = ".env"): boolean {
  if (!existsSync(file)) return false;
  process.loadEnvFile(file);
  return true;
}

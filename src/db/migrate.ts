import { fileURLToPath } from "node:url";
import path from "node:path";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import type { DbHandle } from "./client.js";

export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../drizzle");

/** Apply committed SQL migrations (drizzle/). Never `drizzle-kit push` in production. */
export async function runMigrations(handle: DbHandle): Promise<void> {
  if (handle.kind === "pglite") {
    await migratePglite(handle.db as never, { migrationsFolder: MIGRATIONS_DIR });
  } else {
    await migratePg(handle.db as never, { migrationsFolder: MIGRATIONS_DIR });
  }
}

// `pnpm db:migrate`
if (import.meta.url === `file://${process.argv[1]}`) {
  const { openDb } = await import("./client.js");
  const { config } = await import("../config.js");
  const handle = await openDb(config().DATABASE_URL);
  await runMigrations(handle);
  await handle.close();
  console.log("migrations applied");
}

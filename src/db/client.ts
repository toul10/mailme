import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import os from "node:os";
import pg from "pg";
import * as schema from "./schema.js";

/**
 * One Drizzle handle type for both drivers. Application code only uses the query builder,
 * `db.transaction(...)` and `db.execute(sql\`…\`)`, which behave the same on both.
 */
export type Db = ReturnType<typeof drizzlePg<typeof schema>>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** A db or an open transaction — functions that can run inside a caller's transaction accept this. */
export type DbOrTx = Db | Tx;

export interface DbHandle {
  db: Db;
  kind: "pg" | "pglite";
  /** node-postgres pool (kind = "pg") — used for session-scoped advisory locks. */
  pool: pg.Pool | null;
  close(): Promise<void>;
}

/**
 * DATABASE_URL:
 *   postgres://user:pass@host:5432/db  → node-postgres pool
 *   pglite://memory                     → in-memory embedded Postgres (tests)
 *   pglite://./data/pglite              → embedded Postgres persisted to a directory
 */
export async function openDb(url: string): Promise<DbHandle> {
  if (url.startsWith("pglite://")) {
    const target = url.slice("pglite://".length);
    const client = target === "memory" || target === "" ? new PGlite() : new PGlite(target);
    await client.waitReady;
    const db = drizzlePglite(client, { schema }) as unknown as Db;
    return { db, kind: "pglite", pool: null, close: () => client.close() };
  }
  defaultPgUserToLogin();
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  // A connection the server ends (restart, failover, Cloud SQL maintenance) emits "error" on its client. pg-pool
  // listens only while the client is idle in the pool (and re-emits it on the pool); a checked-out client has no
  // listener, and an unhandled "error" event kills the process. These two listeners stop that. The error still
  // surfaces where it matters: the client's pending or next query fails, and the pool discards it on release.
  // Holders of a session lock learn about the loss through acquireProcessLock's onLost.
  pool.on("error", () => undefined);
  pool.on("connect", (client) => client.on("error", () => undefined));
  const db = drizzlePg(pool, { schema });
  return { db, kind: "pg", pool, close: () => pool.end() };
}

/**
 * A URL without a user name ("postgres://localhost/mailme") means your login, as in psql and createdb. node-postgres
 * takes it from $USER and sends no user name at all when $USER is unset (cron, some service managers, `env -i`);
 * libpq asks the OS instead. This makes node-postgres do the same. A user in the URL, PGUSER or $USER still wins.
 */
export function defaultPgUserToLogin(): void {
  if (pg.defaults.user) return;
  try {
    pg.defaults.user = os.userInfo().username;
  } catch {
    // a uid without a passwd entry (some containers): nothing to fall back to
  }
}

/**
 * Run `fn` while holding a session-level advisory lock on `key`, or return `{ acquired: false }` immediately
 * if another session holds it. The lock and unlock run on ONE dedicated pooled connection — never call
 * pg_try_advisory_lock through the pool directly (lock/unlock could land on different connections and leak).
 * On PGlite (single connection, tests) the lock is emulated in-process.
 */
export async function withSessionLock<T>(handle: DbHandle, key: string, fn: () => Promise<T>): Promise<{ acquired: true; value: T } | { acquired: false }> {
  if (handle.kind === "pglite" || !handle.pool) {
    if (inProcessLocks.has(key)) return { acquired: false };
    inProcessLocks.add(key);
    try {
      return { acquired: true, value: await fn() };
    } finally {
      inProcessLocks.delete(key);
    }
  }
  const conn = await handle.pool.connect();
  try {
    const res = await conn.query<{ ok: boolean }>("select pg_try_advisory_lock(hashtextextended($1, 0)) as ok", [key]);
    if (!res.rows[0]?.ok) return { acquired: false };
    try {
      return { acquired: true, value: await fn() };
    } finally {
      await conn.query("select pg_advisory_unlock(hashtextextended($1, 0))", [key]);
    }
  } finally {
    conn.release();
  }
}

const inProcessLocks = new Set<string>();

/**
 * Hold a session advisory lock for the lifetime of the process (worker single-instance guard).
 * Returns a release function, or null if another process holds it.
 *
 * The lock lives in ONE server session. When that session ends (server restart, failover, maintenance, a dropped
 * connection) the lock is gone and another process may take it, so `onLost` is required: the holder must stop
 * (the worker exits non-zero; its supervisor starts it again, and the new process takes the lock again).
 */
export async function acquireProcessLock(handle: DbHandle, key: string, onLost: (err: Error) => void): Promise<null | (() => Promise<void>)> {
  if (handle.kind === "pglite" || !handle.pool) {
    if (inProcessLocks.has(key)) return null;
    inProcessLocks.add(key);
    return async () => {
      inProcessLocks.delete(key);
    };
  }
  const conn = await handle.pool.connect();
  let ok: boolean;
  try {
    const res = await conn.query<{ ok: boolean }>("select pg_try_advisory_lock(hashtextextended($1, 0)) as ok", [key]);
    ok = res.rows[0]?.ok === true;
  } catch (err) {
    conn.release(err instanceof Error ? err : true);
    throw err;
  }
  if (!ok) {
    conn.release();
    return null;
  }
  let lost: Error | null = null;
  const onError = (err: Error) => {
    if (lost) return;
    lost = err;
    onLost(err);
  };
  conn.on("error", onError);
  return async () => {
    // The listener must not outlive the lock: the pool hands this client to other callers afterwards.
    conn.removeListener("error", onError);
    if (lost) {
      conn.release(lost); // the session (and with it the lock) is already gone; the pool drops the client
      return;
    }
    try {
      await conn.query("select pg_advisory_unlock(hashtextextended($1, 0))", [key]);
    } finally {
      conn.release();
    }
  };
}

export { schema };

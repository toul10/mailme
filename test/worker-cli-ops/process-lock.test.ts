import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { acquireProcessLock, openDb, type DbHandle } from "../../src/db/client.js";

/** A pg PoolClient stand-in: an EventEmitter with query/release, like the real one between queries. */
function fakeClient(lockOk = true) {
  const client = Object.assign(new EventEmitter(), {
    queries: [] as string[],
    released: [] as Array<unknown>,
    query: vi.fn(async (text: string) => {
      client.queries.push(text);
      if (text.includes("pg_try_advisory_lock")) return { rows: [{ ok: lockOk }] };
      return { rows: [] };
    }),
    release: vi.fn((err?: unknown) => void client.released.push(err)),
  });
  return client;
}

const handleWith = (client: ReturnType<typeof fakeClient>): DbHandle =>
  ({ kind: "pg", db: {} as DbHandle["db"], pool: { connect: async () => client } as unknown as DbHandle["pool"], close: async () => {} }) as DbHandle;

describe("worker process lock (acquireProcessLock)", () => {
  it("reports the loss of its session once, instead of crashing on the client's 'error' event", async () => {
    const client = fakeClient();
    const onLost = vi.fn();
    const release = await acquireProcessLock(handleWith(client), "worker", onLost);
    expect(release).not.toBeNull();

    const terminated = Object.assign(new Error("terminating connection due to administrator command"), { code: "57P01" });
    expect(() => client.emit("error", terminated)).not.toThrow(); // was: Unhandled 'error' event → process exit
    client.emit("error", new Error("additional error"));
    expect(onLost).toHaveBeenCalledTimes(1);
    expect(onLost).toHaveBeenCalledWith(terminated);

    // The lock went with the session: release unlocks nothing and hands the dead client back with its error.
    await release!();
    expect(client.queries.some((q) => q.includes("pg_advisory_unlock"))).toBe(false);
    expect(client.released).toEqual([terminated]);
  });

  it("a normal release unlocks, and the listener does not outlive the lock (the pool reuses the client)", async () => {
    const client = fakeClient();
    const onLost = vi.fn();
    const release = await acquireProcessLock(handleWith(client), "worker", onLost);
    await release!();
    expect(client.queries.at(-1)).toContain("pg_advisory_unlock");
    expect(client.released).toEqual([undefined]);
    expect(client.listenerCount("error")).toBe(0);
    expect(onLost).not.toHaveBeenCalled();
  });

  it("returns null when another process holds the lock, and returns the client to the pool untouched", async () => {
    const client = fakeClient(false);
    expect(await acquireProcessLock(handleWith(client), "worker", vi.fn())).toBeNull();
    expect(client.released).toEqual([undefined]);
    expect(client.listenerCount("error")).toBe(0);
  });

  it("a failing lock query releases the client with the error and rethrows it", async () => {
    const client = fakeClient();
    const down = new Error("Connection terminated unexpectedly");
    client.query.mockRejectedValueOnce(down);
    await expect(acquireProcessLock(handleWith(client), "worker", vi.fn())).rejects.toBe(down);
    expect(client.released).toEqual([down]);
  });
});

describe("openDb (node-postgres pool)", () => {
  it("listens for 'error' on the pool and on every client it creates, so a dropped connection cannot crash the process", async () => {
    const handle = await openDb("postgres://mailme@127.0.0.1:1/mailme"); // never connects in this test
    try {
      const pool = handle.pool!;
      expect(() => pool.emit("error", new Error("idle client error"))).not.toThrow();
      const client = new EventEmitter();
      pool.emit("connect", client); // what pg-pool emits for each new connection
      expect(() => client.emit("error", new Error("terminating connection due to administrator command"))).not.toThrow();
    } finally {
      await handle.close();
    }
  });
});

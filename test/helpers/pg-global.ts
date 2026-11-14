import pg from "pg";

/** vitest globalSetup: in TEST_PG_URL mode, drop the per-worker template/test databases after the run. */
export default function setup() {
  return async function teardown() {
    const url = process.env.TEST_PG_URL;
    if (!url) return;
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      const { rows } = await client.query<{ datname: string }>(
        "select datname from pg_database where datname like 'mailme\\_tpl\\_%' or datname like 'mailme\\_t\\_%'",
      );
      for (const r of rows) await client.query(`drop database if exists ${r.datname} with (force)`);
    } finally {
      await client.end();
    }
  };
}

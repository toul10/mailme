import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: "forks",
    // Each DB test loads an embedded Postgres; too many forks at once starve each other.
    maxWorkers: 6,
    globalSetup: ["test/helpers/pg-global.ts"],
  },
});

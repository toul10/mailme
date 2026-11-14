import os from "node:os";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { defaultPgUserToLogin } from "../../src/db/client.js";

// node-postgres reads $USER once, when it loads; a process started without it (cron, `env -i`) has no default user.
describe("defaultPgUserToLogin", () => {
  const before = pg.defaults.user;
  afterEach(() => {
    pg.defaults.user = before;
  });

  it("without $USER, a URL with no user name connects as the OS login, like psql", () => {
    pg.defaults.user = undefined;
    defaultPgUserToLogin();
    expect(pg.defaults.user).toBe(os.userInfo().username);
    // What a connection to "postgres://localhost:55432/mailme" then sends.
    const params = new (pg.Client as unknown as new (c: object) => { user: string })({ connectionString: "postgres://localhost:55432/mailme" });
    expect(params.user).toBe(os.userInfo().username);
  });

  it("keeps a user that is already there ($USER) and never overrides one in the URL", () => {
    pg.defaults.user = "from-env";
    defaultPgUserToLogin();
    expect(pg.defaults.user).toBe("from-env");
    const client = new (pg.Client as unknown as new (c: object) => { user: string })({ connectionString: "postgres://app@localhost/mailme" });
    expect(client.user).toBe("app");
  });
});

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../src/db/schema.js";
import type { MailboxSummary } from "../../../src/server/api-types.js";
import { hostSyntaxProblem, isNonPublicAddress } from "../../../src/server/host-policy.js";
import { api, makeHarness, sessionFor, type Harness, type Session } from "../../server/helpers.js";

describe("imap-host-ssrf", () => {
  let h: Harness;
  let me: Session;
  beforeEach(async () => {
    h = await makeHarness();
    me = await sessionFor(h, h.seed.user.id);
    h.probe.mockResolvedValue({ ok: false, errorKind: "tls", error: "x", capabilities: [], delimiter: null, folders: [], quota: null });
  });
  afterEach(async () => {
    await h.close();
  });

  it.each([
    ["postgres", 5432],
    ["127.0.0.1", 5432],
    ["169.254.169.254", 80],
  ])("the API never opens a connection to internal host %s:%i", async (imapHost, imapPort) => {
    const created = await api(h, me, "POST", "/api/mailboxes", { address: `x-${imapPort}@contoso.example`, imapHost, imapPort });
    if (created.statusCode === 200) {
      await api(h, me, "POST", `/api/mailboxes/${(created.json() as MailboxSummary).id}/credentials`, { password: "pw" });
    }
    const internalProbes = h.probe.mock.calls.filter(([settings]) => settings.imapHost === imapHost);
    expect(internalProbes).toHaveLength(0);
  });

  it.each(["localhost", "api", "db.internal", "nas.local", "printer.lan", "10.0.0.010", "0x7f.1", "mail.contoso.123"])(
    "a mailbox cannot be created with the non-public host name %s",
    async (imapHost) => {
      const res = await api(h, me, "POST", "/api/mailboxes", { address: "x@contoso.example", imapHost });
      expect(res.statusCode).toBe(400);
    },
  );

  it.each([["10.1.2.3"], ["127.0.0.1"], ["172.30.0.2"], ["::1"], ["::ffff:127.0.0.1"], ["fd00::5"], ["100.64.1.1"], ["9.9.9.9", "192.168.1.9"]])(
    "a public-looking name that resolves to a private address (%s) is refused without a login",
    async (...addresses) => {
      const created = (await api(h, me, "POST", "/api/mailboxes", { address: "x@contoso.example", imapHost: "mail.attacker.example" })).json() as MailboxSummary;
      h.resolveHost.mockResolvedValueOnce(addresses);
      const res = await api(h, me, "POST", `/api/mailboxes/${created.id}/credentials`, { password: "pw" });
      expect(res.statusCode).toBe(400);
      expect(h.resolveHost).toHaveBeenCalledWith("mail.attacker.example");
      expect(h.probe).not.toHaveBeenCalled();
      expect(await h.t.db.select().from(s.mailboxLoginAttempts).where(eq(s.mailboxLoginAttempts.mailboxId, created.id))).toHaveLength(0);
    },
  );

  it("a name that does not resolve is a network failure, without a login attempt", async () => {
    const created = (await api(h, me, "POST", "/api/mailboxes", { address: "x@contoso.example", imapHost: "mail.typo-contoso.example" })).json() as MailboxSummary;
    h.resolveHost.mockRejectedValueOnce(Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }));
    const res = await api(h, me, "POST", `/api/mailboxes/${created.id}/credentials`, { password: "pw" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false, errorKind: "network" });
    expect(h.probe).not.toHaveBeenCalled();
    expect(await h.t.db.select().from(s.mailboxLoginAttempts).where(eq(s.mailboxLoginAttempts.mailboxId, created.id))).toHaveLength(0);
  });

  it("control: a public mail host is probed", async () => {
    const created = (await api(h, me, "POST", "/api/mailboxes", { address: "x@contoso.example", imapHost: "mail.contoso.example" })).json() as MailboxSummary;
    await api(h, me, "POST", `/api/mailboxes/${created.id}/credentials`, { password: "pw" });
    expect(h.probe).toHaveBeenCalledTimes(1);
  });

  it("host policy: public names pass, local names and literals do not; non-public address ranges are recognised", () => {
    for (const ok of ["mail.contoso.example", "imap.gmail.com", "mail.xn--hxajbheg2az3al.xn--qxam"]) expect(hostSyntaxProblem(ok)).toBeNull();
    for (const bad of ["postgres", "localhost", "a.localhost", "x.internal", "127.0.0.1", "[::1]", "::1", "1.2.3.4", "host.local", "0x7f.1"]) {
      expect(hostSyntaxProblem(bad)).not.toBeNull();
    }
    for (const priv of ["10.0.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "192.168.0.1", "100.64.0.1", "0.0.0.0", "::", "::1", "fe80::1", "fc00::1", "::ffff:10.0.0.1", "::ffff:7f00:1", "64:ff9b::a9fe:a9fe"]) {
      expect(isNonPublicAddress(priv)).toBe(true);
    }
    for (const pub of ["9.9.9.9", "8.8.8.8", "2a00:1450:4001:80b::200e", "::ffff:9.9.9.9"]) expect(isNonPublicAddress(pub)).toBe(false);
  });
});

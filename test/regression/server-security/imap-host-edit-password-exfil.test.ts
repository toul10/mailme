import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../src/db/schema.js";
import { deliverDigestForUser } from "../../../src/digest/dispatch.js";
import { openMailboxPassword, sealMailboxPassword } from "../../../src/lib/credentials.js";
import type { ProbeResult } from "../../../src/mail/imap/probe.js";
import type { MailboxSummary, ProbeSummary } from "../../../src/server/api-types.js";
import { loadActiveMailboxes } from "../../../src/worker/worker.js";
import { FakeTransport, memoryLogger } from "../../digest/helpers.js";
import { api, makeHarness, sessionFor, type Harness, type Session } from "../../server/helpers.js";

/**
 * The connection settings of a mailbox became editable (to correct a mistyped address or server). The worker logs in
 * to whatever server the row names, with the stored password. So an edit must never leave a stored password next to
 * settings it was not tried against: a session of the owner (a stolen one, say) could otherwise repoint the mailbox
 * and have the worker deliver the password.
 */
const OWNER_PASSWORD = "owner-full-control-mailbox-password";
const HOME = "mail.contoso.example";
const OK_PROBE: ProbeResult = { ok: true, errorKind: null, error: null, capabilities: ["IMAP4rev1"], delimiter: ".", folders: [], quota: null };

describe("imap-host-edit-password-exfil", () => {
  let h: Harness;
  let owner: Session;
  let mb: string;

  beforeEach(async () => {
    h = await makeHarness();
    owner = await sessionFor(h, h.seed.user.id);
    mb = h.seed.mailbox.id;
    // A working mailbox: sealed password, report by SMTP through its own server.
    await h.t.db.update(s.users).set({ digestDelivery: "smtp" }).where(eq(s.users.id, h.seed.user.id));
    await h.t.db
      .update(s.mailboxes)
      .set({ ...sealMailboxPassword({ id: mb, address: h.seed.mailbox.address }, OWNER_PASSWORD, h.keys), smtpHost: HOME, status: "active" })
      .where(eq(s.mailboxes.id, mb));
  });
  afterEach(async () => {
    await h.close();
  });

  const patch = (body: object) => api(h, owner, "PATCH", `/api/mailboxes/${mb}`, body);
  const row = async () => (await h.t.db.select().from(s.mailboxes).where(eq(s.mailboxes.id, mb)))[0]!;

  /** The worker's next report: every time the password was handed to a server other than the mailbox's own. */
  async function leaksOnNextReport() {
    const transport = new FakeTransport();
    await deliverDigestForUser(
      {
        db: h.t.db,
        clock: h.clock,
        log: memoryLogger(),
        transport,
        getPassword: async (m) => openMailboxPassword(m, h.keys),
        config: { APP_BASE_URL: "https://mailme.example.test", PLATFORM_MAIL_DOMAIN: "mailme.test", DEFAULT_TIMEZONE: "Europe/Athens", linkSecret: "x".repeat(40) },
      },
      h.seed.user.id,
      "2026-09-15",
    ).catch(() => undefined);
    return transport.calls.filter((c) => c.password === OWNER_PASSWORD && (c.settings.imapHost !== HOME || (c.settings.smtpHost ?? HOME) !== HOME));
  }

  it("repointing the IMAP server removes the stored password: the worker has nothing to send to the new server", async () => {
    const res = await patch({ imapHost: "attacker.example" });
    expect(res.statusCode).toBe(200);
    expect(res.json() as MailboxSummary).toMatchObject({ imapHost: "attacker.example", status: "setup", hasCredentials: false });
    expect(await row()).toMatchObject({ credentialsSealed: null, credentialsKid: null, status: "setup" });
    expect((await loadActiveMailboxes(h.t.db)).map((m) => m.id)).not.toContain(mb);
    expect(await leaksOnNextReport()).toHaveLength(0);
  });

  it("the same holds for the port, the login name and the address", async () => {
    for (const body of [{ imapPort: 8143 }, { imapUsername: "someone-else" }, { address: "other@contoso.example" }]) {
      await h.t.db
        .update(s.mailboxes)
        .set({ ...sealMailboxPassword({ id: mb, address: (await row()).address }, OWNER_PASSWORD, h.keys), status: "active" })
        .where(eq(s.mailboxes.id, mb));
      expect((await patch(body)).statusCode).toBe(200);
      expect(await row()).toMatchObject({ credentialsSealed: null, status: "setup" });
      expect(await leaksOnNextReport()).toHaveLength(0);
    }
  });

  it("a server moved away and back does not leave the SMTP server behind for the next password", async () => {
    // Step 1: away, taking SMTP along (the SMTP server may only be the IMAP server).
    expect((await patch({ imapHost: "attacker.example", smtpHost: "attacker.example" })).statusCode).toBe(200);
    expect(await row()).toMatchObject({ imapHost: "attacker.example", smtpHost: "attacker.example", credentialsSealed: null });
    // Step 2: back — naming the other server as an "unchanged" SMTP value is refused…
    expect((await patch({ imapHost: HOME, smtpHost: "attacker.example" })).statusCode).toBe(400);
    // …and without naming it, SMTP comes back with the IMAP server.
    expect((await patch({ imapHost: HOME })).statusCode).toBe(200);
    expect(await row()).toMatchObject({ imapHost: HOME, smtpHost: HOME, credentialsSealed: null, status: "setup" });

    // The owner sees “needs a password” and enters it: it reaches their own server only.
    h.probe.mockResolvedValueOnce(OK_PROBE);
    const probed = await api(h, owner, "POST", `/api/mailboxes/${mb}/credentials`, { password: OWNER_PASSWORD });
    expect((probed.json() as ProbeSummary).ok).toBe(true);
    expect(h.probe).toHaveBeenCalledWith(expect.objectContaining({ imapHost: HOME, smtpHost: HOME }), OWNER_PASSWORD);
    expect(await leaksOnNextReport()).toHaveLength(0);
  });

  it("a server changed while the owner's password is being tried does not get that password stored for it", async () => {
    await h.t.db.update(s.mailboxes).set({ credentialsSealed: null, credentialsKid: null, status: "setup" }).where(eq(s.mailboxes.id, mb));
    let edited = 0;
    h.probe.mockImplementationOnce(async () => {
      edited = (await patch({ imapHost: "attacker.example" })).statusCode;
      return OK_PROBE;
    });
    const res = await api(h, owner, "POST", `/api/mailboxes/${mb}/credentials`, { password: OWNER_PASSWORD });
    expect(edited).toBe(200);
    expect(res.statusCode).toBe(409);
    expect(await row()).toMatchObject({ imapHost: "attacker.example", credentialsSealed: null, status: "setup" });
    expect(await leaksOnNextReport()).toHaveLength(0);
  });
});

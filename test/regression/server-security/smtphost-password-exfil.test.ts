import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../src/db/schema.js";
import { deliverDigestForUser } from "../../../src/digest/dispatch.js";
import { openMailboxPassword, sealMailboxPassword } from "../../../src/lib/credentials.js";
import type { MailboxSummary } from "../../../src/server/api-types.js";
import { FakeTransport, memoryLogger } from "../../digest/helpers.js";
import { addUser, api, makeHarness, sessionFor, type Harness } from "../../server/helpers.js";

const COLLEAGUE_PASSWORD = "colleague-full-control-mailbox-password";

describe("smtphost-password-exfil", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  async function smtpDelivery() {
    const colleague = h.seed.user;
    const mb = h.seed.mailbox;
    // Colleague: report via SMTP (documented option, `pnpm cli user:update`), working sealed credentials.
    await h.t.db.update(s.users).set({ digestDelivery: "smtp" }).where(eq(s.users.id, colleague.id));
    await h.t.db
      .update(s.mailboxes)
      .set({ ...sealMailboxPassword({ id: mb.id, address: mb.address }, COLLEAGUE_PASSWORD, h.keys), smtpHost: "mail.contoso.example", status: "active" })
      .where(eq(s.mailboxes.id, mb.id));
    return { colleague, mb };
  }

  async function dispatchAndCollectLeaks(userId: string) {
    // Worker: next report dispatch (real open of the sealed password).
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
      userId,
      "2026-09-15",
    );
    return transport.calls.filter((c) => c.kind === "smtp" && c.settings.smtpHost !== "mail.contoso.example" && c.password === COLLEAGUE_PASSWORD);
  }

  it("an org admin repointing a colleague's smtpHost does not get the colleague's mailbox password delivered to that host", async () => {
    const { colleague, mb } = await smtpDelivery();
    const admin = await sessionFor(h, (await addUser(h, { email: "admin@contoso.example", role: "admin" })).id);
    const patched = await api(h, admin, "PATCH", `/api/mailboxes/${mb.id}`, { smtpHost: "attacker.example", smtpPort: 465 });
    expect(patched.statusCode).toBe(403);
    expect(await dispatchAndCollectLeaks(colleague.id)).toHaveLength(0);
  });

  it("a full session of the owner (e.g. stolen) cannot repoint SMTP to another host either", async () => {
    const { colleague, mb } = await smtpDelivery();
    const owner = await sessionFor(h, colleague.id);
    const patched = await api(h, owner, "PATCH", `/api/mailboxes/${mb.id}`, { smtpHost: "attacker.example" });
    expect(patched.statusCode).toBe(400);
    const [row] = await h.t.db.select().from(s.mailboxes).where(eq(s.mailboxes.id, mb.id));
    expect(row!.smtpHost).toBe("mail.contoso.example");
    expect(await dispatchAndCollectLeaks(colleague.id)).toHaveLength(0);
  });

  it("SMTP may only be the IMAP host (or empty), on a submission port; unchanged legacy values keep working", async () => {
    const owner = await sessionFor(h, h.seed.user.id);
    const mb = h.seed.mailbox.id;
    expect((await api(h, owner, "PATCH", `/api/mailboxes/${mb}`, { smtpHost: "MAIL.contoso.example", smtpPort: 465 })).statusCode).toBe(200);
    expect((await api(h, owner, "PATCH", `/api/mailboxes/${mb}`, { smtpHost: null })).statusCode).toBe(200);
    expect((await api(h, owner, "PATCH", `/api/mailboxes/${mb}`, { smtpPort: 25 })).statusCode).toBe(400);

    // A row set up through the CLI with a different SMTP host: saving other fields (the SPA resends SMTP) still works.
    await h.t.db.update(s.mailboxes).set({ smtpHost: "smtp.contoso.example", smtpPort: 2525 }).where(eq(s.mailboxes.id, mb));
    const same = await api(h, owner, "PATCH", `/api/mailboxes/${mb}`, { displayName: "Πωλήσεις", smtpHost: "smtp.contoso.example", smtpPort: 2525 });
    expect(same.statusCode).toBe(200);
    expect((await api(h, owner, "PATCH", `/api/mailboxes/${mb}`, { smtpHost: "smtp2.contoso.example" })).statusCode).toBe(400);

    // Creation follows the same rule.
    const bad = await api(h, owner, "POST", "/api/mailboxes", { address: "x@contoso.example", imapHost: "mail.contoso.example", smtpHost: "attacker.example" });
    expect(bad.statusCode).toBe(400);
    const good = await api(h, owner, "POST", "/api/mailboxes", { address: "y@contoso.example", imapHost: "mail.contoso.example", smtpHost: "mail.contoso.example" });
    expect(good.statusCode).toBe(200);
    expect((good.json() as MailboxSummary).smtpHost).toBe("mail.contoso.example");
    const ingest = await api(h, owner, "POST", "/api/mailboxes", { address: "z@contoso.example", provider: "ingest", imapHost: null, smtpHost: "mail.contoso.example" });
    expect(ingest.statusCode).toBe(400);
  });
});

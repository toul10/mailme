import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../src/db/schema.js";
import { nullLogger } from "../../../src/lib/log.js";
import { ingestMessage, type IngestDeps } from "../../../src/mail/ingest.js";
import { createTestDb, insertFolder, seedOrgUserMailbox, type TestDb } from "../../helpers/db.js";

let t: TestDb;
let ctx: Awaited<ReturnType<typeof seedOrgUserMailbox>>;
let inbox: { id: string };
let deps: IngestDeps;
const NOW = new Date("2026-09-24T08:00:00Z");

beforeEach(async () => {
  t = await createTestDb();
  ctx = await seedOrgUserMailbox(t.db);
  inbox = await insertFolder(t.db, ctx.mailbox.id, "INBOX", "inbox");
  deps = { db: t.db, clock: { now: () => NOW }, log: nullLogger, platformMailDomain: "mailme.local", lateDiscoveryMaxDays: 7 };
});
afterEach(() => t.close());

describe("own-mail-header-only-branch", () => {
  it("an external mail forging a platform-domain Message-ID + X-MailMe-Kind (no recorded digest) is not dropped as own mail", async () => {
    const raw = Buffer.from(
      [
        "Delivered-To: owner@contoso.example",
        "Return-Path: <buyer@abc-gr.example>",
        "From: Πελάτης <buyer@abc-gr.example>",
        "To: owner@contoso.example",
        "Subject: Παραγγελία 4471",
        `Date: ${NOW.toUTCString()}`,
        "Message-ID: <x123@mailme.local>",
        "X-MailMe-Kind: digest",
        "MIME-Version: 1.0",
        'Content-Type: text/plain; charset="utf-8"',
        "Content-Transfer-Encoding: 8bit",
        "",
        "Παρακαλώ στείλτε μας 10 ηχεία Χ200 μέχρι την Παρασκευή.",
        "",
      ].join("\r\n"),
      "utf8",
    );
    const r = await ingestMessage(deps, {
      mailboxId: ctx.mailbox.id,
      source: { kind: "mime", raw },
      location: { folderId: inbox.id, folderRole: "inbox", uid: 77, internalDate: NOW, flags: [] },
      seenAt: NOW,
      via: "imap",
    });
    // Domain + recorded APPEND UID; "a header alone can be forged".
    expect(r.state).not.toBe("own_mail");
    expect(r.state).toBe("pending");
  });

  function digestMime(id: string): Buffer {
    return Buffer.from(
      [
        "From: MailMe <colleague@contoso.example>",
        "To: colleague@contoso.example",
        "Subject: MailMe — Daily report",
        `Date: ${NOW.toUTCString()}`,
        `Message-ID: <${id}>`,
        "Auto-Submitted: auto-generated",
        "X-MailMe-Kind: digest",
        "MIME-Version: 1.0",
        'Content-Type: text/plain; charset="utf-8"',
        "",
        "Today: ABC — Send the offer",
        "",
      ].join("\r\n"),
      "utf8",
    );
  }

  it("a colleague's recorded report forwarded into this mailbox is own mail (digests matched across the org)", async () => {
    const [colleague] = await t.db.insert(s.users).values({ orgId: ctx.org.id, name: "Colleague", email: "colleague@contoso.example" }).returning();
    await t.db.insert(s.digests).values({ userId: colleague!.id, localDate: "2026-09-24", messageIdHeader: "<digest.c.2026-09-24@mailme.local>", status: "delivered", deliveredVia: "smtp" });
    const r = await ingestMessage(deps, { mailboxId: ctx.mailbox.id, source: { kind: "mime", raw: digestMime("digest.c.2026-09-24@mailme.local") }, location: null, seenAt: NOW, via: "eml_import" });
    expect(r.state).toBe("own_mail");
  });

  it("a report recorded in another organization is not own mail here", async () => {
    const otherOrg = await seedOrgUserMailbox(t.db, { address: "someone@other.example" });
    await t.db.insert(s.digests).values({ userId: otherOrg.user.id, localDate: "2026-09-24", messageIdHeader: "<digest.o.2026-09-24@mailme.local>", status: "delivered", deliveredVia: "smtp" });
    const r = await ingestMessage(deps, { mailboxId: ctx.mailbox.id, source: { kind: "mime", raw: digestMime("digest.o.2026-09-24@mailme.local") }, location: null, seenAt: NOW, via: "eml_import" });
    expect(r.state).not.toBe("own_mail");
  });
});

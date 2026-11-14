import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "../../../src/db/schema.js";
import { buildExtractionContext } from "../../../src/engine/context.js";
import { nullLogger } from "../../../src/lib/log.js";
import { ingestMessage, type IngestDeps } from "../../../src/mail/ingest.js";
import { segmentBody } from "../../../src/mail/segment.js";
import { redactSensitive } from "../../../src/mail/redact.js";
import { createTestDb, insertFolder, seedOrgUserMailbox, type TestDb } from "../../helpers/db.js";
import { parsedMail } from "../../mail-core/helpers.js";

let t: TestDb;
let ctx: Awaited<ReturnType<typeof seedOrgUserMailbox>>;
let inbox: { id: string };
let deps: IngestDeps;
const NOW = new Date("2026-09-24T08:00:00Z");
const IBAN = "GR16 0110 1250 0000 0001 2300 695";

beforeEach(async () => {
  t = await createTestDb();
  ctx = await seedOrgUserMailbox(t.db);
  inbox = await insertFolder(t.db, ctx.mailbox.id, "INBOX", "inbox");
  deps = { db: t.db, clock: { now: () => NOW }, log: nullLogger, platformMailDomain: "mailme.local", lateDiscoveryMaxDays: 7 };
});
afterEach(() => t.close());

describe("redaction-segments-only", () => {
  it("sanity: the body redactor does catch this IBAN", () => {
    expect(redactSensitive(`IBAN: ${IBAN}`).text).not.toContain("0001 2300 695");
  });

  it("an IBAN in the subject never reaches the extraction input", async () => {
    const subject = `Νέο IBAN εταιρείας ${IBAN}`;
    const raw = Buffer.from(
      [
        "Delivered-To: owner@contoso.example",
        "From: Λογιστήριο <acc@abc-gr.example>",
        "To: owner@contoso.example",
        `Subject: =?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`,
        `Date: ${NOW.toUTCString()}`,
        "Message-ID: <iban-subj-1@abc-gr.example>",
        "MIME-Version: 1.0",
        'Content-Type: text/plain; charset="utf-8"',
        "Content-Transfer-Encoding: 8bit",
        "",
        "Καλημέρα, ενημερώστε τα στοιχεία μας και επιβεβαιώστε μέχρι την Παρασκευή.",
        "",
      ].join("\r\n"),
      "utf8",
    );
    const r = await ingestMessage(deps, {
      mailboxId: ctx.mailbox.id,
      source: { kind: "mime", raw },
      location: { folderId: inbox.id, folderRole: "inbox", uid: 1, internalDate: NOW, flags: [] },
      seenAt: NOW,
      via: "imap",
    });
    expect(r.state).toBe("pending");
    const { input } = await buildExtractionContext(t.db, r.messageId);
    expect(JSON.stringify(input)).not.toContain("0001 2300 695");
    // Stored redacted (the extractor, the thread digest of later messages and the report all read this column).
    const [m] = await t.db.select().from(s.messages).where(eq(s.messages.id, r.messageId));
    expect(m!.subject).toBe("Νέο IBAN εταιρείας [IBAN]");
  });

  it("attachment names and calendar text are redacted before storage too", async () => {
    const r = await ingestMessage(deps, {
      mailboxId: ctx.mailbox.id,
      source: {
        kind: "parsed",
        parsed: parsedMail({
          messageIdHeader: "iban-att-1@abc-gr.example",
          attachments: [{ filename: `IBAN ${IBAN}.pdf`, contentType: "application/pdf", size: 10, inline: false }],
          calendar: { method: "REQUEST", summary: `Πληρωμή στο ${IBAN}`, start: null, end: null, tzid: null, organizer: null, location: "PIN: 4821" },
        }),
      },
      location: { folderId: inbox.id, folderRole: "inbox", uid: 2, internalDate: NOW, flags: [] },
      seenAt: NOW,
      via: "imap",
    });
    const [m] = await t.db.select().from(s.messages).where(eq(s.messages.id, r.messageId));
    expect(JSON.stringify([m!.attachments, m!.calendar])).not.toContain("0001 2300 695");
    expect(m!.attachments[0]!.filename).toBe("IBAN [IBAN].pdf");
    expect(m!.calendar!.location).toBe("PIN: [SECRET]");
  });

  it("an IBAN cut by the QUOTED cap is still redacted (truncate runs before redaction)", () => {
    const pad = "x".repeat(1480);
    const segs = segmentBody(
      { textPlain: `Ok.\n\nFrom: A\nSent: Wednesday, September 9, 2026 10:02 AM\nTo: B\nSubject: S\n\n${pad} ${IBAN}`, textHtml: null },
      { quotedCap: 1500 },
    );
    const quoted = segs.find((s) => s.kind === "QUOTED")!;
    const redacted = redactSensitive(quoted.text).text;
    expect(redacted).not.toMatch(/GR16 0110/);
  });
});

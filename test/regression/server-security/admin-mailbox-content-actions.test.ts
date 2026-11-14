import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../src/db/schema.js";
import { sealMailboxPassword } from "../../../src/lib/credentials.js";
import type { MailboxSummary } from "../../../src/server/api-types.js";
import { addUser, api, makeHarness, sessionFor, type Harness, type Session } from "../../server/helpers.js";

/** The admin role gets configuration and health only — never content. */
describe("admin-mailbox-content-actions", () => {
  let h: Harness;
  let admin: Session;
  beforeEach(async () => {
    h = await makeHarness();
    admin = await sessionFor(h, (await addUser(h, { email: "admin@contoso.example", role: "admin" })).id);
  });
  afterEach(async () => {
    await h.close();
  });

  async function privateFolder() {
    const [folder] = await h.t.db
      .insert(s.mailboxFolders)
      .values({ mailboxId: h.seed.mailbox.id, path: "INBOX.Προσωπικά", name: "Προσωπικά", role: "other", syncEnabled: false, private: true })
      .returning();
    return folder!;
  }

  it("an admin cannot mint an ingest token for a colleague's mailbox and inject owner-sent mail into it", async () => {
    const colleagueMailbox = h.seed.mailbox.id;
    const [before] = await h.t.db.select({ hash: s.mailboxes.ingestTokenHash }).from(s.mailboxes).where(eq(s.mailboxes.id, colleagueMailbox));
    const issued = await api(h, admin, "POST", `/api/mailboxes/${colleagueMailbox}/ingest-token`);
    expect(issued.statusCode).toBe(403);
    const token = issued.statusCode === 200 ? (issued.json() as { token: string }).token : null;
    h.ingest.mockResolvedValue({ messageId: "m1", created: true, state: "pending", filterReason: null, direction: "OUTBOUND", threadId: null } as never);
    if (token) {
      await h.app.inject({
        method: "POST",
        url: `/api/ingest/${colleagueMailbox}`,
        headers: { authorization: `Bearer ${token}`, "content-type": "message/rfc822", "x-mailme-declared-outbound": "1" },
        payload: "From: owner@contoso.example\r\nTo: client@abc-gr.example\r\nSubject: RE: Προσφορά\r\nMessage-ID: <forged@x>\r\n\r\nΈγινε, το έστειλα.\r\n",
      });
    }
    const injectedAsColleague = h.ingest.mock.calls.filter(([input]) => input.mailboxId === colleagueMailbox && input.declaredOutbound);
    expect({ issueStatus: issued.statusCode, injected: injectedAsColleague.length }).toEqual({ issueStatus: issued.statusCode, injected: 0 });
    // …and the colleague's own agent token was not replaced.
    const [after] = await h.t.db.select({ hash: s.mailboxes.ingestTokenHash }).from(s.mailboxes).where(eq(s.mailboxes.id, colleagueMailbox));
    expect(after!.hash).toBe(before!.hash);
  });

  it("an admin cannot un-private and enable sync on a folder the colleague marked private", async () => {
    const folder = await privateFolder();
    const res = await api(h, admin, "PATCH", `/api/mailboxes/${h.seed.mailbox.id}/folders/${folder.id}`, { private: false, syncEnabled: true });
    expect(res.statusCode).toBe(403);
    const [after] = await h.t.db.select().from(s.mailboxFolders).where(eq(s.mailboxFolders.id, folder.id));
    expect({ private: after!.private, syncEnabled: after!.syncEnabled }).toEqual({ private: true, syncEnabled: false });
    for (const body of [{ private: false }, { syncEnabled: true }, { role: "archive" }]) {
      expect((await api(h, admin, "PATCH", `/api/mailboxes/${h.seed.mailbox.id}/folders/${folder.id}`, body)).statusCode).toBe(403);
    }
  });

  it("an admin may still reduce processing: pause the mailbox, mark a folder private, stop a folder's sync", async () => {
    const [inbox] = await h.t.db.insert(s.mailboxFolders).values({ mailboxId: h.seed.mailbox.id, path: "INBOX", name: "INBOX", role: "inbox", syncEnabled: true }).returning();
    const stop = await api(h, admin, "PATCH", `/api/mailboxes/${h.seed.mailbox.id}/folders/${inbox!.id}`, { syncEnabled: false });
    expect(stop.json()).toMatchObject({ syncEnabled: false });
    const priv = await api(h, admin, "PATCH", `/api/mailboxes/${h.seed.mailbox.id}/folders/${inbox!.id}`, { private: true });
    expect(priv.json()).toMatchObject({ private: true, syncEnabled: false });
    const paused = await api(h, admin, "PATCH", `/api/mailboxes/${h.seed.mailbox.id}`, { status: "paused" });
    expect(paused.statusCode).toBe(200);
    expect(paused.json()).toMatchObject({ status: "paused", statusReason: "admin" });
    // Reading configuration and folders is allowed.
    expect((await api(h, admin, "GET", `/api/mailboxes/${h.seed.mailbox.id}/folders`)).statusCode).toBe(200);
  });

  it("an admin cannot resume, re-configure or set the password of a colleague's mailbox", async () => {
    const mb = h.seed.mailbox.id;
    await h.t.db
      .update(s.mailboxes)
      .set({ ...sealMailboxPassword({ id: mb, address: h.seed.mailbox.address }, "pw", h.keys), status: "paused", statusReason: "user" })
      .where(eq(s.mailboxes.id, mb));
    expect((await api(h, admin, "PATCH", `/api/mailboxes/${mb}`, { status: "active" })).statusCode).toBe(403);
    expect((await api(h, admin, "PATCH", `/api/mailboxes/${mb}`, { aliases: ["boss@contoso.example"] })).statusCode).toBe(403);
    expect((await api(h, admin, "PATCH", `/api/mailboxes/${mb}`, { displayName: "x" })).statusCode).toBe(403);
    expect((await api(h, admin, "PATCH", `/api/mailboxes/${mb}`, { smtpHost: "mail.contoso.example" })).statusCode).toBe(403);
    const creds = await api(h, admin, "POST", `/api/mailboxes/${mb}/credentials`, { password: "guess" });
    expect(creds.statusCode).toBe(403);
    expect(h.probe).not.toHaveBeenCalled();
    const [row] = await h.t.db.select().from(s.mailboxes).where(eq(s.mailboxes.id, mb));
    expect(row).toMatchObject({ status: "paused", statusReason: "user", aliases: [] });

    // The owner can do all of it on their own mailbox.
    const owner = await sessionFor(h, h.seed.user.id);
    expect(((await api(h, owner, "PATCH", `/api/mailboxes/${mb}`, { status: "active" })).json() as MailboxSummary).status).toBe("active");
    expect((await api(h, owner, "POST", `/api/mailboxes/${mb}/ingest-token`)).statusCode).toBe(200);
  });
});

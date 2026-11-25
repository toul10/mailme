import { describe, expect, it } from "vitest";
import { EMPTY_MAILBOX_FORM, connectionFormFrom, connectionPatch, mailboxCreateRequest, normalizeAliases, validateConnectionForm, validateMailboxForm } from "../../web/src/mailbox-form.js";
import { EMPTY_TASK_FORM, createRequestFromForm, diffTaskEdit, formFromTask, isEmptyPatch, validateTaskForm } from "../../web/src/task-form.js";

const TASK = {
  title: "Send a quote to ABC",
  status: "ACTION_REQUIRED" as const,
  priority: "NORMAL" as const,
  dueDate: "2026-09-30",
  nextAction: null,
  summary: "They asked for prices for 20 speakers",
  company: "ABC",
  counterpartyName: null,
  counterpartyAddress: "gp@abc-gr.example",
};

describe("task edit diff (edits lock fields, so only changes are sent)", () => {
  it("sends nothing when nothing changed, treating null and empty text alike", () => {
    const form = formFromTask(TASK);
    expect(form.nextAction).toBe("");
    expect(diffTaskEdit(TASK, form)).toEqual({});
    expect(isEmptyPatch(diffTaskEdit(TASK, { ...form, nextAction: "   ", title: ` ${TASK.title} ` }))).toBe(true);
  });

  it("sends only the changed fields, clearing with null", () => {
    const form = { ...formFromTask(TASK), priority: "URGENT" as const, dueDate: "", nextAction: " Phone call ", company: "" };
    expect(diffTaskEdit(TASK, form)).toEqual({ priority: "URGENT", dueDate: null, nextAction: "Phone call", company: null });
  });

  it("never sends an empty title or a closed status", () => {
    expect(diffTaskEdit(TASK, { ...formFromTask(TASK), title: "  " })).toEqual({});
    const closed = { ...TASK, status: "COMPLETED" as const };
    expect(diffTaskEdit(closed, formFromTask(closed))).toEqual({});
    expect(diffTaskEdit(TASK, { ...formFromTask(TASK), status: "DISMISSED" })).toEqual({});
    expect(diffTaskEdit(TASK, { ...formFromTask(TASK), status: "WAITING_FOR_OTHER" })).toEqual({ status: "WAITING_FOR_OTHER" });
  });

  it("compares addresses case-insensitively", () => {
    expect(diffTaskEdit(TASK, { ...formFromTask(TASK), counterpartyAddress: "GP@abc-gr.example" })).toEqual({});
    expect(diffTaskEdit(TASK, { ...formFromTask(TASK), counterpartyAddress: "New@abc-gr.example" })).toEqual({ counterpartyAddress: "new@abc-gr.example" });
  });
});

describe("task form validation and create request", () => {
  it("validates with plain messages", () => {
    expect(validateTaskForm(EMPTY_TASK_FORM)).toBe("The title is required.");
    expect(validateTaskForm({ ...EMPTY_TASK_FORM, title: "x", dueDate: "2026-13-01" })).toBe("Invalid due date.");
    expect(validateTaskForm({ ...EMPTY_TASK_FORM, title: "x", counterpartyAddress: "not an email" })).toBe("Invalid contact email.");
    expect(validateTaskForm({ ...EMPTY_TASK_FORM, title: "x", dueDate: "2026-10-01" })).toBeNull();
  });

  it("maps empty fields to null and keeps the source message", () => {
    const req = createRequestFromForm({ ...EMPTY_TASK_FORM, title: " Call back ", status: "WAITING_FOR_ME", counterpartyAddress: "A@b-gr.example" }, "m1");
    expect(req).toEqual({
      title: "Call back",
      status: "WAITING_FOR_ME",
      priority: "NORMAL",
      dueDate: null,
      nextAction: null,
      company: null,
      counterpartyName: null,
      counterpartyAddress: "a@b-gr.example",
      summary: null,
      fromMessageId: "m1",
    });
    expect(createRequestFromForm({ ...EMPTY_TASK_FORM, title: "x" }, null)).not.toHaveProperty("fromMessageId");
  });

  it("sends the mailbox a user with several chose — never for a task from a message, which has its own", () => {
    const form = { ...EMPTY_TASK_FORM, title: "Κλήση στον λογιστή" };
    expect(createRequestFromForm(form, null, "mb-2")).toMatchObject({ title: "Κλήση στον λογιστή", mailboxId: "mb-2" });
    expect(createRequestFromForm(form, null, "mb-2")).not.toHaveProperty("fromMessageId");
    for (const none of [null, "", undefined]) expect(createRequestFromForm(form, null, none)).not.toHaveProperty("mailboxId");
    const fromMail = createRequestFromForm(form, "m1", "mb-2");
    expect(fromMail).toMatchObject({ fromMessageId: "m1" });
    expect(fromMail).not.toHaveProperty("mailboxId");
  });
});

describe("mailbox form", () => {
  it("starts with an empty host (required) and the default ports", () => {
    expect(EMPTY_MAILBOX_FORM.imapHost).toBe("");
    expect(EMPTY_MAILBOX_FORM.imapPort).toBe("993");
    expect(EMPTY_MAILBOX_FORM.smtpPort).toBe("587");
    expect(validateMailboxForm({ ...EMPTY_MAILBOX_FORM, address: "k@contoso.example" })).toBe("Enter the IMAP server.");
  });

  it("normalizes aliases and defaults the username to the address", () => {
    expect(normalizeAliases([" Sales@Contoso.example", "sales@contoso.example", "", "k@contoso.example"], "K@contoso.example")).toEqual(["sales@contoso.example"]);
    const req = mailboxCreateRequest({ ...EMPTY_MAILBOX_FORM, address: " K@Contoso.example ", imapHost: "mail.contoso.example", smtpHost: "mail.contoso.example", aliases: ["info@contoso.example"] });
    expect(req).toEqual({
      address: "k@contoso.example",
      displayName: null,
      provider: "imap",
      aliases: ["info@contoso.example"],
      smtpHost: "mail.contoso.example",
      smtpPort: 587,
      imapHost: "mail.contoso.example",
      imapPort: 993,
      imapUsername: "k@contoso.example",
    });
  });

  it("omits IMAP settings for ingest-only mailboxes and validates ports", () => {
    const req = mailboxCreateRequest({ ...EMPTY_MAILBOX_FORM, address: "k@contoso.example", provider: "ingest", smtpHost: "" });
    expect(req).not.toHaveProperty("imapHost");
    expect(req.smtpPort).toBeNull();
    expect(validateMailboxForm({ ...EMPTY_MAILBOX_FORM, address: "nope" })).toBe("Enter a valid email address.");
    expect(validateMailboxForm({ ...EMPTY_MAILBOX_FORM, address: "k@contoso.example", imapHost: "mail.contoso.example", imapPort: "99999" })).toBe("Invalid IMAP port.");
    expect(validateMailboxForm({ ...EMPTY_MAILBOX_FORM, address: "k@contoso.example", imapHost: "mail.contoso.example" })).toBeNull();
    // A blank SMTP server is sent as null: delivery then uses the IMAP server and port 587.
    expect(mailboxCreateRequest({ ...EMPTY_MAILBOX_FORM, address: "k@contoso.example", imapHost: "mail.contoso.example" })).toMatchObject({ imapHost: "mail.contoso.example", smtpHost: null, smtpPort: null });
  });

  it("SMTP may only be the IMAP server, on 587/465 (same rule as the server); ingest mailboxes send no SMTP", () => {
    const base = { ...EMPTY_MAILBOX_FORM, address: "k@contoso.example", imapHost: "mail.contoso.example" };
    expect(validateMailboxForm({ ...base, smtpHost: "attacker.example" })).toBe("The SMTP server must be the same as the IMAP server.");
    expect(validateMailboxForm({ ...base, smtpHost: "MAIL.contoso.example", smtpPort: "465" })).toBeNull();
    expect(validateMailboxForm({ ...base, smtpHost: "", smtpPort: "" })).toBeNull();
    expect(validateMailboxForm({ ...base, smtpPort: "25" })).toBe("The SMTP port must be 587 or 465.");
    const ingest = mailboxCreateRequest({ ...base, provider: "ingest" });
    expect(ingest).toMatchObject({ smtpHost: null, smtpPort: null });
    expect(validateMailboxForm({ ...base, provider: "ingest", smtpHost: "anything.example" })).toBeNull();
  });

  describe("correcting the connection settings", () => {
    const MB = { address: "acounts@contoso.example", provider: "imap" as const, imapHost: "mail.contoso.example", imapPort: 993, imapUsername: "acounts@contoso.example", hasMail: false };

    it("shows the login name only when it is not the address, and sends nothing when nothing changed", () => {
      expect(connectionFormFrom(MB)).toEqual({ address: "acounts@contoso.example", imapHost: "mail.contoso.example", imapPort: "993", imapUsername: "" });
      expect(connectionFormFrom({ ...MB, imapUsername: null }).imapUsername).toBe("");
      expect(connectionFormFrom({ ...MB, imapUsername: "sales-login" }).imapUsername).toBe("sales-login");
      expect(connectionPatch(MB, connectionFormFrom(MB))).toEqual({});
      expect(connectionPatch({ ...MB, imapUsername: null }, connectionFormFrom({ ...MB, imapUsername: null }))).toEqual({});
      expect(connectionPatch(MB, { ...connectionFormFrom(MB), address: " Acounts@Contoso.example ", imapHost: " MAIL.contoso.example " })).toEqual({});
    });

    it("a corrected address takes the login name with it; a login name of its own stays", () => {
      expect(connectionPatch(MB, { ...connectionFormFrom(MB), address: " Accounts@Contoso.example " })).toEqual({ address: "accounts@contoso.example", imapUsername: null });
      const custom = { ...MB, imapUsername: "sales-login" };
      expect(connectionPatch(custom, { ...connectionFormFrom(custom), address: "accounts@contoso.example" })).toEqual({ address: "accounts@contoso.example" });
      expect(connectionPatch(custom, { ...connectionFormFrom(custom), imapUsername: " " })).toEqual({ imapUsername: null });
      expect(connectionPatch(MB, { ...connectionFormFrom(MB), imapUsername: " accounts-login " })).toEqual({ imapUsername: "accounts-login" });
    });

    it("sends a new server or port, and never the address or login name of a mailbox that holds mail", () => {
      expect(connectionPatch(MB, { ...connectionFormFrom(MB), imapHost: "Mail2.contoso.example", imapPort: "143" })).toEqual({ imapHost: "mail2.contoso.example", imapPort: 143 });
      const full = { ...MB, hasMail: true };
      expect(connectionPatch(full, { address: "accounts@contoso.example", imapHost: "mail2.contoso.example", imapPort: "993", imapUsername: "x" })).toEqual({ imapHost: "mail2.contoso.example" });
      const ingest = { ...MB, provider: "ingest" as const, imapHost: null, imapUsername: null };
      expect(connectionPatch(ingest, { ...connectionFormFrom(ingest), address: "agent@contoso.example", imapHost: "mail.contoso.example", imapUsername: "x" })).toEqual({ address: "agent@contoso.example" });
    });

    it("validates before sending", () => {
      const form = connectionFormFrom(MB);
      expect(validateConnectionForm(MB, form)).toBeNull();
      expect(validateConnectionForm(MB, { ...form, address: "nope" })).toBe("Enter a valid email address.");
      expect(validateConnectionForm(MB, { ...form, imapHost: " " })).toBe("Enter the IMAP server.");
      expect(validateConnectionForm(MB, { ...form, imapPort: "0" })).toBe("Invalid IMAP port.");
      expect(validateConnectionForm({ ...MB, provider: "ingest", imapHost: null }, { ...form, imapHost: "", imapPort: "" })).toBeNull();
    });
  });
});

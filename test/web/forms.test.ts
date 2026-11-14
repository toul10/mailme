import { describe, expect, it } from "vitest";
import { EMPTY_MAILBOX_FORM, mailboxCreateRequest, normalizeAliases, validateMailboxForm } from "../../web/src/mailbox-form.js";
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
});

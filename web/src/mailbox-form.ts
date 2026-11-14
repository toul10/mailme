/**
 * Mailbox setup form model. The IMAP server starts empty and is required (the field's placeholder is an example);
 * the ports default to IMAPS 993 and SMTP 587. An empty SMTP server means the IMAP server.
 */
import type { CreateMailboxRequest } from "../../src/server/api-types.js";
import { looksLikeEmail } from "./format.js";

export const DEFAULT_IMAP_PORT = 993;
export const DEFAULT_SMTP_PORT = 587;
/** The server accepts only submission ports for the report's SMTP delivery. */
export const SMTP_PORTS: readonly number[] = [587, 465];

export interface MailboxFormState {
  address: string;
  displayName: string;
  provider: "imap" | "ingest";
  imapHost: string;
  imapPort: string;
  /** "" = same as the address. */
  imapUsername: string;
  smtpHost: string;
  smtpPort: string;
  aliases: string[];
}

export const EMPTY_MAILBOX_FORM: MailboxFormState = {
  address: "",
  displayName: "",
  provider: "imap",
  imapHost: "",
  imapPort: String(DEFAULT_IMAP_PORT),
  imapUsername: "",
  smtpHost: "",
  smtpPort: String(DEFAULT_SMTP_PORT),
  aliases: [],
};

/** Lower-cased, trimmed, unique, without the primary address. */
export function normalizeAliases(aliases: readonly string[], primary?: string): string[] {
  const own = primary?.trim().toLowerCase();
  const out: string[] = [];
  for (const a of aliases) {
    const v = a.trim().toLowerCase();
    if (v && v !== own && !out.includes(v)) out.push(v);
  }
  return out;
}

function parsePort(value: string): number | null {
  const n = Number(value.trim());
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

/** Validation message for the form, or null. */
export function validateMailboxForm(form: MailboxFormState): string | null {
  if (!looksLikeEmail(form.address)) return "Enter a valid email address.";
  for (const a of form.aliases) if (!looksLikeEmail(a)) return `Invalid alias: ${a}`;
  if (form.provider === "imap") {
    if (!form.imapHost.trim()) return "Enter the IMAP server.";
    if (parsePort(form.imapPort) === null) return "Invalid IMAP port.";
  }
  if (form.provider === "imap") {
    const smtp = smtpFieldsProblem(form.imapHost, form.smtpHost, form.smtpPort);
    if (smtp) return smtp;
  }
  return null;
}

/**
 * Same rule as the server: the report's SMTP login uses the mailbox password, which is only ever verified against the
 * IMAP server — so the SMTP server may only be that same server (empty = the same). A message, or null.
 */
export function smtpFieldsProblem(imapHost: string | null, smtpHost: string, smtpPort: string): string | null {
  const host = smtpHost.trim().toLowerCase();
  if (host && host !== (imapHost ?? "").trim().toLowerCase()) return "The SMTP server must be the same as the IMAP server.";
  if (smtpPort.trim()) {
    const port = parsePort(smtpPort);
    if (port === null || !SMTP_PORTS.includes(port)) return "The SMTP port must be 587 or 465.";
  }
  return null;
}

export function mailboxCreateRequest(form: MailboxFormState): CreateMailboxRequest {
  const address = form.address.trim().toLowerCase();
  // Ingest-only mailboxes have no password, so no SMTP delivery either.
  const smtpHost = form.provider === "imap" ? form.smtpHost.trim() || null : null;
  const req: CreateMailboxRequest = {
    address,
    displayName: form.displayName.trim() || null,
    provider: form.provider,
    aliases: normalizeAliases(form.aliases, address),
    smtpHost,
    smtpPort: smtpHost ? parsePort(form.smtpPort) : null,
  };
  if (form.provider === "imap") {
    req.imapHost = form.imapHost.trim();
    req.imapPort = parsePort(form.imapPort) ?? DEFAULT_IMAP_PORT;
    req.imapUsername = form.imapUsername.trim() || address;
  }
  return req;
}

/**
 * Mailbox setup form model. The IMAP server starts empty and is required (the field's placeholder is an example);
 * the ports default to IMAPS 993 and SMTP 587. An empty SMTP server means the IMAP server.
 */
import type { CreateMailboxRequest, MailboxSummary, UpdateMailboxRequest } from "../../src/server/api-types.js";
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

// ── Correcting the connection settings of an existing mailbox ────────────────

export interface ConnectionFormState {
  address: string;
  imapHost: string;
  imapPort: string;
  /** "" = same as the address. */
  imapUsername: string;
}

export type ConnectionPatch = Pick<UpdateMailboxRequest, "address" | "imapHost" | "imapPort" | "imapUsername">;

type ConnectionSource = Pick<MailboxSummary, "address" | "provider" | "imapHost" | "imapPort" | "imapUsername" | "hasMail">;

/** The login name the server uses: the stored one, or the address. */
function loginOf(m: Pick<MailboxSummary, "address" | "imapUsername">): string {
  return m.imapUsername ?? m.address;
}

export function connectionFormFrom(m: ConnectionSource): ConnectionFormState {
  const login = loginOf(m);
  return { address: m.address, imapHost: m.imapHost ?? "", imapPort: String(m.imapPort), imapUsername: login === m.address ? "" : login };
}

/** Validation message, or null. */
export function validateConnectionForm(m: ConnectionSource, form: ConnectionFormState): string | null {
  if (!looksLikeEmail(form.address)) return "Enter a valid email address.";
  if (m.provider === "imap") {
    if (!form.imapHost.trim()) return "Enter the IMAP server.";
    if (parsePort(form.imapPort) === null) return "Invalid IMAP port.";
  }
  return null;
}

/**
 * Only what the form changes ({} = nothing). A mailbox that holds mail keeps its address and login name (the server
 * refuses them), so the form does not send them then. An empty login name is sent as null: the address.
 */
export function connectionPatch(m: ConnectionSource, form: ConnectionFormState): ConnectionPatch {
  const patch: ConnectionPatch = {};
  const address = m.hasMail ? m.address : form.address.trim().toLowerCase();
  if (address !== m.address) patch.address = address;
  if (m.provider !== "imap") return patch;
  const host = form.imapHost.trim().toLowerCase();
  if (host !== (m.imapHost ?? "").toLowerCase()) patch.imapHost = host;
  const port = parsePort(form.imapPort);
  if (port !== null && port !== m.imapPort) patch.imapPort = port;
  if (!m.hasMail) {
    const login = form.imapUsername.trim();
    if ((login || address) !== loginOf(m)) patch.imapUsername = login || null;
  }
  return patch;
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

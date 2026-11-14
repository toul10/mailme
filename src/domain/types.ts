/**
 * Shared domain vocabulary. Every module imports enums and cross-module shapes from here.
 * Changing anything in this file is a contract change.
 */

// ── Tasks ────────────────────────────────────────────────────────────────────

export const TASK_STATUSES = ["ACTION_REQUIRED", "WAITING_FOR_ME", "WAITING_FOR_OTHER", "COMPLETED", "DISMISSED"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const OPEN_STATUSES = ["ACTION_REQUIRED", "WAITING_FOR_ME", "WAITING_FOR_OTHER"] as const satisfies readonly TaskStatus[];
export type OpenStatus = (typeof OPEN_STATUSES)[number];
export const isOpenStatus = (s: string): s is OpenStatus => (OPEN_STATUSES as readonly string[]).includes(s);

export const PRIORITIES = ["URGENT", "HIGH", "NORMAL", "LOW"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const TASK_ORIGINS = ["ai", "manual", "backfill"] as const;
export type TaskOrigin = (typeof TASK_ORIGINS)[number];

export const OWNER_KINDS = ["ME", "INTERNAL", "EXTERNAL", "UNKNOWN"] as const;
export type OwnerKind = (typeof OWNER_KINDS)[number];

export const SNOOZE_MODES = ["until_date", "until_reply"] as const;
export type SnoozeMode = (typeof SNOOZE_MODES)[number];

export const ACTORS = ["ai", "user", "system"] as const;
export type Actor = (typeof ACTORS)[number];

/** Fields a user edit locks against later AI changes. */
export const LOCKABLE_FIELDS = ["status", "dueDate", "priority", "nextAction", "summary", "company", "owner"] as const;
export type LockableField = (typeof LOCKABLE_FIELDS)[number];

export const TIERS = ["auto", "review", "logged"] as const;
export type Tier = (typeof TIERS)[number];

export const SUGGESTION_STATES = ["pending", "accepted", "rejected", "expired"] as const;
export type SuggestionState = (typeof SUGGESTION_STATES)[number];

/** Every op recorded in task_events. AI ops mirror the extraction schema; the rest are user/system actions. */
export const EVENT_OPS = [
  // AI
  "CREATE",
  "UPDATE",
  "COMPLETE",
  "REOPEN",
  "SUGGEST_DISMISS",
  // user
  "USER_CREATE",
  "USER_EDIT",
  "USER_COMPLETE",
  "USER_DISMISS",
  "USER_REOPEN",
  "USER_SNOOZE",
  "USER_UNSNOOZE",
  "USER_MERGE",
  "USER_HANDLED_BY_OTHER",
  "USER_CONFIRM",
  "USER_NOT_A_TASK",
  "USER_STILL_VALID",
  "USER_MISSED",
  "USER_WOULD_HAVE_MISSED",
  "USER_ACCEPT_SUGGESTION",
  "USER_REJECT_SUGGESTION",
  // system
  "SYSTEM_UNSNOOZE",
  "SYSTEM_DORMANT",
  "SYSTEM_BOUNCE",
  "SYSTEM_STILL_VALID_ASKED",
  /** The owner's «answered» rule: someone at the organization replied in the thread (src/engine/answered.ts). */
  "SYSTEM_ANSWERED",
  /** `rules:apply`: an open task whose origin mail one of the owner's ignore rules now covers (src/engine/rule-apply.ts). */
  "SYSTEM_RULE_DISMISS",
] as const;
export type EventOp = (typeof EVENT_OPS)[number];

// ── Messages ─────────────────────────────────────────────────────────────────

export type Direction = "INBOUND" | "OUTBOUND";

export const MESSAGE_STATES = [
  "discovered", // stored, not yet classified (transient inside ingest)
  "filtered", // pre-filter decided: no AI (see filterReason)
  "pending", // waiting for extraction
  "extracted", // extraction stored, not yet applied
  "applied", // ops applied (or none)
  "failed", // parked after per-message error
  "skipped_old", // older than horizon → never sent to AI
  "own_mail", // platform's own mail (digest) → ignored
] as const;
export type MessageState = (typeof MESSAGE_STATES)[number];

export const MESSAGE_CLASSES = ["ACTIONABLE", "FYI", "AUTOMATED", "MARKETING", "PERSONAL", "SPAM"] as const;
export type MessageClass = (typeof MESSAGE_CLASSES)[number];

export const FILTER_REASONS = [
  "OWN_MAIL",
  "BULK",
  "NOREPLY",
  "DENYLIST",
  /** The user's own "Ignore" list (users.muted_senders): never reaches the AI. */
  "MUTED",
  "BOUNCE",
  "OUT_OF_OFFICE",
  "CALENDAR_REPLY",
  "SPAM_FOLDER",
  /** Impersonates the owner's own domain/address and carries a credential or extortion lure (src/mail/prefilter.ts). */
  "PHISHING",
  /** One of the user's own ignore rules (users.mail_rules, src/domain/rules.ts); messages.filter_rule names it. */
  "RULE",
  "DRAFT_OR_DELETED",
  "TOO_OLD",
  "EMPTY",
  "ENCRYPTED",
] as const;
export type FilterReason = (typeof FILTER_REASONS)[number];

export const FOLDER_ROLES = ["inbox", "sent", "archive", "junk", "trash", "drafts", "other"] as const;
export type FolderRole = (typeof FOLDER_ROLES)[number];

export const MAILBOX_STATUSES = ["setup", "active", "auth_failed", "blocked", "paused", "disabled"] as const;
export type MailboxStatus = (typeof MAILBOX_STATUSES)[number];

export const LINK_CONFIDENCES = ["HIGH", "MEDIUM", "LOW"] as const;
export type LinkConfidence = (typeof LINK_CONFIDENCES)[number];

export interface Address {
  /** lower-cased */
  address: string;
  name: string | null;
}

export interface Attachment {
  filename: string;
  contentType: string;
  size: number;
  inline: boolean;
}

export type SegmentKind = "NEW" | "QUOTED" | "FORWARDED";

export interface Segment {
  /** "S1", "S2", … in body order */
  id: string;
  kind: SegmentKind;
  text: string;
  /** For QUOTED/FORWARDED: the quoted author as written in the header block, if detected. */
  author: string | null;
  /** For QUOTED/FORWARDED: ISO instant of the quoted message if the header block had a parseable date. */
  date: string | null;
  truncated: boolean;
}

export interface CalendarInfo {
  method: string; // REQUEST | CANCEL | REPLY | PUBLISH | …
  summary: string | null;
  start: string | null; // ISO
  end: string | null; // ISO
  tzid: string | null;
  organizer: string | null;
  location: string | null;
}

export interface BounceInfo {
  action: "failed" | "delayed" | "delivered" | "relayed" | "expanded" | "unknown";
  originalMessageId: string | null;
  recipient: string | null;
  diagnostic: string | null;
}

/** Output of MIME parsing (src/mail/parse.ts). Pure data, no DB ids. */
export interface ParsedMail {
  messageIdHeader: string | null;
  from: Address | null;
  sender: Address | null;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  replyTo: Address[];
  subject: string;
  dateHeader: Date | null;
  inReplyTo: string | null;
  references: string[];
  /** Raw Thread-Index header (base64) if present. */
  threadIndex: string | null;
  /** Selected headers, lower-cased names (see HEADER_ALLOWLIST in parse.ts). */
  headers: Record<string, string>;
  textPlain: string | null;
  textHtml: string | null;
  attachments: Attachment[];
  calendar: CalendarInfo | null;
  bounce: BounceInfo | null;
  /** S/MIME encrypted, TNEF, charset repairs, … */
  decodeWarnings: string[];
  /** Delivered-To / X-Original-To / Return-Path present → this copy was delivered by the server. */
  hasDeliveryTrace: boolean;
  sizeBytes: number;
}

/** Where a copy of a message was seen. Absent for ingest-API / .eml imports. */
export interface MessageLocationInput {
  folderId: string;
  folderRole: FolderRole;
  uid: number;
  internalDate: Date | null;
  flags: string[];
}

export interface IngestInput {
  mailboxId: string;
  source: { kind: "mime"; raw: Buffer } | { kind: "parsed"; parsed: ParsedMail };
  location: MessageLocationInput | null;
  /** When the platform first saw this copy (defaults to now). */
  seenAt?: Date;
  /** Origin of this ingestion. */
  via: "imap" | "ingest_api" | "eml_import" | "outlook_agent";
  /** The uploader asserts this is the owner's sent mail (Outlook agent "Sent Items"). Still requires From ∈ owner. */
  declaredOutbound?: boolean;
}

export interface IngestResult {
  messageId: string;
  created: boolean;
  state: MessageState;
  filterReason: FilterReason | null;
  direction: Direction;
  threadId: string | null;
}

// ── Extraction (AI) ──────────────────────────────────────────────────────────

/** Fixed local handles so the JSON schema is static & cacheable and contains no personal data. */
export const TASK_HANDLES = ["K1", "K2", "K3", "K4", "K5", "K6", "K7", "K8", "K9", "K10", "K11", "K12"] as const;
export type TaskHandle = (typeof TASK_HANDLES)[number];
export const PARTICIPANT_HANDLES = ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8"] as const;
export type ParticipantHandle = (typeof PARTICIPANT_HANDLES)[number];
/** P1 is always the mailbox owner. */
export const OWNER_HANDLE: ParticipantHandle = "P1";

export type TaskCardScope = "THREAD_OPEN" | "THREAD_CLOSED" | "RELATED_OPEN";

export interface TaskCard {
  handle: TaskHandle;
  scope: TaskCardScope;
  title: string;
  status: TaskStatus;
  ownerHandle: ParticipantHandle | "UNKNOWN";
  counterpartyHandle: ParticipantHandle | null;
  company: string | null;
  dueDate: string | null;
  duePhrase: string | null;
  items: string[];
  originEvidence: string | null;
  originDate: string | null; // human anchor, e.g. "Wednesday 2026-09-09 10:02"
  lastEvent: string | null;
  lastEventDate: string | null;
  closedBy: Actor | null;
}

export interface ParticipantRef {
  handle: ParticipantHandle;
  address: string;
  name: string | null;
  isOwner: boolean;
  isInternal: boolean;
  company: string | null;
  roles: Array<"from" | "to" | "cc" | "bcc" | "quoted" | "task">;
}

export interface ThreadDigestEntry {
  date: string; // human anchor
  direction: Direction;
  fromHandle: ParticipantHandle | "OTHER";
  subject: string;
  newText: string; // NEW segment(s) only, truncated
}

export interface ExtractionInput {
  owner: {
    name: string | null;
    address: string;
    aliases: string[];
    internalDomains: string[];
    /** "About your work" (users.profile_note): P1's own words about what they handle. Data, not instructions. */
    notes?: string | null;
  };
  zone: string;
  message: {
    direction: Direction;
    sentAnchor: string; // "Friday 2026-09-11 13:44 (Europe/Athens)"
    subject: string;
    fromHandle: ParticipantHandle | "OTHER";
    toHandles: Array<ParticipantHandle | "OTHER">;
    ccHandles: Array<ParticipantHandle | "OTHER">;
    attachments: Array<{ filename: string; contentType: string }>;
    segments: Array<Segment & { anchor: string | null }>;
    calendar: CalendarInfo | null;
    late: boolean;
  };
  participants: ParticipantRef[];
  taskCards: TaskCard[];
  threadDigest: ThreadDigestEntry[];
  lowLinkConfidence: boolean;
  /**
   * The owner's enabled rules (users.mail_rules, src/domain/rules.ts) and the facts the forward rule needs. Only the
   * rule texts reach the AI (<owner_rules>). Absent when the owner has no rules.
   */
  rules?: {
    list: import("./rules.js").MailRule[];
    /** From and To+Cc, lower-cased (participant handles stop at P8). */
    from: string | null;
    recipients: string[];
    /** Inbound from outside the organization and not the owner. */
    external: boolean;
    /** A reply or forward (subject prefix or In-Reply-To), not a new mail. */
    reply: boolean;
    /** The owner or a colleague wrote to the sender's domain, or its earlier mail also went to someone else at the company. */
    senderKnown: boolean;
  };
}

/** Maps local handles back to DB ids / addresses for one extraction call. Stored with the extraction. */
export interface HandleMap {
  tasks: Partial<Record<TaskHandle, string>>; // handle → task id
  participants: Partial<Record<ParticipantHandle, { address: string; name: string | null; isOwner: boolean; isInternal: boolean }>>;
}

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export type ExtractorErrorClass = "TRANSIENT" | "PER_MESSAGE" | "GLOBAL";

export type ExtractorResult =
  | {
      ok: true;
      output: import("../ai/schema.js").ExtractionOutput;
      model: string;
      stopReason: string;
      usage: AiUsage;
      costUsd: number;
      latencyMs: number;
      /** What was sent (system prompt omitted — it is identified by pipelineVersion). */
      request: unknown;
    }
  | {
      ok: false;
      errorClass: ExtractorErrorClass;
      error: string;
      retryAfterSec: number | null;
      model: string | null;
      stopReason: string | null;
      usage: AiUsage | null;
      costUsd: number;
      latencyMs: number;
      request: unknown;
    };

export interface Extractor {
  readonly name: string;
  /** prompt + schema + model + cleaner + resolver versions. Extractions are reused per pipelineVersion. */
  readonly pipelineVersion: string;
  extract(input: ExtractionInput): Promise<ExtractorResult>;
}

// ── Mail transport (digest delivery) ─────────────────────────────────────────

export interface MailboxConnectionSettings {
  mailboxId: string;
  address: string;
  imapHost: string;
  imapPort: number;
  imapUsername: string;
  smtpHost: string | null;
  smtpPort: number | null;
}

export interface AppendResult {
  alreadyPresent: boolean;
  uid: number | null;
  folder: string;
}

export interface MailTransport {
  /** Idempotent: searches INBOX for Message-ID first; appends only if absent. */
  appendToInbox(settings: MailboxConnectionSettings, password: string, raw: Buffer, messageIdHeader: string): Promise<AppendResult>;
  sendSmtp(settings: MailboxConnectionSettings, password: string, raw: Buffer, envelope: { from: string; to: string[] }): Promise<{ messageId: string }>;
}

// ── AI pause switches ────────────────────────────────────────────────────────

/** app_state key of the global AI pause (GLOBAL extractor errors, internal errors). Resume = delete the row. */
export const GLOBAL_PAUSE_KEY = "ai_global_pause";

/** mailboxes.ai_paused_reason values set by the daily budget check (cleared by the worker at 00:05 local). */
export const BUDGET_PAUSE_REASONS = { calls: "budget:calls", usd: "budget:usd" } as const;

// ── Misc ─────────────────────────────────────────────────────────────────────

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
  debug(obj: object, msg?: string): void;
  child(bindings: object): Logger;
}

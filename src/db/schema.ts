import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  Address,
  Attachment,
  BounceInfo,
  CalendarInfo,
  HandleMap,
  Segment,
} from "../domain/types.js";
import type { MailRule } from "../domain/rules.js";
import { AI_PROVIDERS, type AiModelOption, type AiProvider } from "../ai/providers.js";
import {
  ACTORS,
  FOLDER_ROLES,
  LINK_CONFIDENCES,
  MAILBOX_STATUSES,
  MESSAGE_STATES,
  OWNER_KINDS,
  PRIORITIES,
  SNOOZE_MODES,
  SUGGESTION_STATES,
  TASK_ORIGINS,
  TASK_STATUSES,
  TIERS,
} from "../domain/types.js";

/**
 * Canonical data model (overview: docs/architecture.md § Data model).
 * Conventions: uuid ids, timestamptz in UTC, business dates as SQL `date` in the org timezone.
 */

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => ts("created_at").notNull().defaultNow();
const updatedAt = () => ts("updated_at").notNull().defaultNow();

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  timezone: text("timezone").notNull().default("Europe/Athens"),
  internalDomains: text("internal_domains").array().notNull().default(sql`'{}'::text[]`),
  /** Include Holy Spirit Monday (Whit Monday) in the business-day calendar. */
  holySpiritHoliday: boolean("holy_spirit_holiday").notNull().default(false),
  createdAt: createdAt(),
});

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    name: text("name").notNull(),
    email: text("email").notNull(),
    /** admin = configuration & health only; never task/message content of others. */
    role: text("role", { enum: ["admin", "member"] }).notNull().default("member"),
    /**
     * Platform administrator: manages organizations and accounts of every organization from #/admin
     * (src/server/routes/admin.ts). Configuration and health only — never task or message content.
     */
    platformAdmin: boolean("platform_admin").notNull().default(false),
    /**
     * One-time account setup link ("activation link"): sha256 of the token and its expiry. Using it sets a new
     * password and resets TOTP (src/server/auth/setup-links.ts). The token itself is never stored.
     */
    setupTokenHash: text("setup_token_hash"),
    setupExpiresAt: ts("setup_expires_at"),
    passwordHash: text("password_hash"),
    /** TOTP secret, encrypted with MASTER_KEY (src/lib/crypto.ts). */
    totpSecretEnc: text("totp_secret_enc"),
    totpEnabled: boolean("totp_enabled").notNull().default(false),
    /** Last accepted TOTP time step (replay guard that survives restarts / multiple API instances). */
    totpLastStep: bigint("totp_last_step", { mode: "number" }),
    digestEnabled: boolean("digest_enabled").notNull().default(true),
    /** Local time "HH:MM" in the org timezone. */
    digestTime: text("digest_time").notNull().default("07:30"),
    digestDelivery: text("digest_delivery", { enum: ["append", "smtp"] }).notNull().default("append"),
    /** Mailbox used to deliver the digest (APPEND target / SMTP account). */
    digestMailboxId: uuid("digest_mailbox_id"),
    /** First local date the digest may be sent (shadow week → set to the go-live date). */
    digestStartDate: date("digest_start_date", { mode: "string" }),
    locale: text("locale").notNull().default("el"),
    /**
     * "What matters to me" (src/domain/preferences.ts). important: addresses, "@domain" or company names whose
     * tasks come first; muted: addresses or "@domain" whose inbound mail never reaches the AI (filter MUTED);
     * cc_policy: what an AI-created task from mail where the user is only in Cc does; profile_note: the user's own
     * words about what they handle, given to the AI as data.
     */
    importantSenders: text("important_senders").array().notNull().default(sql`'{}'::text[]`),
    mutedSenders: text("muted_senders").array().notNull().default(sql`'{}'::text[]`),
    ccPolicy: text("cc_policy", { enum: ["ask", "create", "ignore"] }).notNull().default("ask"),
    profileNote: text("profile_note"),
    /** "Rules" (src/domain/rules.ts): the user's own mail rules, as data. Empty = no rule-driven behaviour. */
    mailRules: jsonb("mail_rules").$type<MailRule[]>().notNull().default([]),
    disabledAt: ts("disabled_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("users_email_uq").on(sql`lower(${t.email})`)],
);

export const mailboxes = pgTable(
  "mailboxes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    userId: uuid("user_id").notNull().references(() => users.id),
    provider: text("provider", { enum: ["imap", "ingest"] }).notNull().default("imap"),
    /** Primary address, lower-cased. */
    address: text("address").notNull(),
    /** Other addresses/identities of the owner (lower-cased). */
    aliases: text("aliases").array().notNull().default(sql`'{}'::text[]`),
    displayName: text("display_name"),
    imapHost: text("imap_host"),
    imapPort: integer("imap_port").notNull().default(993),
    imapUsername: text("imap_username"),
    smtpHost: text("smtp_host"),
    smtpPort: integer("smtp_port").default(587),
    /** Sealed with the worker's public key (src/lib/sealed.ts); AAD = `${id}|${address}`. */
    credentialsSealed: text("credentials_sealed"),
    credentialsKid: text("credentials_kid"),
    /** sha256 of the bearer token for the ingest API / Outlook agent. */
    ingestTokenHash: text("ingest_token_hash"),
    status: text("status", { enum: MAILBOX_STATUSES }).notNull().default("setup"),
    statusReason: text("status_reason"),
    lastError: text("last_error"),
    lastErrorAt: ts("last_error_at"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    nextAttemptAt: ts("next_attempt_at"),
    lastSyncAt: ts("last_sync_at"),
    lastLoginAt: ts("last_login_at"),
    /** Messages older than this are stored as skipped_old and never analysed. */
    backfillFrom: ts("backfill_from"),
    /** Go-live watermark: messages first seen after this are "live"; before it, backfill. */
    liveSince: ts("live_since"),
    /** Per-mailbox kill switch for AI calls (budget or manual). */
    aiPaused: boolean("ai_paused").notNull().default(false),
    aiPausedReason: text("ai_paused_reason"),
    aiDailyCallCap: integer("ai_daily_call_cap"),
    aiDailyUsdCap: real("ai_daily_usd_cap"),
    /** Result of the last probe: CAPABILITY, namespace, delimiter, quota. No content. */
    probe: jsonb("probe").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("mailboxes_user_address_uq").on(t.userId, t.address)],
);

export const mailboxFolders = pgTable(
  "mailbox_folders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    mailboxId: uuid("mailbox_id").notNull().references(() => mailboxes.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    /** Decoded, human-readable name. */
    name: text("name").notNull(),
    delimiter: text("delimiter"),
    role: text("role", { enum: FOLDER_ROLES }).notNull().default("other"),
    specialUse: text("special_use"),
    /** How the role was decided: special_use | name | user */
    roleSource: text("role_source", { enum: ["special_use", "name", "user"] }).notNull().default("name"),
    syncEnabled: boolean("sync_enabled").notNull().default(false),
    /** User marked private: never synced/analysed. */
    private: boolean("private").notNull().default(false),
    uidValidity: bigint("uid_validity", { mode: "number" }),
    uidNext: bigint("uid_next", { mode: "number" }),
    lastSeenUid: bigint("last_seen_uid", { mode: "number" }).notNull().default(0),
    firstSyncDone: boolean("first_sync_done").notNull().default(false),
    lastSyncedAt: ts("last_synced_at"),
    /** Consecutive failed sync attempts of this folder (EXAMINE/STATUS/SEARCH errors); reset on success. */
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    failingSince: ts("failing_since"),
    lastError: text("last_error"),
    goneAt: ts("gone_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("mailbox_folders_path_uq").on(t.mailboxId, t.path)],
);

export const mailboxLoginAttempts = pgTable(
  "mailbox_login_attempts",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    mailboxId: uuid("mailbox_id").notNull().references(() => mailboxes.id, { onDelete: "cascade" }),
    at: ts("at").notNull().defaultNow(),
    purpose: text("purpose", { enum: ["sync", "probe", "append", "smtp"] }).notNull(),
    outcome: text("outcome", { enum: ["ok", "auth_failed", "network", "tls", "too_many", "protocol", "other"] }).notNull(),
    detail: text("detail"),
  },
  (t) => [index("mailbox_login_attempts_mb_at").on(t.mailboxId, t.at)],
);

export const threads = pgTable(
  "threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    mailboxId: uuid("mailbox_id").notNull().references(() => mailboxes.id, { onDelete: "cascade" }),
    subjectNorm: text("subject_norm").notNull().default(""),
    /** Thread-Index root (first 22 bytes, base64) when present. */
    conversationKey: text("conversation_key"),
    mergedIntoId: uuid("merged_into_id"),
    linkConfidence: text("link_confidence", { enum: LINK_CONFIDENCES }).notNull().default("HIGH"),
    firstMessageAt: ts("first_message_at"),
    lastMessageAt: ts("last_message_at"),
    messageCount: integer("message_count").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    index("threads_mb_conv").on(t.mailboxId, t.conversationKey),
    index("threads_mb_subject").on(t.mailboxId, t.subjectNorm),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    mailboxId: uuid("mailbox_id").notNull().references(() => mailboxes.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id"),
    /** Message-ID (normalized, without <>) or "h:<sha256>" when missing. Unique per mailbox. */
    messageKey: text("message_key").notNull(),
    messageIdHeader: text("message_id_header"),
    direction: text("direction", { enum: ["INBOUND", "OUTBOUND"] }).notNull(),
    fromAddress: text("from_address"),
    fromName: text("from_name"),
    to: jsonb("to").$type<Address[]>().notNull().default([]),
    cc: jsonb("cc").$type<Address[]>().notNull().default([]),
    bcc: jsonb("bcc").$type<Address[]>().notNull().default([]),
    replyTo: jsonb("reply_to").$type<Address[]>().notNull().default([]),
    subject: text("subject").notNull().default(""),
    subjectNorm: text("subject_norm").notNull().default(""),
    dateHeader: ts("date_header"),
    internalDate: ts("internal_date"),
    /** Processing order key. */
    sortTs: ts("sort_ts").notNull(),
    firstSeenAt: ts("first_seen_at").notNull().defaultNow(),
    inReplyTo: text("in_reply_to"),
    references: text("references").array().notNull().default(sql`'{}'::text[]`),
    threadIndex: text("thread_index"),
    /** Allow-listed headers only (lower-cased names). */
    headers: jsonb("headers").$type<Record<string, string>>().notNull().default({}),
    segments: jsonb("segments").$type<Segment[]>().notNull().default([]),
    attachments: jsonb("attachments").$type<Attachment[]>().notNull().default([]),
    calendar: jsonb("calendar").$type<CalendarInfo | null>(),
    bounce: jsonb("bounce").$type<BounceInfo | null>(),
    /** Text parts kept for the retention window (reprocessing). No attachments. */
    textPlain: text("text_plain"),
    textHtml: text("text_html"),
    bodyPurgedAt: ts("body_purged_at"),
    sizeBytes: integer("size_bytes").notNull().default(0),
    classification: text("classification"),
    filterReason: text("filter_reason"),
    /** filterReason RULE: the id of the user's rule (users.mail_rules) that ignored the message. */
    filterRule: text("filter_rule"),
    state: text("state", { enum: MESSAGE_STATES }).notNull().default("discovered"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: ts("next_attempt_at"),
    lockedUntil: ts("locked_until"),
    lastError: text("last_error"),
    late: boolean("late").notNull().default(false),
    claimsOwnerSender: boolean("claims_owner_sender").notNull().default(false),
    hasDeliveryTrace: boolean("has_delivery_trace").notNull().default(false),
    decodeWarnings: text("decode_warnings").array().notNull().default(sql`'{}'::text[]`),
    /** true if first seen before mailbox.liveSince (backfill). */
    backfill: boolean("backfill").notNull().default(false),
    appliedExtractionId: uuid("applied_extraction_id"),
    /** A parked (failed) message the user/operator acknowledged: no longer reported. */
    failureAcknowledgedAt: ts("failure_acknowledged_at"),
    via: text("via").notNull().default("imap"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("messages_mb_key_uq").on(t.mailboxId, t.messageKey),
    index("messages_queue").on(t.mailboxId, t.state, t.sortTs),
    index("messages_mb_msgid").on(t.mailboxId, t.messageIdHeader),
    index("messages_thread").on(t.threadId, t.sortTs),
    index("messages_bounce_original")
      .on(t.mailboxId, sql`(${t.bounce} ->> 'originalMessageId')`)
      .where(sql`${t.filterReason} = 'BOUNCE'`),
  ],
);

export const messageLocations = pgTable(
  "message_locations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    messageId: uuid("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
    folderId: uuid("folder_id").notNull().references(() => mailboxFolders.id, { onDelete: "cascade" }),
    uid: bigint("uid", { mode: "number" }).notNull(),
    internalDate: ts("internal_date"),
    flags: text("flags").array().notNull().default(sql`'{}'::text[]`),
    firstSeenAt: ts("first_seen_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("message_locations_folder_uid_uq").on(t.folderId, t.uid), index("message_locations_msg").on(t.messageId)],
);

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    /** User who sees this task (mailbox owner). */
    userId: uuid("user_id").notNull().references(() => users.id),
    mailboxId: uuid("mailbox_id").references(() => mailboxes.id),
    /** Short human reference shown in UI/report, e.g. 184 → "#184". */
    ref: integer("ref").notNull(),
    ownerKind: text("owner_kind", { enum: OWNER_KINDS }).notNull().default("ME"),
    ownerAddress: text("owner_address"),
    ownerName: text("owner_name"),
    /** Immutable after CREATE for AI; users may edit (USER_EDIT). */
    title: text("title").notNull(),
    status: text("status", { enum: TASK_STATUSES }).notNull(),
    priority: text("priority", { enum: PRIORITIES }).notNull().default("NORMAL"),
    counterpartyAddress: text("counterparty_address"),
    counterpartyName: text("counterparty_name"),
    company: text("company"),
    companyDomain: text("company_domain"),
    items: text("items").array().notNull().default(sql`'{}'::text[]`),
    dueDate: date("due_date", { mode: "string" }),
    duePhrase: text("due_phrase"),
    dueKind: text("due_kind"),
    /** For WAITING_FOR_OTHER: follow-up date. */
    expectReplyBy: date("expect_reply_by", { mode: "string" }),
    /** When the current waiting period started (status entered WAITING_*). */
    waitingSince: ts("waiting_since"),
    snoozedUntil: date("snoozed_until", { mode: "string" }),
    snoozeMode: text("snooze_mode", { enum: SNOOZE_MODES }),
    nextAction: text("next_action"),
    summary: text("summary"),
    needsReview: boolean("needs_review").notNull().default(false),
    reviewReasons: text("review_reasons").array().notNull().default(sql`'{}'::text[]`),
    lockedFields: text("locked_fields").array().notNull().default(sql`'{}'::text[]`),
    version: integer("version").notNull().default(1),
    mergedIntoId: uuid("merged_into_id"),
    origin: text("origin", { enum: TASK_ORIGINS }).notNull(),
    originMessageId: uuid("origin_message_id"),
    closedBy: text("closed_by", { enum: ACTORS }),
    closedAt: ts("closed_at"),
    /** Set when AI closed it — shown once in the next report ("Closed automatically"). */
    autoClosedReportedAt: ts("auto_closed_reported_at"),
    stillValidAskedAt: ts("still_valid_asked_at"),
    dormantAt: ts("dormant_at"),
    lastActivityAt: ts("last_activity_at").notNull().defaultNow(),
    /** Accent/case-folded text for search & candidate retrieval (src/lib/text.ts foldForSearch). */
    searchText: text("search_text").notNull().default(""),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("tasks_user_ref_uq").on(t.userId, t.ref),
    index("tasks_user_open")
      .on(t.userId, t.status)
      .where(sql`${t.status} in ('ACTION_REQUIRED','WAITING_FOR_ME','WAITING_FOR_OTHER') and ${t.mergedIntoId} is null`),
    index("tasks_mb_counterparty")
      .on(t.mailboxId, sql`lower(${t.counterpartyAddress})`)
      .where(sql`${t.status} in ('ACTION_REQUIRED','WAITING_FOR_ME','WAITING_FOR_OTHER')`),
    index("tasks_mb_company_domain").on(t.mailboxId, t.companyDomain),
    index("tasks_search").using("gin", sql`to_tsvector('simple', ${t.searchText})`),
  ],
);

export const taskLinks = pgTable(
  "task_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id"),
    messageId: uuid("message_id"),
    role: text("role", { enum: ["origin", "update", "completion", "reopen", "reference", "manual"] }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("task_links_uq").on(t.taskId, t.messageId, t.role),
    index("task_links_thread").on(t.threadId),
    index("task_links_message").on(t.messageId),
  ],
);

export const extractions = pgTable(
  "extractions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    messageId: uuid("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
    mailboxId: uuid("mailbox_id").notNull(),
    pipelineVersion: text("pipeline_version").notNull(),
    attempt: integer("attempt").notNull().default(1),
    status: text("status", { enum: ["ok", "error"] }).notNull(),
    errorClass: text("error_class", { enum: ["TRANSIENT", "PER_MESSAGE", "GLOBAL"] }),
    error: text("error"),
    requestedModel: text("requested_model"),
    /** Model that actually answered (fallbacks may change it). */
    model: text("model"),
    stopReason: text("stop_reason"),
    /** Rendered input (ExtractionInput); purged with retention. */
    request: jsonb("request").$type<unknown>(),
    handleMap: jsonb("handle_map").$type<HandleMap>(),
    output: jsonb("output").$type<unknown>(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheCreationInputTokens: integer("cache_creation_input_tokens").notNull().default(0),
    cacheReadInputTokens: integer("cache_read_input_tokens").notNull().default(0),
    costUsd: real("cost_usd").notNull().default(0),
    latencyMs: integer("latency_ms").notNull().default(0),
    purgedAt: ts("purged_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("extractions_msg_version_attempt_uq").on(t.messageId, t.pipelineVersion, t.attempt),
    index("extractions_mb_created").on(t.mailboxId, t.createdAt),
  ],
);

export const taskEvents = pgTable(
  "task_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Null for AI candidates that did not create a task (tier=logged) — kept for the recall audit. */
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "cascade" }),
    userId: uuid("user_id"),
    mailboxId: uuid("mailbox_id"),
    messageId: uuid("message_id"),
    threadId: uuid("thread_id"),
    extractionId: uuid("extraction_id"),
    opIndex: integer("op_index"),
    actor: text("actor", { enum: ACTORS }).notNull(),
    op: text("op").notNull(),
    before: jsonb("before").$type<Record<string, unknown> | null>(),
    after: jsonb("after").$type<Record<string, unknown> | null>(),
    /** Raw AI operation or user payload. */
    payload: jsonb("payload").$type<unknown>(),
    evidenceSource: text("evidence_source"),
    evidenceQuote: text("evidence_quote"),
    /** foldForMatch(evidenceQuote) — negative-example lookup ("not a task"). */
    evidenceNorm: text("evidence_norm"),
    features: jsonb("features").$type<Record<string, unknown>>(),
    tier: text("tier", { enum: TIERS }),
    applied: boolean("applied").notNull().default(false),
    suggestionState: text("suggestion_state", { enum: SUGGESTION_STATES }),
    reasons: text("reasons").array().notNull().default(sql`'{}'::text[]`),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("task_events_extraction_op_uq").on(t.extractionId, t.opIndex),
    index("task_events_task").on(t.taskId, t.createdAt),
    index("task_events_pending").on(t.userId).where(sql`${t.suggestionState} = 'pending'`),
    index("task_events_thread_neg").on(t.threadId, t.op),
  ],
);

/** Builder audit labels: what tasks a message *should* have produced (blind labelling). */
export const messageLabels = pgTable("message_labels", {
  id: uuid("id").primaryKey().defaultRandom(),
  messageId: uuid("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  labeledBy: uuid("labeled_by"),
  sampleWeek: text("sample_week"),
  stratum: text("stratum"),
  expected: jsonb("expected").$type<unknown>().notNull(),
  verdict: jsonb("verdict").$type<unknown>(),
  notes: text("notes"),
  createdAt: createdAt(),
});

export const companyDomains = pgTable(
  "company_domains",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    domain: text("domain").notNull(),
    company: text("company").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("company_domains_uq").on(t.orgId, t.domain)],
);

export const digests = pgTable(
  "digests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id),
    localDate: date("local_date", { mode: "string" }).notNull(),
    status: text("status", { enum: ["pending", "rendered", "delivered", "failed", "skipped"] }).notNull().default("pending"),
    deliveredVia: text("delivered_via", { enum: ["append", "smtp"] }),
    messageIdHeader: text("message_id_header"),
    appendUid: bigint("append_uid", { mode: "number" }),
    subject: text("subject"),
    html: text("html"),
    text: text("text"),
    /** When the content was built (the "New since yesterday" watermark for the next report). */
    renderedAt: ts("rendered_at"),
    /** Section → task ids shown (for audit / feedback). */
    sections: jsonb("sections").$type<Record<string, string[]>>(),
    late: boolean("late").notNull().default(false),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    deliveredAt: ts("delivered_at"),
    purgedAt: ts("purged_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("digests_user_date_uq").on(t.userId, t.localDate)],
);

/** Single-use nonces for one-click action links. */
export const actionNonces = pgTable("action_nonces", {
  nonce: text("nonce").primaryKey(),
  userId: uuid("user_id").notNull(),
  taskId: uuid("task_id").notNull(),
  action: text("action").notNull(),
  digestId: uuid("digest_id"),
  expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"),
  createdAt: createdAt(),
});

export const sessions = pgTable("sessions", {
  /** sha256(token) */
  id: text("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  mfaVerified: boolean("mfa_verified").notNull().default(false),
  csrfToken: text("csrf_token").notNull(),
  expiresAt: ts("expires_at").notNull(),
  lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
  createdAt: createdAt(),
});

export const trustedDevices = pgTable("trusted_devices", {
  /** sha256(token) */
  id: text("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: ts("expires_at").notNull(),
  createdAt: createdAt(),
});

/** Append-only security log. Never contains message content. */
export const securityAudit = pgTable(
  "security_audit",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: uuid("org_id"),
    userId: uuid("user_id"),
    event: text("event").notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>(),
    ip: text("ip"),
    createdAt: createdAt(),
  },
  (t) => [index("security_audit_created").on(t.createdAt)],
);

/** Health-check state for alert de-duplication. */
export const healthState = pgTable("health_state", {
  key: text("key").primaryKey(),
  status: text("status", { enum: ["ok", "alerting"] }).notNull().default("ok"),
  since: ts("since").notNull().defaultNow(),
  lastAlertAt: ts("last_alert_at"),
  detail: jsonb("detail").$type<Record<string, unknown>>(),
});

/** Small key-value store for global switches (e.g. global AI pause). */
export const appState = pgTable("app_state", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<unknown>().notNull(),
  updatedAt: updatedAt(),
});

/**
 * AI provider keys and model lists, one row per provider (src/ai/providers.ts). A key typed in Admin → AI is
 * sealed with the credentials public key (aad "ai-key:<provider>"): the API stores it but cannot open it; only the
 * worker can. `env_last4` and an environment key's models are reported by the worker: the API never sees its
 * environment (compose blanks the keys for the API).
 */
export const aiProviders = pgTable("ai_providers", {
  provider: text("provider", { enum: AI_PROVIDERS }).primaryKey(),
  keySealed: text("key_sealed"),
  keyLast4: text("key_last4"),
  /** No foreign key, like security_audit: deleting that account keeps the key. */
  keySetBy: uuid("key_set_by"),
  keySetAt: ts("key_set_at"),
  /** Last four characters of the key in the worker's environment (it wins over the stored one); null: none. */
  envLast4: text("env_last4"),
  /** Text models the key listed, newest first: on save, or by the worker for an environment key. */
  models: jsonb("models").$type<AiModelOption[]>().notNull().default([]),
  modelsListedAt: ts("models_listed_at"),
  /** The key the list came from ("stored:<last4>" or "env:<last4>"), so a new key gets a new list. */
  modelsFrom: text("models_from"),
  updatedAt: updatedAt(),
});

/** What the worker last ran with (written on change, plus a heartbeat). */
export interface AiWorkerReport {
  mode: "provider" | "mock" | "unavailable";
  provider: AiProvider | null;
  model: string | null;
  source: "env" | "stored" | null;
  reason: string | null;
}

/** The installation's AI choice (one row, id "global") and the worker's report. */
export const aiSettings = pgTable("ai_settings", {
  id: text("id").primaryKey().default("global"),
  /** anthropic | openai | gemini | xai | mock; null: never chosen (Claude when ANTHROPIC_API_KEY is set). */
  provider: text("provider"),
  model: text("model"),
  /** Bumped by every change of the choice or of a stored key: the worker rebuilds its extractor when it moves. */
  version: integer("version").notNull().default(0),
  updatedBy: uuid("updated_by"),
  updatedAt: updatedAt(),
  workerReport: jsonb("worker_report").$type<AiWorkerReport>(),
  workerReportAt: ts("worker_report_at"),
});

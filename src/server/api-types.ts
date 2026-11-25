/**
 * CONTRACT — JSON API between the Fastify server (src/server) and the SPA (web/).
 * All endpoints are under /api, JSON in/out, session cookie auth, `x-csrf-token` header on mutations.
 * Errors: { error: string; code: "unauthorized" | "mfa_required" | "forbidden" | "not_found" | "conflict" | "invalid" | "rate_limited" | "internal" }
 */
import type { OpenStatus, Priority, SnoozeMode, TaskStatus } from "../domain/types.js";

export interface ApiError {
  error: string;
  code: "unauthorized" | "mfa_required" | "forbidden" | "not_found" | "conflict" | "invalid" | "rate_limited" | "internal";
}

// ── Auth ─────────────────────────────────────────────────────────────────────
// POST /api/auth/login            LoginRequest → LoginResponse
// POST /api/auth/totp/verify      TotpVerifyRequest → { ok: true }
// POST /api/auth/totp/enroll      → TotpEnrollStart          (session must be password-verified)
// POST /api/auth/totp/confirm     { code } → { ok: true }
// POST /api/auth/logout           → { ok: true }
// GET  /api/me                    → Me
// POST /api/auth/setup/check      { token } → SetupCheck             (one-time setup link, 404 when used/expired)
// POST /api/auth/setup            { token, password } → LoginResponse (sets the password; TOTP enrolment next)

export interface LoginRequest {
  email: string;
  password: string;
}
export interface LoginResponse {
  ok: true;
  /** Next step required before the app is usable. */
  next: "none" | "totp" | "totp_enroll";
  csrfToken: string;
}
export interface TotpVerifyRequest {
  code: string;
  rememberDevice: boolean;
}
export interface TotpEnrollStart {
  otpauthUri: string;
  secret: string;
}
export interface SetupCheck {
  name: string;
  email: string;
  expiresAt: string;
  minPassword: number;
}

export interface Me {
  id: string;
  name: string;
  email: string;
  role: "admin" | "member";
  mfaVerified: boolean;
  csrfToken: string;
  timezone: string;
  digestTime: string;
  digestDelivery: "append" | "smtp";
  digestEnabled: boolean;
  /** Platform administrator: sees #/admin (organizations and accounts; never content). */
  platformAdmin: boolean;
  /** "Ask your mail" is switched on for this installation (POST /api/chat). */
  chat: boolean;
}

// ── Tasks ────────────────────────────────────────────────────────────────────
// GET   /api/tasks?tab=&company=&q=&review=1&limit=&cursor=&mailbox=   → TaskListResponse
// GET   /api/tasks/:id                                         → TaskDetail
// POST  /api/tasks                                             CreateTaskRequest → { id, ref }
// PATCH /api/tasks/:id                                         EditTaskRequest → TaskDetail
// POST  /api/tasks/:id/actions                                 TaskActionRequest → TaskDetail
// POST  /api/tasks/merge                                       MergeRequest → TaskDetail (survivor)
// POST  /api/tasks/bulk                                        BulkActionRequest → { done: number; conflicts: string[] }
// POST  /api/suggestions/:eventId                              { decision: "accept" | "reject" } → TaskDetail
// GET   /api/companies?mailbox=                                → { companies: Array<{ name: string; open: number }> }
//
// `mailbox` (tasks, companies, today) is the per-mailbox view: the id of one of the user's own mailboxes, and the
// answer then holds only that mailbox's tasks. Left out: everything. Any other id: 404.

/** One of the user's own mailboxes, as the per-mailbox view names it. */
export interface OwnMailbox {
  id: string;
  address: string;
  displayName: string | null;
}

/** "earlier" = the one-time "Earlier" triage: open backfill tasks with no activity for > 7 days. */
export type TaskTab = "todo" | "waiting" | "all" | "others" | "review" | "closed" | "earlier";

/** Someone who wrote a message, as the UI shows them ("you" when isOwner). */
export interface PersonRef {
  name: string | null;
  address: string | null;
  isOwner: boolean;
  isInternal: boolean;
}

/**
 * The sentence a task (or a suggestion) was based on, attributed and dated: the UI's primary content
 * ("in their own words"). Plain text — render escaped.
 */
export interface EvidenceView {
  quote: string;
  /** NEW | FORWARDED | QUOTED | SUBJECT | ATTACHMENT_NAME | CALENDAR */
  source: string | null;
  /** Message the quote came from (to highlight it in the thread), if known. */
  messageId: string | null;
  author: PersonRef | null;
  /** ISO time of that message. */
  at: string | null;
}

export interface TaskListItem {
  id: string;
  ref: number;
  title: string;
  status: TaskStatus;
  priority: Priority;
  company: string | null;
  counterpartyName: string | null;
  counterpartyAddress: string | null;
  nextAction: string | null;
  dueDate: string | null;
  duePhrase: string | null;
  overdue: boolean;
  /** Calendar days since created. */
  daysOpen: number;
  /** Business days in the current waiting period (WAITING_*), else null. */
  businessDaysWaiting: number | null;
  expectReplyBy: string | null;
  snoozedUntil: string | null;
  snoozeMode: SnoozeMode | null;
  needsReview: boolean;
  pendingSuggestions: number;
  ownerKind: "ME" | "INTERNAL" | "EXTERNAL" | "UNKNOWN";
  origin: "ai" | "manual" | "backfill";
  lastActivityAt: string;
  version: number;
  /**
   * The sentence that best explains the task's current state: for WAITING_FOR_ME / WAITING_FOR_OTHER the latest
   * applied AI evidence that set that status (the promise / the question asked), otherwise the origin evidence
   * (first AI CREATE). Null for manual tasks without one.
   */
  evidence: EvidenceView | null;
  /** The origin request when it differs from `evidence` (e.g. the customer's ask behind my promise). */
  originEvidence: EvidenceView | null;
  /** Raw review reason codes (src/engine/reconcile-reasons.ts R), so the UI can ask the right question. */
  reviewCodes: string[];
  /** Colleague handling it (ownerKind INTERNAL): name or address. */
  ownerLabel: string | null;
  /** Latest linked message (who wrote last, when) — e.g. "you, Fri 18 Sep" for a waiting task. */
  lastMessage: { author: PersonRef; at: string; subject: string; direction: "INBOUND" | "OUTBOUND" } | null;
  /** The counterparty or company is on the user's "Important" list (src/domain/preferences.ts): shown first, with ★. */
  important: boolean;
  /** The mailbox the task belongs to (the one its mail arrived in); null for a task entered by hand without one. */
  mailboxId: string | null;
  /** "Suppliers" (src/domain/rules.ts, kind "supplier"): the supplier whose senders hold the counterparty; else null. */
  supplier: SupplierRef | null;
}

/** A supplier as a task names it: the rule's id (what `supplier=` takes) and the name the user gave it. */
export interface SupplierRef {
  id: string;
  name: string;
}

/** A supplier in use with its open tasks, within the per-mailbox view when there is one. */
export interface SupplierGroup extends SupplierRef {
  senders: string[];
  /** Open tasks of this supplier: the length of `items` unless there are more than the cap. */
  open: number;
  /** The open tasks: what is asked of the user first, then what they promised, then what they wait for. */
  items: TaskListItem[];
}

export interface SuppliersResponse {
  suppliers: SupplierGroup[];
}

/** PUT /api/rules/suppliers: suppliers to write. "add" joins senders to a supplier that exists; "replace" sets them. */
export interface SuppliersWriteRequest {
  suppliers: Array<{ name: string; senders: string[] }>;
  mode?: "add" | "replace";
}

export interface TaskListResponse {
  items: TaskListItem[];
  counts: Record<TaskTab, number>;
  nextCursor: string | null;
}

export interface TaskMessageExcerpt {
  messageId: string;
  role: string;
  direction: "INBOUND" | "OUTBOUND";
  date: string;
  fromName: string | null;
  fromAddress: string | null;
  subject: string;
  /** NEW segment text, truncated (plain text — render escaped). */
  excerpt: string;
  attachments: string[];
}

export interface TaskEventView {
  id: string;
  actor: "ai" | "user" | "system";
  op: string;
  createdAt: string;
  applied: boolean;
  tier: "auto" | "review" | "logged" | null;
  suggestionState: "pending" | "accepted" | "rejected" | "expired" | null;
  evidenceSource: string | null;
  evidenceQuote: string | null;
  reasons: string[];
  /** Human-readable summary of the change, e.g. "Status → Done". */
  summary: string;
  /** The message behind this event and who wrote it (null for user/system events). */
  messageId: string | null;
  author: PersonRef | null;
  messageAt: string | null;
}

export interface TaskDetail extends TaskListItem {
  summary: string | null;
  items: string[];
  ownerName: string | null;
  ownerAddress: string | null;
  reviewReasons: string[];
  lockedFields: string[];
  closedAt: string | null;
  closedBy: "ai" | "user" | "system" | null;
  createdAt: string;
  messages: TaskMessageExcerpt[];
  events: TaskEventView[];
  suggestions: TaskEventView[];
}

export interface CreateTaskRequest {
  title: string;
  status: OpenStatus;
  priority?: Priority;
  dueDate?: string | null;
  nextAction?: string | null;
  company?: string | null;
  counterpartyAddress?: string | null;
  counterpartyName?: string | null;
  summary?: string | null;
  fromMessageId?: string | null;
  /**
   * Which of the user's own mailboxes the task belongs to (404 for any other id). Left out or null: the mailbox of
   * `fromMessageId`, else the user's only mailbox, else none. A task from a message always belongs to that
   * message's mailbox.
   */
  mailboxId?: string | null;
}

export interface EditTaskRequest {
  version: number;
  title?: string;
  status?: OpenStatus;
  priority?: Priority;
  dueDate?: string | null;
  nextAction?: string | null;
  summary?: string | null;
  company?: string | null;
  counterpartyAddress?: string | null;
  counterpartyName?: string | null;
}

export type TaskAction =
  | { action: "complete" }
  | { action: "dismiss"; kind: "not_a_task" | "handled_by_other" | "other" }
  | { action: "reopen" }
  | { action: "snooze"; mode: SnoozeMode; until: string | null }
  | { action: "unsnooze" }
  | { action: "confirm" }
  | { action: "still_valid" }
  | { action: "would_have_missed" };

export type TaskActionRequest = TaskAction & { version?: number };

export interface MergeRequest {
  survivorId: string;
  mergedId: string;
}

export interface BulkActionRequest {
  ids: string[];
  action: TaskAction;
}

// ── Mailboxes (setup) ────────────────────────────────────────────────────────
// GET   /api/mailboxes                               → { mailboxes: MailboxSummary[] }
// POST  /api/mailboxes                               CreateMailboxRequest → MailboxSummary
// PATCH /api/mailboxes/:id                           UpdateMailboxRequest → MailboxSummary
// POST  /api/mailboxes/:id/credentials               { password } → ProbeSummary   (probe once, then seal & store if ok)
// GET   /api/mailboxes/:id/folders                   → { folders: FolderSummary[] }
// PATCH /api/mailboxes/:id/folders/:folderId         UpdateFolderRequest → FolderSummary
// POST  /api/mailboxes/:id/ingest-token              → { token: string }  (shown once)
// GET   /api/health                                  → HealthSummary

export interface MailboxSummary {
  id: string;
  address: string;
  displayName: string | null;
  provider: "imap" | "ingest";
  imapHost: string | null;
  imapPort: number;
  imapUsername: string | null;
  smtpHost: string | null;
  smtpPort: number | null;
  aliases: string[];
  status: "setup" | "active" | "auth_failed" | "blocked" | "paused" | "disabled";
  statusReason: string | null;
  hasCredentials: boolean;
  /**
   * The mailbox already holds messages. Its address and login name say whose mail that is, so from then on they
   * cannot be changed (the server and the port still can).
   */
  hasMail: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  aiPaused: boolean;
  aiPausedReason: string | null;
}

export interface CreateMailboxRequest {
  address: string;
  displayName?: string | null;
  provider?: "imap" | "ingest";
  imapHost?: string | null;
  imapPort?: number;
  imapUsername?: string | null;
  smtpHost?: string | null;
  smtpPort?: number | null;
  aliases?: string[];
}

export interface UpdateMailboxRequest {
  displayName?: string | null;
  aliases?: string[];
  status?: "active" | "paused";
  smtpHost?: string | null;
  smtpPort?: number | null;
  /**
   * Connection settings, to correct a mistake (owner only, never together with `status`). When one of them really
   * changes, the stored password is removed and the mailbox goes back to "setup": the password is entered again and
   * tried against the new settings, so it is never sent somewhere it was not checked against. `address` and
   * `imapUsername` (null = the address) change only while the mailbox holds no mail (409 otherwise, see `hasMail`).
   * A stored SMTP server follows a new IMAP server.
   */
  address?: string;
  imapHost?: string;
  imapPort?: number;
  imapUsername?: string | null;
}

export interface ProbeSummary {
  ok: boolean;
  error: string | null;
  errorKind: string | null;
  capabilities: string[];
  folders: FolderSummary[];
  quota: { usedKb: number; limitKb: number } | null;
}

export interface FolderSummary {
  id: string | null;
  path: string;
  name: string;
  role: "inbox" | "sent" | "archive" | "junk" | "trash" | "drafts" | "other";
  roleSource: "special_use" | "name" | "user";
  syncEnabled: boolean;
  private: boolean;
  messages: number | null;
  lastSyncedAt: string | null;
}

export interface UpdateFolderRequest {
  role?: FolderSummary["role"];
  syncEnabled?: boolean;
  private?: boolean;
}

export interface HealthSummary {
  lastSyncAt: string | null;
  staleMinutes: number | null;
  pendingCount: number;
  oldestPendingMinutes: number | null;
  failedCount: number;
  paused: boolean;
  banner: string | null;
  /** "Check now" is available (the worker runs as a scheduled job: POST /api/sync-now). */
  canSyncNow: boolean;
}

// POST /api/sync-now  {} → 202 SyncNowResponse | 404 (not available) | 429 (Retry-After) | 502 (did not start)
export interface SyncNowResponse {
  started: true;
}

// ── Chat ("Ask your mail") ───────────────────────────────────────────────────
// POST /api/chat  ChatRequest → 200 application/x-ndjson: one ChatEvent per line — "step"s, then one "answer" or "error"
//                 | 404 (the chat is off) | 429 (too fast, a question already running, or the day's limit; the
//                   message says which)
// The server keeps nothing of a conversation: the browser sends the earlier turns back with each question. The
// model only reads (the asking user's own mail and tasks) and never acts.

export interface ChatMailSource {
  kind: "mail";
  /** How the answer text names it: "[M3fa9c1]". */
  handle: string;
  messageId: string;
  date: string;
  fromName: string | null;
  fromAddress: string | null;
  /** Written by the user (a Sent copy, or a copy of their own mail in the inbox). */
  own: boolean;
  /**
   * It names the user or their organization as its sender, and the mail server's checks show that sender was not
   * authenticated: possibly forged, never to be shown as the user's own words.
   */
  unverified: boolean;
  subject: string;
  /** Start of the message's own text (plain text — render escaped). */
  excerpt: string;
  attachments: string[];
  /** A task made from this mail or its conversation (an open one first), if any. */
  task: { id: string; ref: number } | null;
}

export interface ChatTaskSource {
  kind: "task";
  /** "[#184]" in the answer text. */
  handle: string;
  taskId: string;
  ref: number;
  title: string;
  status: TaskStatus;
}

export type ChatSource = ChatMailSource | ChatTaskSource;

/** An earlier exchange of the conversation, sent back so that a follow-up question has its context. */
export interface ChatTurn {
  question: string;
  answer: string;
  draft: string | null;
  sources: Array<{ kind: "mail" | "task"; id: string }>;
}

export interface ChatRequest {
  question: string;
  /** Oldest first. The server uses the newest few. */
  history: ChatTurn[];
  /**
   * The per-mailbox view: ask about one of the user's own mailboxes only — its mail and the tasks made from it
   * (404 for any other id). Left out or null: all of the user's mailboxes.
   */
  mailboxId?: string | null;
}

export type ChatErrorCode = "ai_unavailable" | "no_answer" | "too_slow" | "internal";

export type ChatEvent =
  /** What is being looked up right now, in words for the user. */
  | { type: "step"; label: string }
  /** The answer (plain text with [handle] marks), an optional mail text the user asked for, and what the marks name. */
  | { type: "answer"; answer: string; draft: string | null; sources: ChatSource[] }
  | { type: "error"; code: ChatErrorCode; message: string };

// ── Parked messages ("Not analysed") ─────────────────────────────────────────
// GET  /api/problems                         → { parked: ParkedMessage[] }   (own mailboxes, not acknowledged)
// POST /api/problems/:messageId              { action: "retry" | "acknowledge" } → { ok: true }

export interface ParkedMessage {
  messageId: string;
  mailboxId: string;
  date: string;
  fromName: string | null;
  fromAddress: string | null;
  subject: string;
  /** Short error code, never content. */
  error: string | null;
  attempts: number;
}

// ── Today ────────────────────────────────────────────────────────────────────
// GET /api/today?mailbox= → TodayResponse  (the home screen: the product's three questions + what the AI needs from you)

export interface TriageItem {
  /** "suggestion": a pending AI suggestion on an existing task; "review": an AI-created task the AI was unsure about. */
  kind: "suggestion" | "review";
  task: TaskListItem;
  /** The pending suggestion (kind "suggestion"), with its evidence and author. */
  suggestion: TaskEventView | null;
}

export interface TodayResponse {
  /** Local date (org timezone), YYYY-MM-DD. */
  date: string;
  triage: TriageItem[];
  /** Someone asked me (ACTION_REQUIRED), not snoozed, owner me/unknown. Overdue → due today → dated → undated by priority. */
  doNow: TaskListItem[];
  /** My promises (WAITING_FOR_ME), not snoozed. Earliest due first. */
  promised: TaskListItem[];
  /** Waiting for others (WAITING_FOR_OTHER), not snoozed. Past expect-reply first, then longest waiting. */
  waiting: TaskListItem[];
  /** `suppliers`: the open tasks that have a supplier (the sum of `suppliers[].open`). */
  counts: { triage: number; doNow: number; promised: number; waiting: number; snoozed: number; others: number; earlier: number; suppliers: number };
  /** The suppliers in use (enabled supplier rules, in the list's order) with their open tasks counted; empty = no supplier rules. */
  suppliers: Array<SupplierRef & { open: number }>;
  /** The user's own mailboxes, oldest first — always all of them: what `mailbox` may name, and the names of `mailboxId`s. */
  mailboxes: OwnMailbox[];
}


// ── "What matters to me" ─────────────────────────────────────────────────────
// GET  /api/preferences                → Preferences
// PUT  /api/preferences                Preferences → Preferences        (whole object; lists normalized)
// POST /api/preferences/muted          { entry } → Preferences          (one-click "Ignore" after a dismissal)

export interface Preferences {
  /** Addresses, "@domain" or company names whose tasks come first. */
  important: string[];
  /** Addresses or "@domain" whose inbound mail never reaches the AI. */
  muted: string[];
  /** Tasks from mail where the user is only in Cc: ask (review), create normally, or ignore. */
  ccPolicy: "ask" | "create" | "ignore";
  /** What the user handles and what not, in their words; given to the AI as data (≤ 600 chars). */
  profile: string | null;
  /** Read-only: the organization's domains and the user's own addresses (these cannot be muted). */
  own: { internalDomains: string[]; addresses: string[] };
}

// ── Rules (src/domain/rules.ts) ─────────────────────────────────────────────
// GET   /api/rules                     → MailRulesView
// PATCH /api/rules/:id                 { enabled } → MailRulesView     (switch one rule on/off; the list comes from rules:import)

export interface MailRulesView {
  rules: import("../domain/rules.js").MailRule[];
  /** Stored rules that cannot be used (id, reason); the engine skips them. */
  skipped: Array<{ id: string; error: string }>;
}

// ── Platform admin (#/admin): organizations and accounts, never content ────
// GET   /api/admin/overview                  → AdminOverview
// POST  /api/admin/orgs                      AdminOrgCreate → AdminOrg
// PATCH /api/admin/orgs/:id                  AdminOrgUpdate → AdminOrg
// POST  /api/admin/users                     AdminUserCreate → AdminUserCreated   (with a one-time setup link)
// PATCH /api/admin/users/:id                 AdminUserUpdate → AdminUser
// POST  /api/admin/users/:id/setup-link      → AdminSetupLink                    (new password + TOTP on use)

export interface AdminOrg {
  id: string;
  name: string;
  internalDomains: string[];
  timezone: string;
  users: number;
  mailboxes: number;
  createdAt: string;
}

export interface AdminMailbox {
  id: string;
  address: string;
  status: "setup" | "active" | "auth_failed" | "blocked" | "paused" | "disabled";
  lastSyncAt: string | null;
}

export interface AdminUser {
  id: string;
  orgId: string;
  name: string;
  email: string;
  role: "admin" | "member";
  platformAdmin: boolean;
  /** invited = no password yet (waiting for the setup link); disabled = cannot log in. */
  state: "active" | "invited" | "disabled";
  mfa: boolean;
  /** An unused setup link is waiting until this time. */
  setupExpiresAt: string | null;
  digestEnabled: boolean;
  digestTime: string;
  mailboxes: AdminMailbox[];
  createdAt: string;
}

export interface AdminOverview {
  me: string;
  orgs: AdminOrg[];
  users: AdminUser[];
}

export interface AdminOrgCreate {
  name: string;
  domains: string[];
  timezone?: string;
}

export interface AdminOrgUpdate {
  name?: string;
  domains?: string[];
  timezone?: string;
}

export interface AdminUserCreate {
  orgId: string;
  name: string;
  email: string;
  role: "admin" | "member";
}

export interface AdminUserUpdate {
  /** Move to another organization: only before the account has a mailbox or tasks. */
  orgId?: string;
  name?: string;
  role?: "admin" | "member";
  platformAdmin?: boolean;
  disabled?: boolean;
  digestEnabled?: boolean;
  digestTime?: string;
}

export interface AdminSetupLink {
  url: string;
  expiresAt: string;
}

export interface AdminUserCreated {
  user: AdminUser;
  link: AdminSetupLink;
}

export interface AdminUserDeleted {
  deleted: { mailboxes: number; messages: number; tasks: number };
}

// ── Platform admin: AI provider, model and keys (installation-wide) ──────────
// GET    /api/admin/ai                       → AdminAi
// POST   /api/admin/ai/models                AdminAiModelsRequest → AdminAiModels   (lists with a pasted key; stores nothing)
// PUT    /api/admin/ai                       AdminAiSave → AdminAi                   (selection, and optionally a new key)
// DELETE /api/admin/ai/keys/:provider        → AdminAi                               (removes a key typed in the UI)
// A key is write-only: no response ever carries it or its sealed form, only its last four characters.
// Errors: 400 invalid ("<Provider> rejected this key." / unknown model / no key for that provider),
//         429 rate_limited, 502 internal ("Could not reach <Provider>").

export type AiProviderId = "anthropic" | "openai" | "gemini" | "xai";

export interface AiModelOptionView {
  id: string;
  label: string;
}

export type AdminAiKey =
  | { source: "stored"; last4: string; setAt: string; setBy: string | null }
  /** In the worker's environment (e.g. OPENAI_API_KEY): it wins over a stored key and the UI cannot change it. */
  | { source: "env"; last4: string | null };

export interface AdminAiProvider {
  id: AiProviderId;
  label: string;
  /** Where to create a key. */
  keyUrl: string;
  key: AdminAiKey | null;
  /** Text models the key listed (when saved, or by the worker for an environment key), newest first. */
  models: AiModelOptionView[];
  modelsListedAt: string | null;
}

/** What the worker last reported running with (it alone opens keys and sees its environment). */
export interface AdminAiWorker {
  mode: "provider" | "mock" | "unavailable";
  provider: AiProviderId | null;
  model: string | null;
  source: "env" | "stored" | null;
  /**
   * mode "mock": why: "ai_mode_mock" (AI_MODE=mock), "off" (Off in Admin), "no_key" (nothing chosen, no key).
   * mode "unavailable" (the chosen provider cannot run; AI pauses at the next message): "no_key", "key_unreadable"
   * (the worker cannot decrypt the saved key), "no_model".
   */
  reason: string | null;
  at: string;
}

export interface AdminAi {
  /** null until a platform admin saves a choice; "mock" = the free mock, no AI. */
  selection: { provider: AiProviderId | "mock"; model: string | null; updatedAt: string } | null;
  providers: AdminAiProvider[];
  /** null: no worker has reported yet. */
  worker: AdminAiWorker | null;
  /** The global AI pause (an API key, billing or code error stopped AI for every mailbox). */
  paused: { reason: string; since: string } | null;
  /** Per-mailbox daily limits (AI_DAILY_CALL_CAP / AI_DAILY_USD_CAP; a mailbox may override them). */
  caps: { dailyCalls: number; dailyUsd: number };
}

export interface AdminAiModelsRequest {
  provider: AiProviderId;
  apiKey: string;
}

export interface AdminAiModels {
  models: AiModelOptionView[];
}

export interface AdminAiSave {
  provider: AiProviderId | "mock";
  /** Required for a provider; ignored for "mock". */
  model?: string | null;
  /** A new key for `provider` (validated by listing its models, then sealed). Omit to keep the stored one. */
  apiKey?: string;
}

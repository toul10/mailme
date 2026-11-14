/**
 * Typed client for the JSON API (src/server/api-types.ts).
 * - same-origin cookies; JSON in/out; `x-csrf-token` on every mutation (token from LoginResponse / Me);
 * - auth failures are decided on the error `code`, not the HTTP status, and reported through
 *   `onAuthError` (except for /api/auth/* calls, whose errors belong to the login/TOTP forms);
 * - `fetch` and `storage` are injected, so nothing here touches `window` at import time.
 */
import type {
  ApiError,
  BulkActionRequest,
  CreateMailboxRequest,
  CreateTaskRequest,
  EditTaskRequest,
  FolderSummary,
  HealthSummary,
  SyncNowResponse,
  LoginRequest,
  LoginResponse,
  MailboxSummary,
  Me,
  MergeRequest,
  AdminOrg,
  AdminOrgCreate,
  AdminOrgUpdate,
  AdminOverview,
  AdminSetupLink,
  AdminUser,
  AdminUserCreate,
  AdminUserCreated,
  AdminUserDeleted,
  AdminUserUpdate,
  ParkedMessage,
  SetupCheck,
  MailRulesView,
  Preferences,
  ProbeSummary,
  TaskActionRequest,
  TaskDetail,
  TaskListResponse,
  TaskTab,
  TodayResponse,
  TotpEnrollStart,
  TotpVerifyRequest,
  UpdateFolderRequest,
  UpdateMailboxRequest,
} from "../../src/server/api-types.js";

export type ApiErrorCode = ApiError["code"] | "network" | "http";

const KNOWN_CODES: ReadonlySet<string> = new Set(["unauthorized", "mfa_required", "forbidden", "not_found", "conflict", "invalid", "rate_limited", "internal"]);

export class ApiRequestError extends Error {
  /** True once the global auth handler has taken care of it (the UI should not show it again). */
  handled = false;

  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    /** Server-provided message, if any. */
    readonly serverMessage: string | null,
  ) {
    super(serverMessage ?? code);
    this.name = "ApiRequestError";
  }
}

export function isApiError(err: unknown): err is ApiRequestError {
  return err instanceof ApiRequestError;
}

export function isConflict(err: unknown): boolean {
  return isApiError(err) && err.code === "conflict";
}

/** User-facing message for any error thrown by the client (or anything else). */
export function errorMessage(err: unknown): string {
  if (!isApiError(err)) return "Something went wrong. Try again.";
  switch (err.code) {
    case "network":
      return "No connection to the server.";
    case "unauthorized":
      return "Your session has expired. Sign in again.";
    case "mfa_required":
      return "A verification code is required.";
    case "forbidden":
      return "You don't have access to this.";
    case "not_found":
      return "Not found.";
    case "conflict":
      return "Something changed in the meantime. Refresh and try again.";
    case "rate_limited":
      return "Too many attempts. Try again in a moment.";
    case "invalid":
      return err.serverMessage ? `Invalid input: ${err.serverMessage}` : "Invalid input.";
    case "internal":
    case "http":
      return `Server error (${err.status}).`;
  }
}

/** Minimal Storage subset (sessionStorage in the browser, a Map in tests). */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type AuthErrorKind = "unauthorized" | "mfa_required";

export interface ApiClientOptions {
  fetch?: typeof fetch;
  /** Prefix for every path (default ""). */
  baseUrl?: string;
  /** Where the CSRF token survives a page reload (the MFA step has no /api/me to re-read it). */
  storage?: KeyValueStore | null;
  onAuthError?: (kind: AuthErrorKind) => void;
  /** After every successful mutation outside /api/auth/* (the shell refreshes its counts). */
  onMutated?: () => void;
}

export interface TaskListQuery {
  tab: TaskTab;
  company?: string | null;
  q?: string | null;
  review?: boolean;
  limit?: number;
  cursor?: string | null;
}

export const CSRF_STORAGE_KEY = "mailme.csrf";
const MUTATIONS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

/** Query string for GET /api/tasks (empty values omitted). */
export function taskListQueryString(q: TaskListQuery): string {
  const p = new URLSearchParams();
  p.set("tab", q.tab);
  if (q.company) p.set("company", q.company);
  const text = q.q?.trim();
  if (text) p.set("q", text);
  if (q.review) p.set("review", "1");
  if (q.limit !== undefined) p.set("limit", String(q.limit));
  if (q.cursor) p.set("cursor", q.cursor);
  return p.toString();
}

const enc = encodeURIComponent;

export class ApiClient {
  private csrf: string | null = null;
  private readonly fetchFn: typeof fetch;
  private readonly baseUrl: string;
  private readonly storage: KeyValueStore | null;
  onAuthError: ((kind: AuthErrorKind) => void) | null;
  onMutated: (() => void) | null;

  constructor(opts: ApiClientOptions = {}) {
    const f = opts.fetch ?? globalThis.fetch;
    // Bind so the browser's fetch is not called with the client as `this`.
    this.fetchFn = f.bind(globalThis);
    this.baseUrl = opts.baseUrl ?? "";
    this.storage = opts.storage ?? null;
    this.onAuthError = opts.onAuthError ?? null;
    this.onMutated = opts.onMutated ?? null;
    try {
      this.csrf = this.storage?.getItem(CSRF_STORAGE_KEY) ?? null;
    } catch {
      this.csrf = null;
    }
  }

  get csrfToken(): string | null {
    return this.csrf;
  }

  setCsrfToken(token: string | null): void {
    this.csrf = token;
    try {
      if (token) this.storage?.setItem(CSRF_STORAGE_KEY, token);
      else this.storage?.removeItem(CSRF_STORAGE_KEY);
    } catch {
      // Storage may be unavailable (private mode); the in-memory token still works.
    }
  }

  /** Low-level request. Mutations always carry a JSON body (`{}` when there is no payload). */
  async request<T>(method: Method, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    const mutation = MUTATIONS.has(method);
    let payload: string | undefined;
    if (mutation) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body ?? {});
      if (this.csrf) headers["x-csrf-token"] = this.csrf;
    }
    let res: Response;
    try {
      res = await this.fetchFn(this.baseUrl + path, { method, headers, body: payload, credentials: "same-origin", cache: "no-store" });
    } catch {
      throw new ApiRequestError(0, "network", null);
    }
    const data = await readJson(res);
    if (res.ok) {
      if (mutation && !path.startsWith("/api/auth/")) this.onMutated?.();
      return data as T;
    }

    const err = toError(res.status, data);
    const isAuthCall = path.startsWith("/api/auth/");
    if (!isAuthCall && (err.code === "unauthorized" || err.code === "mfa_required")) {
      if (err.code === "unauthorized") this.setCsrfToken(null);
      if (this.onAuthError) {
        err.handled = true;
        this.onAuthError(err.code);
      }
    }
    throw err;
  }

  // ── Auth ──────────────────────────────────────────────────────────────────
  async login(req: LoginRequest): Promise<LoginResponse> {
    const res = await this.request<LoginResponse>("POST", "/api/auth/login", req);
    this.setCsrfToken(res.csrfToken);
    return res;
  }

  /** One-time setup link: who it is for (404 when used or expired). */
  setupCheck(token: string): Promise<SetupCheck> {
    return this.request("POST", "/api/auth/setup/check", { token });
  }

  /** One-time setup link: set the password; the session that comes back continues with TOTP enrolment. */
  async setup(token: string, password: string): Promise<LoginResponse> {
    const res = await this.request<LoginResponse>("POST", "/api/auth/setup", { token, password });
    this.setCsrfToken(res.csrfToken);
    return res;
  }

  verifyTotp(req: TotpVerifyRequest): Promise<{ ok: true }> {
    return this.request("POST", "/api/auth/totp/verify", req);
  }

  startTotpEnroll(): Promise<TotpEnrollStart> {
    return this.request("POST", "/api/auth/totp/enroll");
  }

  confirmTotp(code: string): Promise<{ ok: true }> {
    return this.request("POST", "/api/auth/totp/confirm", { code });
  }

  async logout(): Promise<void> {
    try {
      await this.request<{ ok: true }>("POST", "/api/auth/logout");
    } finally {
      this.setCsrfToken(null);
    }
  }

  async me(): Promise<Me> {
    const me = await this.request<Me>("GET", "/api/me");
    this.setCsrfToken(me.csrfToken);
    return me;
  }

  // ── Tasks ─────────────────────────────────────────────────────────────────
  listTasks(query: TaskListQuery): Promise<TaskListResponse> {
    return this.request("GET", `/api/tasks?${taskListQueryString(query)}`);
  }

  getTask(id: string): Promise<TaskDetail> {
    return this.request("GET", `/api/tasks/${enc(id)}`);
  }

  createTask(req: CreateTaskRequest): Promise<{ id: string; ref: number }> {
    return this.request("POST", "/api/tasks", req);
  }

  editTask(id: string, req: EditTaskRequest): Promise<TaskDetail> {
    return this.request("PATCH", `/api/tasks/${enc(id)}`, req);
  }

  taskAction(id: string, req: TaskActionRequest): Promise<TaskDetail> {
    return this.request("POST", `/api/tasks/${enc(id)}/actions`, req);
  }

  mergeTasks(req: MergeRequest): Promise<TaskDetail> {
    return this.request("POST", "/api/tasks/merge", req);
  }

  bulkAction(req: BulkActionRequest): Promise<{ done: number; conflicts: string[] }> {
    return this.request("POST", "/api/tasks/bulk", req);
  }

  resolveSuggestion(eventId: string, decision: "accept" | "reject"): Promise<TaskDetail> {
    return this.request("POST", `/api/suggestions/${enc(eventId)}`, { decision });
  }

  companies(): Promise<{ companies: Array<{ name: string; open: number }> }> {
    return this.request("GET", "/api/companies");
  }

  // ── Mailboxes & health ────────────────────────────────────────────────────
  listMailboxes(): Promise<{ mailboxes: MailboxSummary[] }> {
    return this.request("GET", "/api/mailboxes");
  }

  createMailbox(req: CreateMailboxRequest): Promise<MailboxSummary> {
    return this.request("POST", "/api/mailboxes", req);
  }

  updateMailbox(id: string, req: UpdateMailboxRequest): Promise<MailboxSummary> {
    return this.request("PATCH", `/api/mailboxes/${enc(id)}`, req);
  }

  /** Probes once; the server seals and stores the password only if the probe succeeds. */
  setMailboxPassword(id: string, password: string): Promise<ProbeSummary> {
    return this.request("POST", `/api/mailboxes/${enc(id)}/credentials`, { password });
  }

  listFolders(id: string): Promise<{ folders: FolderSummary[] }> {
    return this.request("GET", `/api/mailboxes/${enc(id)}/folders`);
  }

  updateFolder(id: string, folderId: string, req: UpdateFolderRequest): Promise<FolderSummary> {
    return this.request("PATCH", `/api/mailboxes/${enc(id)}/folders/${enc(folderId)}`, req);
  }

  issueIngestToken(id: string): Promise<{ token: string }> {
    return this.request("POST", `/api/mailboxes/${enc(id)}/ingest-token`);
  }

  today(): Promise<TodayResponse> {
    return this.request("GET", "/api/today");
  }

  // ── Platform admin ─────────────────────────────────────────────────────────
  adminOverview(): Promise<AdminOverview> {
    return this.request("GET", "/api/admin/overview");
  }

  adminCreateOrg(body: AdminOrgCreate): Promise<AdminOrg> {
    return this.request("POST", "/api/admin/orgs", body);
  }

  adminUpdateOrg(id: string, body: AdminOrgUpdate): Promise<AdminOrg> {
    return this.request("PATCH", `/api/admin/orgs/${enc(id)}`, body);
  }

  adminCreateUser(body: AdminUserCreate): Promise<AdminUserCreated> {
    return this.request("POST", "/api/admin/users", body);
  }

  adminUpdateUser(id: string, body: AdminUserUpdate): Promise<AdminUser> {
    return this.request("PATCH", `/api/admin/users/${enc(id)}`, body);
  }

  adminSetupLink(id: string): Promise<AdminSetupLink> {
    return this.request("POST", `/api/admin/users/${enc(id)}/setup-link`);
  }

  adminDeleteUser(id: string, confirmEmail: string): Promise<AdminUserDeleted> {
    return this.request("DELETE", `/api/admin/users/${enc(id)}`, { confirmEmail });
  }

  adminDeleteOrg(id: string): Promise<{ ok: true }> {
    return this.request("DELETE", `/api/admin/orgs/${enc(id)}`);
  }

  // ── “What matters to me” ──────────────────────────────────────────────────────
  preferences(): Promise<Preferences> {
    return this.request("GET", "/api/preferences");
  }

  savePreferences(p: Omit<Preferences, "own">): Promise<Preferences> {
    return this.request("PUT", "/api/preferences", p);
  }

  muteSender(entry: string): Promise<Preferences> {
    return this.request("POST", "/api/preferences/muted", { entry });
  }

  // ── “Rules” (src/domain/rules.ts) ──────────────────────────────────────────────
  rules(): Promise<MailRulesView> {
    return this.request("GET", "/api/rules");
  }

  setRuleEnabled(id: string, enabled: boolean): Promise<MailRulesView> {
    return this.request("PATCH", `/api/rules/${enc(id)}`, { enabled });
  }

  health(): Promise<HealthSummary> {
    return this.request("GET", "/api/health");
  }

  /** “Check now”: start a worker pass now (only where health.canSyncNow). 429 within a minute of the last one. */
  syncNow(): Promise<SyncNowResponse> {
    return this.request("POST", "/api/sync-now");
  }

  // ── Parked messages (“Not analysed”) ─────────────────────────────────────
  listProblems(): Promise<{ parked: ParkedMessage[] }> {
    return this.request("GET", "/api/problems");
  }

  /** retry = back to the analysis queue; acknowledge = “Got it” (no longer reported). */
  problemAction(messageId: string, action: "retry" | "acknowledge"): Promise<{ ok: true }> {
    return this.request("POST", `/api/problems/${enc(messageId)}`, { action });
  }
}

async function readJson(res: Response): Promise<unknown> {
  if (res.status === 204) return undefined;
  const text = await res.text().catch(() => "");
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function toError(status: number, data: unknown): ApiRequestError {
  const body = data && typeof data === "object" ? (data as Partial<Record<keyof ApiError, unknown>>) : {};
  const message = typeof body.error === "string" && body.error ? body.error : null;
  if (typeof body.code === "string" && KNOWN_CODES.has(body.code)) {
    return new ApiRequestError(status, body.code as ApiError["code"], message);
  }
  // No (known) code: infer from the status so a bare 401/409 still behaves.
  const byStatus: Partial<Record<number, ApiError["code"]>> = {
    400: "invalid",
    401: "unauthorized",
    403: "forbidden",
    404: "not_found",
    409: "conflict",
    422: "invalid",
    429: "rate_limited",
  };
  return new ApiRequestError(status, byStatus[status] ?? "http", message);
}

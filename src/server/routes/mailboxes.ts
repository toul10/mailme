import { and, asc, eq, inArray, isNotNull, isNull, lte, ne, notInArray, or, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { DateTime } from "luxon";
import type { Db, DbOrTx } from "../../db/client.js";
import { mailboxFolders, mailboxLoginAttempts, mailboxes, users } from "../../db/schema.js";
import type { FolderRole, MailboxConnectionSettings } from "../../domain/types.js";
import { sealMailboxPassword } from "../../lib/credentials.js";
import { randomToken } from "../../lib/crypto.js";
import { normalizeAddress } from "../../lib/text.js";
import { classifyFolder, initialSyncEnabled, isVirtualFolder } from "../../mail/imap/folders.js";
import type { ProbeResult } from "../../mail/imap/probe.js";
import type { FolderSummary, MailboxSummary, ProbeSummary } from "../api-types.js";
import { audit, type AuditEvent } from "../audit.js";
import { authOf, rateLimit, requireAuth } from "../auth/guard.js";
import type { AuthContext } from "../auth/sessions.js";
import type { AppContext } from "../context.js";
import { checkPublicHost, hostSyntaxProblem } from "../host-policy.js";
import { badRequest, conflict, forbidden, notFound, parseWith, rateLimited, uuidParam } from "../http.js";
import { hostLoginBudget } from "../login-budget.js";
import { sha256Hex } from "../secrets.js";
import { CreateMailboxBody, CredentialsBody, UpdateFolderBody, UpdateMailboxBody, type UpdateMailboxInput } from "../validation.js";

type MailboxRow = typeof mailboxes.$inferSelect;
type FolderRow = typeof mailboxFolders.$inferSelect;

export function toMailboxSummary(m: MailboxRow, hasMail: boolean): MailboxSummary {
  const summary: MailboxSummary = {
    id: m.id,
    address: m.address,
    displayName: m.displayName,
    provider: m.provider,
    imapHost: m.imapHost,
    imapPort: m.imapPort,
    imapUsername: m.imapUsername,
    smtpHost: m.smtpHost,
    smtpPort: m.smtpPort,
    aliases: m.aliases,
    status: m.status,
    statusReason: m.statusReason,
    hasCredentials: m.credentialsSealed !== null,
    hasMail,
    lastSyncAt: m.lastSyncAt ? m.lastSyncAt.toISOString() : null,
    lastError: m.lastError,
    aiPaused: m.aiPaused,
    aiPausedReason: m.aiPausedReason,
  };
  return summary;
}

/** Which of these mailboxes already hold messages (their address and login name are fixed from then on). */
async function mailboxesWithMail(db: DbOrTx, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: mailboxes.id })
    .from(mailboxes)
    .where(and(inArray(mailboxes.id, [...ids]), sql`exists (select 1 from messages msg where msg.mailbox_id = ${mailboxes.id})`));
  return new Set(rows.map((r) => r.id));
}

const ROLE_ORDER: FolderRole[] = ["inbox", "sent", "archive", "other", "junk", "trash", "drafts"];

function folderCounts(m: MailboxRow): Record<string, number> {
  const raw = m.probe?.["folderCounts"];
  return raw && typeof raw === "object" ? (raw as Record<string, number>) : {};
}

export function toFolderSummary(f: FolderRow, counts: Record<string, number>): FolderSummary {
  const summary: FolderSummary = {
    id: f.id,
    path: f.path,
    name: f.name,
    role: f.role,
    roleSource: f.roleSource,
    syncEnabled: f.syncEnabled,
    private: f.private,
    messages: typeof counts[f.path] === "number" ? counts[f.path]! : null,
    lastSyncedAt: f.lastSyncedAt ? f.lastSyncedAt.toISOString() : null,
  };
  return summary;
}

async function listFolders(db: Db, m: MailboxRow): Promise<FolderSummary[]> {
  const rows = await db
    .select()
    .from(mailboxFolders)
    .where(and(eq(mailboxFolders.mailboxId, m.id), isNull(mailboxFolders.goneAt)))
    .orderBy(asc(mailboxFolders.path));
  const counts = folderCounts(m);
  return rows
    .sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || a.path.localeCompare(b.path))
    .map((f) => toFolderSummary(f, counts));
}

/** mailbox_login_attempts.outcome for a probe error kind (src/mail/imap/errors.ts kinds). */
function attemptOutcome(r: ProbeResult): (typeof mailboxLoginAttempts.$inferInsert)["outcome"] {
  if (r.ok) return "ok";
  switch (r.errorKind) {
    case "auth":
      return "auth_failed";
    case "network":
    case "tls":
    case "too_many":
    case "protocol":
      return r.errorKind;
    default:
      return "other";
  }
}

/** Never echo the password back, even if a server error message quoted it. */
function scrub(text: string | null, password: string): string | null {
  if (text === null) return null;
  return password ? text.split(password).join("***") : text;
}

const refusedProbe = (errorKind: string, error: string): ProbeResult => ({ ok: false, errorKind, error, capabilities: [], delimiter: null, folders: [], quota: null });

/** A folder row that is a server-side view over other folders (`\All`, `\Flagged`). */
function isVirtualRow(f: Pick<FolderRow, "path" | "name" | "delimiter" | "specialUse">): boolean {
  return isVirtualFolder({ path: f.path, name: f.name, delimiter: f.delimiter, flags: [], specialUse: f.specialUse });
}

/**
 * Upsert the probed folder list. Roles come from classifyFolder, except folders whose role the user set.
 * sync_enabled / private are user choices and only get defaults on insert — the same initial decision as the
 * sync-side LIST (initialSyncEnabled): virtual views (`\All`, `\Flagged`) are never synced, since they would bring in
 * the messages of private, Trash and Drafts folders. An existing virtual row is switched off as well.
 */
async function upsertProbedFolders(db: DbOrTx, mailboxId: string, probe: ProbeResult, now: Date): Promise<void> {
  for (const f of probe.folders) {
    const listed = { path: f.path, name: f.name, delimiter: f.delimiter, flags: f.flags, specialUse: f.specialUse };
    const { role, source } = classifyFolder(listed);
    const virtual = isVirtualFolder(listed);
    await db
      .insert(mailboxFolders)
      .values({
        mailboxId,
        path: f.path,
        name: f.name,
        delimiter: f.delimiter,
        role,
        specialUse: f.specialUse,
        roleSource: source,
        syncEnabled: initialSyncEnabled(listed, role),
      })
      .onConflictDoUpdate({
        target: [mailboxFolders.mailboxId, mailboxFolders.path],
        set: {
          name: sql`excluded.name`,
          delimiter: sql`excluded.delimiter`,
          specialUse: sql`excluded.special_use`,
          role: sql`case when ${mailboxFolders.roleSource} = 'user' then ${mailboxFolders.role} else excluded.role end`,
          roleSource: sql`case when ${mailboxFolders.roleSource} = 'user' then ${mailboxFolders.roleSource} else excluded.role_source end`,
          goneAt: null,
          ...(virtual ? { syncEnabled: false } : {}),
        },
      });
  }
  if (probe.folders.length > 0) {
    await db
      .update(mailboxFolders)
      .set({ goneAt: now })
      .where(
        and(
          eq(mailboxFolders.mailboxId, mailboxId),
          isNull(mailboxFolders.goneAt),
          notInArray(
            mailboxFolders.path,
            probe.folders.map((f) => f.path),
          ),
        ),
      );
  }
}

/** Submission ports only (implicit TLS / STARTTLS); the worker refuses unencrypted SMTP anyway. */
const SMTP_PORTS = new Set([465, 587]);

const sameHost = (a: string | null | undefined, b: string | null | undefined) => (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

/**
 * The worker logs in to the SMTP host with the mailbox's own password (digest delivery "smtp"). A password is only
 * ever verified against the IMAP host (credentials probe), and the seal is not bound to a host, so the SMTP host may
 * only be the IMAP host itself (or empty = the IMAP host): repointing it elsewhere would hand the password to that
 * host. The rule applies to values that change, so rows set up through the CLI keep working — except in a request
 * that moves the IMAP host itself (`hostMoved`): the next password is checked against the new host, so nothing but
 * that host is accepted then.
 */
function smtpProblem(imapHost: string | null, smtpHost: string | null | undefined, smtpPort: number | null | undefined, cur?: MailboxRow, hostMoved = false): string | null {
  if (smtpHost !== undefined && smtpHost !== null && !(cur && !hostMoved && sameHost(smtpHost, cur.smtpHost)) && !sameHost(smtpHost, imapHost)) {
    return imapHost ? `The SMTP server must be the same as the IMAP server (${imapHost})` : "An SMTP server can't be set without an IMAP server";
  }
  if (smtpPort !== undefined && smtpPort !== null && smtpPort !== cur?.smtpPort && !SMTP_PORTS.has(smtpPort)) {
    return "The SMTP port must be 587 (STARTTLS) or 465 (TLS)";
  }
  return null;
}

interface ConnectionChange {
  address?: string;
  imapHost?: string;
  imapPort?: number;
  imapUsername?: string;
}

/**
 * The connection settings a request really changes (null = none): which account (address, login name) on which
 * server (host, port). The login name defaults to the address, and follows it for as long as it is that default —
 * so correcting a mistyped address corrects the login with it.
 */
function connectionChange(m: MailboxRow, body: Pick<UpdateMailboxInput, "address" | "imapHost" | "imapPort" | "imapUsername">): ConnectionChange | null {
  const imap = m.provider === "imap";
  if (!imap && (body.imapHost !== undefined || body.imapPort !== undefined || body.imapUsername !== undefined)) throw badRequest("This is not an IMAP mailbox");
  const address = body.address === undefined ? m.address : normalizeAddress(body.address);
  if (!address) throw badRequest("Invalid email address");
  const change: ConnectionChange = {};
  if (address !== m.address) change.address = address;
  if (imap) {
    if (body.imapHost !== undefined && !sameHost(body.imapHost, m.imapHost)) {
      const problem = hostSyntaxProblem(body.imapHost);
      if (problem) throw badRequest(problem);
      change.imapHost = body.imapHost;
    }
    if (body.imapPort !== undefined && body.imapPort !== m.imapPort) change.imapPort = body.imapPort;
    const current = m.imapUsername ?? m.address;
    const login = body.imapUsername !== undefined ? (body.imapUsername ?? address) : current === m.address ? address : current;
    if (login !== current) change.imapUsername = login;
  }
  return Object.keys(change).length > 0 ? change : null;
}

/**
 * The row still has the connection settings `m` was read with. A password is stored only for the settings it was
 * tried against: an edit that lands while a login is being tried must not end up with that password (PATCH drops
 * the stored one in the same statement that changes them).
 */
const sameConnection = (m: MailboxRow) =>
  and(
    eq(mailboxes.id, m.id),
    eq(mailboxes.address, m.address),
    eq(mailboxes.imapPort, m.imapPort),
    sql`${mailboxes.imapHost} is not distinct from ${m.imapHost}`,
    sql`${mailboxes.imapUsername} is not distinct from ${m.imapUsername}`,
  );

/**
 * Couple the shadow-week default with the report start (“Week 1, shadow: no report”): a user's first
 * mailbox created with a future go-live sets users.digest_start_date to the local date of live_since (same rule as
 * the CLI's mailbox:add), if not set yet. Skipped when the user already has a live mailbox — a second mailbox must
 * not silence reports that are already running.
 */
async function coupleDigestStart(tx: DbOrTx, auth: AuthContext, m: MailboxRow, now: Date): Promise<void> {
  if (!m.liveSince || m.liveSince <= now) return;
  const [live] = await tx
    .select({ id: mailboxes.id })
    .from(mailboxes)
    .where(and(eq(mailboxes.userId, auth.userId), ne(mailboxes.id, m.id), ne(mailboxes.status, "disabled"), or(isNull(mailboxes.liveSince), lte(mailboxes.liveSince, now))))
    .limit(1);
  if (live) return;
  const start = DateTime.fromJSDate(m.liveSince, { zone: auth.timezone }).toISODate()!;
  await tx.update(users).set({ digestStartDate: start }).where(and(eq(users.id, auth.userId), isNull(users.digestStartDate)));
}

export function registerMailboxRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, clock, config } = ctx.deps;
  const full = { preHandler: requireAuth(ctx, "full") };

  /**
   * Members reach only their own mailboxes. Admins also reach the org's mailboxes for configuration and health —
   * never content. On someone else's mailbox an admin may only look and reduce processing (pause,
   * make a folder private / stop its sync); everything that would expand processing, open a data path or touch the
   * owner's secrets (password, ingest token, aliases, SMTP, resume, un-private) is the owner's alone.
   */
  async function reachableMailbox(auth: AuthContext, raw: unknown): Promise<{ mailbox: MailboxRow; asAdmin: boolean }> {
    const id = uuidParam(raw);
    const [m] = await db.select().from(mailboxes).where(eq(mailboxes.id, id)).limit(1);
    if (!m) throw notFound();
    if (m.userId === auth.userId) return { mailbox: m, asAdmin: false };
    if (auth.role === "admin" && m.orgId === auth.orgId) return { mailbox: m, asAdmin: true };
    throw notFound();
  }

  const ownerOnly = (what: string) => forbidden(`Only the mailbox owner can ${what}`);

  async function auditMailbox(request: FastifyRequest, event: AuditEvent, m: MailboxRow, asAdmin: boolean, detail: Record<string, unknown> = {}) {
    const auth = authOf(request);
    await audit(db, {
      orgId: auth.orgId,
      userId: auth.userId,
      event,
      detail: { mailboxId: m.id, ...(asAdmin ? { admin: true, targetUserId: m.userId } : {}), ...detail },
      ip: request.ip,
    });
  }

  app.get("/api/mailboxes", full, async (request) => {
    const auth = authOf(request);
    const rows =
      auth.role === "admin"
        ? await db.select().from(mailboxes).where(eq(mailboxes.orgId, auth.orgId)).orderBy(asc(mailboxes.createdAt))
        : await db.select().from(mailboxes).where(eq(mailboxes.userId, auth.userId)).orderBy(asc(mailboxes.createdAt));
    if (auth.role === "admin" && rows.some((m) => m.userId !== auth.userId)) {
      await audit(db, { orgId: auth.orgId, userId: auth.userId, event: "admin.mailboxes_list", detail: { count: rows.length }, ip: request.ip });
    }
    const withMail = await mailboxesWithMail(
      db,
      rows.map((m) => m.id),
    );
    return { mailboxes: rows.map((m) => toMailboxSummary(m, withMail.has(m.id))) };
  });

  app.post("/api/mailboxes", full, async (request) => {
    const auth = authOf(request);
    const body = parseWith(CreateMailboxBody, request.body);
    const address = normalizeAddress(body.address);
    if (!address) throw badRequest("Invalid email address");
    if (body.provider === "imap" && !body.imapHost) throw badRequest("The IMAP server is missing");
    const imapHost = body.provider === "imap" ? (body.imapHost ?? null) : null;
    const hostProblem = imapHost ? hostSyntaxProblem(imapHost) : null;
    if (hostProblem) throw badRequest(hostProblem);
    const smtpPort = body.smtpPort === undefined ? 587 : body.smtpPort;
    const smtp = smtpProblem(imapHost, body.smtpHost, smtpPort);
    if (smtp) throw badRequest(smtp);
    const [dup] = await db
      .select({ id: mailboxes.id })
      .from(mailboxes)
      .where(and(eq(mailboxes.userId, auth.userId), eq(mailboxes.address, address)))
      .limit(1);
    if (dup) throw conflict("This mailbox already exists");
    const now = clock.now();
    const m = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(mailboxes)
        .values({
          orgId: auth.orgId,
          userId: auth.userId,
          provider: body.provider,
          address,
          aliases: body.aliases.filter((a) => a !== address),
          displayName: body.displayName ?? null,
          imapHost,
          imapPort: body.imapPort,
          imapUsername: body.provider === "imap" ? (body.imapUsername ?? address) : null,
          smtpHost: body.smtpHost ?? null,
          smtpPort,
          status: "setup",
          // Horizon: nothing older is ever analysed. Go-live watermark: a shadow week by default (same as the CLI);
          // messages first seen before it count as backfill and stay out of the first report.
          backfillFrom: new Date(now.getTime() - config.BACKFILL_DAYS * 86_400_000),
          liveSince: new Date(now.getTime() + 7 * 86_400_000),
        })
        .returning();
      await coupleDigestStart(tx, auth, row!, now);
      return row!;
    });
    await auditMailbox(request, "mailbox.create", m, false);
    return toMailboxSummary(m, false);
  });

  app.patch<{ Params: { id: string } }>("/api/mailboxes/:id", full, async (request) => {
    const auth = authOf(request);
    const { mailbox: m, asAdmin } = await reachableMailbox(auth, request.params.id);
    const body = parseWith(UpdateMailboxBody, request.body);
    if (asAdmin) {
      // Pause for safety is the one change an admin may make to someone else's mailbox.
      const fields = Object.entries(body)
        .filter(([, v]) => v !== undefined)
        .map(([k]) => k);
      if (fields.some((k) => k !== "status") || (body.status !== undefined && body.status !== "paused")) throw ownerOnly("change these settings or resume syncing");
    }
    // Connection settings (owner only: an admin was refused above). Correcting them is a new setup: the stored
    // password goes, and the next one is tried against the new settings.
    const move = connectionChange(m, body);
    if (move) {
      if (m.status === "disabled") throw conflict("The mailbox is disabled");
      if (body.status !== undefined) throw badRequest("Connection settings are changed separately from pausing or resuming sync");
    }
    const hostMoved = move?.imapHost !== undefined;
    const smtp = smtpProblem(move?.imapHost ?? m.imapHost, body.smtpHost, body.smtpPort, m, hostMoved);
    if (smtp) throw badRequest(smtp);
    const address = move?.address ?? m.address;
    const set: Partial<typeof mailboxes.$inferInsert> = {};
    if (body.displayName !== undefined) set.displayName = body.displayName;
    if (body.aliases !== undefined) set.aliases = body.aliases.filter((a) => a !== address);
    else if (move?.address !== undefined && m.aliases.includes(address)) set.aliases = m.aliases.filter((a) => a !== address);
    if (body.smtpHost !== undefined) set.smtpHost = body.smtpHost;
    if (body.smtpPort !== undefined) set.smtpPort = body.smtpPort;
    if (body.status !== undefined && body.status !== m.status) {
      if (m.status === "disabled") throw conflict("The mailbox is disabled");
      // auth_failed / blocked clear only with a new, probed password (credentials endpoint) — never by a
      // toggle, and not via paused → active either: each retry with a bad password burns the host's ban budget.
      if (m.status === "auth_failed" || m.status === "blocked") throw conflict("A new password is needed to turn it back on");
      if (body.status === "paused") {
        set.status = "paused";
        set.statusReason = asAdmin ? "admin" : "user";
      } else {
        if (m.provider === "imap" && !m.credentialsSealed) throw conflict("A password is needed first");
        set.status = "active";
        set.statusReason = null;
      }
    }
    // The address and the login name say whose mail this is: they change only while there is none of it.
    const accountMoved = move?.address !== undefined || move?.imapUsername !== undefined;
    if (move) {
      Object.assign(set, move);
      // A stored SMTP server is the IMAP server (smtpProblem), so it follows the new one.
      if (hostMoved && body.smtpHost === undefined && m.smtpHost !== null) set.smtpHost = move.imapHost;
      if (m.provider === "imap") {
        Object.assign(set, { credentialsSealed: null, credentialsKid: null, status: "setup", statusReason: null, lastError: null, lastErrorAt: null, consecutiveFailures: 0, nextAttemptAt: null });
      }
      // What the last probe found describes the account it logged in to.
      if (accountMoved) set.probe = null;
    }
    if (Object.keys(set).length === 0) return toMailboxSummary(m, (await mailboxesWithMail(db, [m.id])).has(m.id));
    const resumed = set.status === "active" && m.provider === "imap";
    const { row: updated, hasMail } = await db.transaction(async (tx) => {
      const hasMail = (await mailboxesWithMail(tx, [m.id])).has(m.id);
      if (accountMoved) {
        if (hasMail) {
          throw conflict("The mailbox already holds mail, so its address and username can't be changed. For another address, add a new mailbox.");
        }
        if (move?.address !== undefined) {
          const [dup] = await tx
            .select({ id: mailboxes.id })
            .from(mailboxes)
            .where(and(eq(mailboxes.userId, m.userId), eq(mailboxes.address, move.address), ne(mailboxes.id, m.id)))
            .limit(1);
          if (dup) throw conflict("This mailbox already exists");
        }
        // The folder list belongs to the account the old settings logged in to; the next probe lists the right one.
        await tx.delete(mailboxFolders).where(eq(mailboxFolders.mailboxId, m.id));
      }
      const [row] = await tx
        .update(mailboxes)
        .set(set)
        // Resuming needs a stored password also at the moment of the write (an edit may have just removed it).
        .where(resumed ? and(eq(mailboxes.id, m.id), isNotNull(mailboxes.credentialsSealed)) : eq(mailboxes.id, m.id))
        .returning();
      if (!row) throw conflict("A password is needed first");
      return { row, hasMail };
    });
    await auditMailbox(request, "mailbox.update", m, asAdmin, { fields: Object.keys(set), ...(move ? { connection: Object.keys(move), credentialsDropped: m.credentialsSealed !== null } : {}) });
    if (move) ctx.deps.log.info({ mailboxId: m.id, fields: Object.keys(move), credentialsDropped: m.credentialsSealed !== null }, "mailbox connection settings changed");
    return toMailboxSummary(updated, hasMail);
  });

  app.post<{ Params: { id: string } }>(
    "/api/mailboxes/:id/credentials",
    { preHandler: [requireAuth(ctx, "full"), rateLimit(ctx, "probe")] },
    async (request) => {
      const auth = authOf(request);
      const { mailbox: m, asAdmin } = await reachableMailbox(auth, request.params.id);
      // The password is the owner's full-control secret; an admin never enters or replaces it.
      if (asAdmin) throw ownerOnly("set its password");
      const { password } = parseWith(CredentialsBody, request.body);
      if (m.provider !== "imap" || !m.imapHost) throw badRequest("This is not an IMAP mailbox");
      if (m.status === "disabled") throw conflict("The mailbox is disabled");

      // SSRF guard: the API connects only to public mail hosts (no internal names, IP literals or private addresses).
      const hostCheck = await checkPublicHost(m.imapHost.toLowerCase(), ctx.resolveHost);
      if (!hostCheck.ok && hostCheck.kind === "policy") throw badRequest(hostCheck.reason);

      const now = clock.now();
      let result: ProbeResult;
      let loginAttempted = false;
      if (!hostCheck.ok) {
        result = refusedProbe("network", hostCheck.reason);
      } else {
        // Every probe is one real login against the shared host's ban budget: refuse while the host has
        // recent failures (any mailbox, any purpose — sync and CLI included), then also limit per mailbox.
        const budget = await hostLoginBudget(db, m.imapHost, now);
        if (!budget.ok) {
          const minutes = Math.ceil(budget.retryAfterSec / 60);
          const why =
            budget.reason === "too_many"
              ? "The mail server recently reported too many connections."
              : "There were failed sign-ins to this mail server recently.";
          result = refusedProbe("rate_limited", `${why} To keep the platform's connection from being blocked, try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`);
        } else {
          const perMailbox = ctx.limiter.take("probeMailbox", m.id);
          if (!perMailbox.ok) throw rateLimited(perMailbox.retryAfterSec);
          const settings: MailboxConnectionSettings = {
            mailboxId: m.id,
            address: m.address,
            imapHost: m.imapHost,
            imapPort: m.imapPort,
            imapUsername: m.imapUsername ?? m.address,
            smtpHost: m.smtpHost,
            smtpPort: m.smtpPort,
          };
          try {
            result = await ctx.deps.probe(settings, password);
            // The probe's own limiter answers before connecting: no login was made.
            loginAttempted = result.errorKind !== "rate_limited";
          } catch (err) {
            ctx.deps.log.warn({ mailboxId: m.id, err: err instanceof Error ? err.name : "unknown" }, "probe threw");
            result = refusedProbe("other", "The connection test failed");
            loginAttempted = true; // unknown whether it reached LOGIN: count it
          }
        }
      }
      // The one record of this login (ServerDeps.probe does not record): synchronous, so the next request's budget sees it.
      if (loginAttempted) {
        await db.insert(mailboxLoginAttempts).values({ mailboxId: m.id, at: now, purpose: "probe", outcome: attemptOutcome(result), detail: result.errorKind });
      }

      if (!result.ok) {
        // Nothing about the password is stored; the mailbox keeps its previous credentials and status.
        // A mailbox still being set up shows why; a working one keeps its own sync error state.
        if (m.status === "setup" && result.errorKind !== "rate_limited") {
          await db
            .update(mailboxes)
            .set({ lastError: result.errorKind ?? "probe_failed", lastErrorAt: now })
            .where(sameConnection(m));
        }
        await auditMailbox(request, "mailbox.credentials_probe_failed", m, asAdmin, { errorKind: result.errorKind, login: loginAttempted });
        ctx.deps.log.info({ mailboxId: m.id, errorKind: result.errorKind, login: loginAttempted }, "mailbox probe failed");
        const failed: ProbeSummary = {
          ok: false,
          error: scrub(result.error, password),
          errorKind: result.errorKind,
          capabilities: [],
          folders: [],
          quota: null,
        };
        return failed;
      }

      const sealed = sealMailboxPassword({ id: m.id, address: m.address }, password, ctx.deps.sealingKeys);
      const probeInfo: Record<string, unknown> = {
        at: now.toISOString(),
        capabilities: result.capabilities,
        delimiter: result.delimiter,
        quota: result.quota,
        folderCounts: Object.fromEntries(result.folders.filter((f) => typeof f.messages === "number").map((f) => [f.path, f.messages])),
      };
      const [updated] = await db
        .update(mailboxes)
        .set({
          ...sealed,
          status: "active",
          statusReason: null,
          lastError: null,
          lastErrorAt: null,
          consecutiveFailures: 0,
          nextAttemptAt: null,
          lastLoginAt: now,
          probe: probeInfo,
        })
        .where(sameConnection(m))
        .returning();
      if (!updated) {
        // The settings were edited while the login was being tried: this password was checked against the old ones.
        ctx.deps.log.info({ mailboxId: m.id }, "mailbox probe discarded: connection settings changed meanwhile");
        throw conflict("The connection settings changed while the sign-in was being tried");
      }
      await upsertProbedFolders(db, m.id, result, now);
      await auditMailbox(request, "mailbox.credentials_set", m, asAdmin, { kid: sealed.credentialsKid, folders: result.folders.length });
      ctx.deps.log.info({ mailboxId: m.id, folders: result.folders.length }, "mailbox credentials stored");
      const ok: ProbeSummary = {
        ok: true,
        error: null,
        errorKind: null,
        capabilities: result.capabilities,
        folders: await listFolders(db, updated),
        quota: result.quota,
      };
      return ok;
    },
  );

  app.get<{ Params: { id: string } }>("/api/mailboxes/:id/folders", full, async (request) => {
    const { mailbox: m } = await reachableMailbox(authOf(request), request.params.id);
    return { folders: await listFolders(db, m) };
  });

  app.patch<{ Params: { id: string; folderId: string } }>("/api/mailboxes/:id/folders/:folderId", full, async (request) => {
    const { mailbox: m, asAdmin } = await reachableMailbox(authOf(request), request.params.id);
    const folderId = uuidParam(request.params.folderId);
    const [f] = await db
      .select()
      .from(mailboxFolders)
      .where(and(eq(mailboxFolders.id, folderId), eq(mailboxFolders.mailboxId, m.id)))
      .limit(1);
    if (!f) throw notFound();
    const body = parseWith(UpdateFolderBody, request.body);
    // An admin may only reduce what is read (mark private, stop syncing) — never un-private, enable or re-role.
    if (asAdmin && (body.role !== undefined || body.private === false || body.syncEnabled === true)) {
      throw ownerOnly("turn on syncing, change the role or remove “private”");
    }
    const role = body.role ?? f.role;
    const isPrivate = body.private ?? f.private;
    const virtual = isVirtualRow(f);
    let syncEnabled = body.syncEnabled ?? f.syncEnabled;
    if (body.syncEnabled === true && isPrivate) throw badRequest("A private folder is never synced");
    if (body.syncEnabled === true && role === "drafts") throw badRequest("Drafts are never read");
    if (body.syncEnabled === true && virtual) {
      throw badRequest("A virtual folder (e.g. “All Mail”) holds copies of other folders, private ones included, and is never synced");
    }
    // Private folders, drafts and virtual views are never synced, whatever the previous toggle was.
    if (isPrivate || role === "drafts" || virtual) syncEnabled = false;
    const set: Partial<typeof mailboxFolders.$inferInsert> = { syncEnabled, private: isPrivate };
    if (body.role !== undefined) {
      set.role = body.role;
      set.roleSource = "user";
    }
    const [updated] = await db.update(mailboxFolders).set(set).where(eq(mailboxFolders.id, f.id)).returning();
    await auditMailbox(request, "mailbox.folder_update", m, asAdmin, { folderId: f.id, fields: Object.keys(body) });
    return toFolderSummary(updated!, folderCounts(m));
  });

  app.post<{ Params: { id: string } }>("/api/mailboxes/:id/ingest-token", full, async (request) => {
    const { mailbox: m, asAdmin } = await reachableMailbox(authOf(request), request.params.id);
    // The token lets its holder write mail into the mailbox (as the owner, for declared outbound mail).
    if (asAdmin) throw ownerOnly("issue a token for the ingest API");
    const token = randomToken(32);
    await db.update(mailboxes).set({ ingestTokenHash: sha256Hex(token) }).where(eq(mailboxes.id, m.id));
    await auditMailbox(request, "mailbox.ingest_token_issue", m, asAdmin);
    return { token };
  });
}

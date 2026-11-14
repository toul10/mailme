import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { DbOrTx } from "../../db/client.js";
import { appState, mailboxes, mailboxFolders, mailboxLoginAttempts, organizations, users } from "../../db/schema.js";
import { localDateOf, safeZone } from "../../digest/calendar.js";
import { FOLDER_ROLES, type FolderRole, type MailboxConnectionSettings } from "../../domain/types.js";
import { sealMailboxPassword } from "../../lib/credentials.js";
import { randomToken, sha256Hex } from "../../lib/crypto.js";
import { HOST_AUTH_FAILURES_PER_HOUR, hostLoginBudget } from "../../mail/imap/login-budget.js";
import { isSelectableFolder, isVirtualFolder } from "../../mail/imap/folders.js";
import type { ProbeResult } from "../../mail/imap/probe.js";
import { GLOBAL_PAUSE_KEY } from "../../ops/health.js";
import { UsageError, type ParsedArgs } from "../args.js";
import { audit, findMailbox, findUser, findUserMailbox, type CliContext } from "../context.js";
import { yesOpt, type Command } from "./types.js";

type MailboxRow = typeof mailboxes.$inferSelect;

/** Shadow week by default: messages first seen before live_since are backfill (not in the first report). */
const DEFAULT_SHADOW_DAYS = 7;
/** Default ports only: there is no default server, so a new IMAP mailbox needs --host. */
const DEFAULT_IMAP = { port: 993, smtpPort: 587 } as const;

/**
 * Connection fields for mailbox:add. A new mailbox gets defaults for everything not given except the host; an existing
 * one only changes what was passed explicitly (or fills a missing value). Throws (before anything is stored) when
 * neither --host nor a stored host is known.
 */
function connectionPatch(args: ParsedArgs, address: string, cur: MailboxRow | null): Partial<typeof mailboxes.$inferInsert> {
  const host = args.str("host");
  const imapHost = host ?? cur?.imapHost;
  if (!imapHost) throw new UsageError(`--host is required: the IMAP server for ${address} (e.g. --host imap.example.com)`);
  const out: Partial<typeof mailboxes.$inferInsert> = {};
  if (!cur || host || !cur.imapHost) out.imapHost = imapHost;
  if (!cur || args.num("port") !== undefined) out.imapPort = args.num("port") ?? DEFAULT_IMAP.port;
  if (!cur || args.str("username") || !cur.imapUsername) out.imapUsername = args.str("username") ?? address;
  if (!cur || args.str("smtp-host") || !cur.smtpHost) out.smtpHost = args.str("smtp-host") ?? imapHost;
  if (!cur || args.num("smtp-port") !== undefined) out.smtpPort = args.num("smtp-port") ?? DEFAULT_IMAP.smtpPort;
  return out;
}

/** Never let the CLI add to the provider's ban counter: refuse after this many auth failures in an hour. */
const MAX_AUTH_FAILURES_PER_HOUR = 2;

/** sha256 hex of an ingest bearer token (the server compares sha256Hex(token) with mailboxes.ingest_token_hash). */
export function hashIngestToken(token: string): string {
  return sha256Hex(token);
}

export function connectionSettings(mb: MailboxRow): MailboxConnectionSettings {
  if (!mb.imapHost) throw new UsageError(`Mailbox ${mb.id} has no IMAP host`);
  return {
    mailboxId: mb.id,
    address: mb.address,
    imapHost: mb.imapHost,
    imapPort: mb.imapPort,
    imapUsername: mb.imapUsername ?? mb.address,
    smtpHost: mb.smtpHost,
    smtpPort: mb.smtpPort,
  };
}

/** Why a login must not be attempted now (recent auth failures / too-many-connections), or null. */
export async function loginBudgetProblem(db: DbOrTx, mailboxId: string, now: Date): Promise<string | null> {
  // The provider bans the platform's single IP across all accounts on the host, so the budget is host-wide first.
  const [mb] = await db.select({ imapHost: mailboxes.imapHost }).from(mailboxes).where(eq(mailboxes.id, mailboxId));
  if (mb?.imapHost) {
    const host = await hostLoginBudget(db, mb.imapHost, now);
    if (!host.ok) {
      return host.reason === "too_many"
        ? "the server reported too many connections in the last 15 minutes"
        : `${HOST_AUTH_FAILURES_PER_HOUR}+ failed logins on ${mb.imapHost} in the last hour — another failure may get the IP banned by the mail server`;
    }
  }
  const res = await db
    .select({
      auth: sql<number>`count(*) filter (where ${mailboxLoginAttempts.outcome} = 'auth_failed')::int`,
      tooMany: sql<number>`count(*) filter (where ${mailboxLoginAttempts.outcome} = 'too_many' and ${mailboxLoginAttempts.at} > ${new Date(now.getTime() - 15 * 60_000)})::int`,
    })
    .from(mailboxLoginAttempts)
    .where(and(eq(mailboxLoginAttempts.mailboxId, mailboxId), gt(mailboxLoginAttempts.at, new Date(now.getTime() - 3_600_000))));
  const r = res[0];
  if (Number(r?.auth ?? 0) >= MAX_AUTH_FAILURES_PER_HOUR) return `${r!.auth} failed logins in the last hour — another failure may get the IP banned by the mail server`;
  if (Number(r?.tooMany ?? 0) > 0) return "the server reported too many connections in the last 15 minutes";
  return null;
}

/** mailboxes.probe — same shape the API stores (no content: capabilities, delimiter, quota, message counts). */
function probeSummary(p: ProbeResult, now: Date): Record<string, unknown> {
  return {
    at: now.toISOString(),
    capabilities: p.capabilities,
    delimiter: p.delimiter,
    quota: p.quota,
    folderCounts: Object.fromEntries(p.folders.filter((f) => typeof f.messages === "number").map((f) => [f.path, f.messages])),
  };
}

/**
 * Upsert LISTed folders; the user's role choices and sync toggles are kept, vanished folders are marked gone.
 * A new folder's sync default is the role default — never for server-side virtual views (`\All`, `\Flagged`: they
 * would re-expose Trash and private folders' mail) or unselectable entries, same rule as the sync's own LIST upsert
 * (mail/imap/folders.ts initialSyncEnabled). A virtual view that is sync-enabled from an earlier setup is turned off.
 */
export async function upsertProbeFolders(db: DbOrTx, mailboxId: string, probe: ProbeResult, defaultSyncEnabled: (role: FolderRole) => boolean, now: Date) {
  const existing = await db.select().from(mailboxFolders).where(eq(mailboxFolders.mailboxId, mailboxId));
  const byPath = new Map(existing.map((f) => [f.path, f]));
  const listed = new Set<string>();
  for (const f of probe.folders) {
    listed.add(f.path);
    const role: FolderRole = (FOLDER_ROLES as readonly string[]).includes(f.role) ? (f.role as FolderRole) : "other";
    const roleSource = f.roleSource === "special_use" ? "special_use" : "name";
    const virtual = isVirtualFolder(f);
    const cur = byPath.get(f.path);
    if (!cur) {
      const syncEnabled = defaultSyncEnabled(role) && isSelectableFolder(f) && !virtual;
      await db.insert(mailboxFolders).values({ mailboxId, path: f.path, name: f.name, delimiter: f.delimiter, role, specialUse: f.specialUse, roleSource, syncEnabled, createdAt: now });
    } else {
      await db
        .update(mailboxFolders)
        .set({ name: f.name, delimiter: f.delimiter, specialUse: f.specialUse, goneAt: null, ...(cur.roleSource === "user" ? {} : { role, roleSource }), ...(virtual ? { syncEnabled: false } : {}) })
        .where(eq(mailboxFolders.id, cur.id));
    }
  }
  for (const f of existing) {
    if (!listed.has(f.path) && !f.goneAt) await db.update(mailboxFolders).set({ goneAt: now }).where(eq(mailboxFolders.id, f.id));
  }
}

async function printFolders(ctx: CliContext, mailboxId: string, counts?: Map<string, number | null>) {
  const rt = await ctx.runtime();
  const rows = await rt.db.select().from(mailboxFolders).where(eq(mailboxFolders.mailboxId, mailboxId)).orderBy(mailboxFolders.path);
  const width = Math.max(10, ...rows.map((r) => r.path.length));
  for (const f of rows) {
    const flags = [f.syncEnabled ? "sync" : "-", f.private ? "private" : "", f.goneAt ? "gone" : ""].filter(Boolean).join(",");
    const n = counts?.get(f.path);
    ctx.io.out(`  ${f.path.padEnd(width)}  ${f.role.padEnd(8)} ${`(${f.roleSource})`.padEnd(14)} ${flags}${n != null ? `  ${n} msgs` : ""}`);
  }
}

function parseLiveSince(v: string, now: Date): Date {
  if (v === "now") return now;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00` : v);
  if (Number.isNaN(d.getTime())) throw new UsageError("--live-since must be an ISO date/time or 'now'");
  return d;
}

async function runProbe(ctx: CliContext, mb: MailboxRow, password: string): Promise<ProbeResult> {
  const rt = await ctx.runtime();
  let probe: ProbeResult;
  try {
    probe = await ctx.services.probeMailbox(connectionSettings(mb), password);
  } catch (err) {
    probe = { ok: false, errorKind: "other", error: err instanceof Error ? err.message : String(err), capabilities: [], delimiter: null, folders: [], quota: null };
  }
  await rt.recordLoginAttempt(mb.id, "probe", probe.ok ? "ok" : (probe.errorKind ?? "other"), probe.ok ? null : probe.errorKind);
  return probe;
}

/**
 * Shadow week («Week 1, shadow: no report»): unless a start date was set explicitly, the owner's reports
 * start on the local go-live date of a mailbox created with a future live_since. Otherwise reports would go out
 * during the shadow week and spend the first report's go-live handling before go-live. (The dispatcher applies the
 * same rule for users whose start date is still unset: src/digest/dispatch.ts effectiveDigestStart.)
 */
async function coupleDigestStart(ctx: CliContext, user: { id: string; orgId: string }, mb: MailboxRow, now: Date): Promise<void> {
  if (!mb.liveSince || mb.liveSince.getTime() <= now.getTime()) return;
  const rt = await ctx.runtime();
  const [org] = await rt.db.select({ timezone: organizations.timezone }).from(organizations).where(eq(organizations.id, user.orgId));
  const start = localDateOf(mb.liveSince, safeZone(org?.timezone, rt.config.DEFAULT_TIMEZONE));
  const [set] = await rt.db
    .update(users)
    .set({ digestStartDate: start })
    .where(and(eq(users.id, user.id), isNull(users.digestStartDate)))
    .returning({ id: users.id });
  if (set) ctx.io.out(`Shadow week: daily reports start on ${start} (go-live). Change with: pnpm cli user:update --user ${user.id} --digest-start <YYYY-MM-DD>`);
}

export const mailboxAdd: Command = {
  name: "mailbox:add",
  summary: "Connect a mailbox: prompt for the password (no echo), probe once, seal it, list folders. Re-run to re-enter a password",
  options: {
    user: { type: "string", required: true, arg: "<email|id>", description: "Owner (web-app user)" },
    address: { type: "string", required: true, arg: "<email>", description: "Mailbox address" },
    provider: { type: "string", arg: "<imap|ingest>", description: "imap (server sync) or ingest (Outlook agent / .eml only)", default: "imap" },
    host: { type: "string", arg: "<host>", description: "IMAP host (required for a new mailbox; re-run: unchanged unless given)" },
    port: { type: "number", description: `IMAP port, implicit TLS (new mailbox: ${DEFAULT_IMAP.port})` },
    username: { type: "string", arg: "<login>", description: "IMAP login (new mailbox: the address)" },
    "smtp-host": { type: "string", arg: "<host>", description: "SMTP host for report delivery (new mailbox: the IMAP host)" },
    "smtp-port": { type: "number", description: `SMTP port, STARTTLS (new mailbox: ${DEFAULT_IMAP.smtpPort})` },
    aliases: { type: "csv", arg: "<a,b>", description: "Other addresses of the owner" },
    "display-name": { type: "string", arg: "<name>", description: "Owner display name" },
    "live-since": { type: "string", arg: "<date|now>", description: `Go-live watermark (default now + ${DEFAULT_SHADOW_DAYS} days: shadow week)` },
    force: { type: "boolean", description: "Probe even after recent failed logins (risks an IP ban)" },
  },
  async run(ctx, args) {
    const rt = await ctx.runtime();
    const now = ctx.now();
    const user = await findUser(rt.db, args.req("user"));
    const address = args.req("address").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) throw new UsageError("Invalid --address");
    const provider = args.str("provider") ?? "imap";
    if (provider !== "imap" && provider !== "ingest") throw new UsageError("--provider must be imap or ingest");
    const aliases = [...new Set(args.list("aliases").map((a) => a.toLowerCase()))].filter((a) => a !== address);
    const liveSinceArg = args.str("live-since");
    const existing = await findUserMailbox(rt.db, user.id, address);

    for (const p of ["port", "smtp-port"]) {
      const v = args.num(p);
      if (v !== undefined && (!Number.isInteger(v) || v < 1 || v > 65535)) throw new UsageError(`--${p} must be a TCP port`);
    }
    // Re-running for an existing mailbox (new password, --live-since) never resets its connection settings.
    const connection = provider === "imap" ? connectionPatch(args, address, existing) : {};
    // A stored password belongs to the stored host/port/login: new connection settings are probed first and saved
    // only together with the new password, so a failed probe never leaves the worker a mismatched pair.
    const deferConnection = !!existing?.credentialsSealed && Object.keys(connection).length > 0;
    const base = {
      provider,
      ...(args.list("aliases").length ? { aliases } : {}),
      ...(args.str("display-name") ? { displayName: args.str("display-name")! } : {}),
      ...(liveSinceArg ? { liveSince: parseLiveSince(liveSinceArg, now) } : {}),
      ...(deferConnection ? {} : connection),
    } satisfies Partial<typeof mailboxes.$inferInsert>;

    let mb: MailboxRow;
    if (existing) {
      if (existing.provider !== provider) throw new UsageError(`Mailbox exists with provider ${existing.provider}`);
      [mb] = (await rt.db.update(mailboxes).set(base).where(eq(mailboxes.id, existing.id)).returning()) as [MailboxRow];
      ctx.io.out(`Updating existing mailbox ${mb.id} (status ${mb.status}).`);
    } else {
      [mb] = (await rt.db
        .insert(mailboxes)
        .values({
          orgId: user.orgId,
          userId: user.id,
          address,
          status: provider === "ingest" ? "active" : "setup",
          backfillFrom: new Date(now.getTime() - rt.config.BACKFILL_DAYS * 86_400_000),
          liveSince: new Date(now.getTime() + DEFAULT_SHADOW_DAYS * 86_400_000),
          createdAt: now,
          ...base,
        })
        .returning()) as [MailboxRow];
      ctx.io.out(`Mailbox created: ${mb.id}`);
    }
    if (!existing || liveSinceArg) await coupleDigestStart(ctx, user, mb, now);

    if (provider === "ingest") {
      if (!user.digestMailboxId) await rt.db.update(users).set({ digestMailboxId: mb.id }).where(eq(users.id, user.id));
      ctx.io.out("Ingest-only mailbox (no IMAP). Issue an upload token with: pnpm cli mailbox:ingest-token --mailbox " + mb.id);
      return 0;
    }

    const problem = await loginBudgetProblem(rt.db, mb.id, now);
    if (problem && !args.bool("force")) {
      ctx.io.err(`Not probing: ${problem}. Wait, check the password in webmail first, or pass --force.`);
      return 1;
    }
    const password = await ctx.io.prompt(`IMAP password for ${address}: `, { secret: true });
    if (!password) throw new UsageError("Empty password");
    const target = (deferConnection ? { ...mb, ...connection } : mb) as MailboxRow;
    ctx.io.out(`Probing ${target.imapHost}:${target.imapPort} (one login, read-only)…`);
    const probe = await runProbe(ctx, target, password);
    if (!probe.ok) {
      await rt.db.update(mailboxes).set({ lastError: `probe:${probe.errorKind ?? "other"}`, lastErrorAt: now }).where(eq(mailboxes.id, mb.id));
      ctx.io.err(`Probe failed (${probe.errorKind ?? "other"}): ${probe.error ?? ""}`);
      ctx.io.err(
        `The password was NOT stored (mailbox ${mb.id} keeps status ${mb.status}${deferConnection ? " and its previous connection settings" : ""}). ` +
          (probe.errorKind === "auth" ? "Check the password in webmail before retrying (bans after ~5 failures)." : "Check host/port/network and retry."),
      );
      return 1;
    }
    const sealed = sealMailboxPassword(mb, password, rt.sealingKeys());
    await rt.db.transaction(async (tx) => {
      await tx
        .update(mailboxes)
        .set({
          ...(deferConnection ? connection : {}),
          ...sealed,
          status: "active",
          statusReason: null,
          lastError: null,
          lastErrorAt: null,
          consecutiveFailures: 0,
          nextAttemptAt: null,
          lastLoginAt: now,
          probe: probeSummary(probe, now),
        })
        .where(eq(mailboxes.id, mb.id));
      await upsertProbeFolders(tx, mb.id, probe, ctx.services.defaultSyncEnabled, now);
    });
    if (!user.digestMailboxId) await rt.db.update(users).set({ digestMailboxId: mb.id }).where(eq(users.id, user.id));
    await audit(rt.db, "mailbox_credentials_set", { orgId: mb.orgId, userId: user.id, detail: { mailboxId: mb.id }, now });
    const [fresh] = await rt.db.select().from(mailboxes).where(eq(mailboxes.id, mb.id));
    ctx.io.out(`Connected. Status: active. Capabilities: ${probe.capabilities.length}. Folders: ${probe.folders.length}.`);
    if (probe.quota) ctx.io.out(`Quota: ${Math.round(probe.quota.usedKb / 1024)} MB of ${Math.round(probe.quota.limitKb / 1024)} MB`);
    await printFolders(ctx, mb.id, new Map(probe.folders.map((f) => [f.path, f.messages])));
    ctx.io.out(`Backfill from ${fresh!.backfillFrom?.toISOString() ?? "-"}; live since ${fresh!.liveSince?.toISOString() ?? "-"}.`);
    ctx.io.out(`Adjust folders with: pnpm cli mailbox:folders --mailbox ${mb.id} --enable <path> --role <path>=sent`);
  },
};

export const mailboxProbe: Command = {
  name: "mailbox:probe",
  summary: "Log in once with the stored password: capabilities, folders, quota (read-only)",
  options: {
    mailbox: { type: "string", required: true, arg: "<id|address>", description: "Mailbox" },
    force: { type: "boolean", description: "Probe even after recent failed logins" },
  },
  async run(ctx, args) {
    const rt = await ctx.runtime();
    const now = ctx.now();
    const mb = await findMailbox(rt.db, args.req("mailbox"));
    if (mb.provider !== "imap") throw new UsageError("Only IMAP mailboxes can be probed");
    const problem = await loginBudgetProblem(rt.db, mb.id, now);
    if (problem && !args.bool("force")) {
      ctx.io.err(`Not probing: ${problem}. Pass --force to override.`);
      return 1;
    }
    const probe = await runProbe(ctx, mb, await rt.getPassword(mb));
    if (!probe.ok) {
      const patch: Partial<typeof mailboxes.$inferInsert> = { lastError: `probe:${probe.errorKind ?? "other"}`, lastErrorAt: now };
      // A rejected stored password is final until a person re-enters it (no automatic retries).
      if (probe.errorKind === "auth") Object.assign(patch, { status: "auth_failed", statusReason: "probe" });
      await rt.db.update(mailboxes).set(patch).where(eq(mailboxes.id, mb.id));
      ctx.io.err(`Probe failed (${probe.errorKind ?? "other"}): ${probe.error ?? ""}`);
      return 1;
    }
    await rt.db.transaction(async (tx) => {
      await tx.update(mailboxes).set({ probe: probeSummary(probe, now), lastLoginAt: now }).where(eq(mailboxes.id, mb.id));
      await upsertProbeFolders(tx, mb.id, probe, ctx.services.defaultSyncEnabled, now);
    });
    ctx.io.out(`OK. Capabilities: ${probe.capabilities.join(" ")}`);
    ctx.io.out(`Delimiter: ${probe.delimiter ?? "-"}`);
    if (probe.quota) ctx.io.out(`Quota: ${Math.round(probe.quota.usedKb / 1024)} MB of ${Math.round(probe.quota.limitKb / 1024)} MB`);
    await printFolders(ctx, mb.id, new Map(probe.folders.map((f) => [f.path, f.messages])));
  },
};

export const mailboxFoldersCmd: Command = {
  name: "mailbox:folders",
  summary: "List folders; enable/disable sync, set roles, mark private",
  options: {
    mailbox: { type: "string", required: true, arg: "<id|address>", description: "Mailbox" },
    enable: { type: "list", arg: "<path>", description: "Sync this folder" },
    disable: { type: "list", arg: "<path>", description: "Stop syncing this folder" },
    role: { type: "list", arg: "<path=role>", description: `Set the role (${FOLDER_ROLES.join("|")})` },
    private: { type: "list", arg: "<path>", description: "Never sync or analyse this folder" },
    public: { type: "list", arg: "<path>", description: "Undo --private" },
  },
  async run(ctx, args) {
    const rt = await ctx.runtime();
    const mb = await findMailbox(rt.db, args.req("mailbox"));
    const folders = await rt.db.select().from(mailboxFolders).where(eq(mailboxFolders.mailboxId, mb.id));
    const byPath = new Map(folders.map((f) => [f.path, { ...f }]));
    const get = (p: string) => {
      const f = byPath.get(p);
      if (!f) throw new UsageError(`No folder "${p}" (run mailbox:probe to refresh the list)`);
      return f;
    };
    const changed = new Set<string>();
    for (const spec of args.list("role")) {
      const i = spec.lastIndexOf("=");
      const p = spec.slice(0, i);
      const role = spec.slice(i + 1);
      if (i <= 0 || !(FOLDER_ROLES as readonly string[]).includes(role)) throw new UsageError(`--role expects <path>=<${FOLDER_ROLES.join("|")}>`);
      Object.assign(get(p), { role: role as FolderRole, roleSource: "user" as const });
      changed.add(p);
    }
    for (const p of args.list("private")) {
      Object.assign(get(p), { private: true, syncEnabled: false });
      changed.add(p);
    }
    for (const p of args.list("public")) {
      get(p).private = false;
      changed.add(p);
    }
    for (const p of args.list("disable")) {
      get(p).syncEnabled = false;
      changed.add(p);
    }
    for (const p of args.list("enable")) {
      const f = get(p);
      if (f.role === "drafts" || f.role === "trash") throw new UsageError(`"${p}" is a ${f.role} folder; drafts and trash are never read`);
      if (f.private) throw new UsageError(`"${p}" is private; use --public first`);
      if (isVirtualFolder({ path: f.path, name: f.name, delimiter: f.delimiter, flags: [], specialUse: f.specialUse })) {
        throw new UsageError(`"${p}" is a server-side view (${f.specialUse}) of other folders, including Trash and private ones; it is never synced`);
      }
      f.syncEnabled = true;
      changed.add(p);
    }
    // A role change to drafts/trash turns sync off.
    for (const p of changed) {
      const f = byPath.get(p)!;
      if (f.role === "drafts" || f.role === "trash") f.syncEnabled = false;
    }
    if (changed.size) {
      await rt.db.transaction(async (tx) => {
        for (const p of changed) {
          const f = byPath.get(p)!;
          await tx.update(mailboxFolders).set({ role: f.role, roleSource: f.roleSource, syncEnabled: f.syncEnabled, private: f.private }).where(eq(mailboxFolders.id, f.id));
        }
      });
      await audit(rt.db, "mailbox_folders_changed", { orgId: mb.orgId, userId: mb.userId, detail: { mailboxId: mb.id, folders: changed.size }, now: ctx.now() });
      ctx.io.out(`Updated ${changed.size} folder(s).`);
    }
    await printFolders(ctx, mb.id);
  },
};

export const mailboxIngestToken: Command = {
  name: "mailbox:ingest-token",
  summary: "Issue (or rotate) the bearer token for the ingest API / Outlook agent; shown once",
  options: { mailbox: { type: "string", required: true, arg: "<id|address>", description: "Mailbox" }, yes: yesOpt },
  async run(ctx, args) {
    const rt = await ctx.runtime();
    const mb = await findMailbox(rt.db, args.req("mailbox"));
    if (mb.ingestTokenHash && !args.bool("yes") && !(await ctx.io.confirm("A token exists; the old one stops working. Rotate?"))) return 1;
    const token = randomToken(32);
    await rt.db.update(mailboxes).set({ ingestTokenHash: hashIngestToken(token) }).where(eq(mailboxes.id, mb.id));
    await audit(rt.db, "ingest_token_issued", { orgId: mb.orgId, userId: mb.userId, detail: { mailboxId: mb.id }, now: ctx.now() });
    ctx.io.out("Ingest token (shown only now; store it in the agent's config file):");
    ctx.io.out(`  ${token}`);
    ctx.io.out("");
    ctx.io.out("Usage:");
    ctx.io.out(`  curl -X POST ${rt.config.APP_BASE_URL}/api/ingest/${mb.id} -H "Authorization: Bearer <token>" \\`);
    ctx.io.out('       -H "Content-Type: message/rfc822" [-H "x-mailme-declared-outbound: 1"] --data-binary @message.eml');
  },
};

export const mailboxResume: Command = {
  name: "mailbox:resume",
  summary: "Clear auth_failed / blocked / paused and the per-mailbox AI pause (after fixing the cause)",
  options: { mailbox: { type: "string", required: true, arg: "<id|address>", description: "Mailbox" }, yes: yesOpt },
  async run(ctx, args) {
    const rt = await ctx.runtime();
    const mb = await findMailbox(rt.db, args.req("mailbox"));
    ctx.io.out(`Mailbox ${mb.id}: status ${mb.status}${mb.statusReason ? ` (${mb.statusReason})` : ""}; AI ${mb.aiPaused ? `paused (${mb.aiPausedReason ?? "manual"})` : "running"}; last error ${mb.lastError ?? "-"}`);
    const statusFix = mb.status === "auth_failed" || mb.status === "blocked" || mb.status === "paused";
    if (!statusFix && !mb.aiPaused) {
      ctx.io.out("Nothing to resume.");
      return 0;
    }
    if (mb.status === "auth_failed") {
      ctx.io.out("Warning: if the password changed, use mailbox:add to re-enter it — each wrong login counts toward the server's ban threshold.");
    }
    if (!args.bool("yes") && !(await ctx.io.confirm("Resume?"))) return 1;
    await rt.db
      .update(mailboxes)
      .set({
        ...(statusFix ? { status: "active" as const, statusReason: null, consecutiveFailures: 0, nextAttemptAt: null } : {}),
        aiPaused: false,
        aiPausedReason: null,
      })
      .where(eq(mailboxes.id, mb.id));
    await audit(rt.db, "mailbox_resumed", { orgId: mb.orgId, userId: mb.userId, detail: { mailboxId: mb.id, from: mb.status, aiPaused: mb.aiPaused }, now: ctx.now() });
    ctx.io.out("Resumed. The worker picks it up within a minute.");
  },
};

export const aiResume: Command = {
  name: "ai:resume",
  summary: "Clear the global AI pause (set after API key/billing errors or a code bug) once the cause is fixed",
  options: { yes: yesOpt },
  async run(ctx, args) {
    const rt = await ctx.runtime();
    const [row] = await rt.db.select().from(appState).where(eq(appState.key, GLOBAL_PAUSE_KEY));
    if (!row) {
      ctx.io.out("AI is not globally paused.");
      return 0;
    }
    const v = row.value as { reason?: unknown; at?: unknown } | null;
    ctx.io.out(`Global AI pause since ${String(v?.at ?? row.updatedAt.toISOString())}, reason: ${String(v?.reason ?? "unknown")}.`);
    if (!args.bool("yes") && !(await ctx.io.confirm("Resume AI for all mailboxes?"))) return 1;
    await rt.db.delete(appState).where(eq(appState.key, GLOBAL_PAUSE_KEY));
    await audit(rt.db, "ai_global_resume", { detail: { reason: String(v?.reason ?? "unknown") }, now: ctx.now() });
    ctx.io.out("Resumed.");
  },
};

export const mailboxCommands: Command[] = [mailboxAdd, mailboxProbe, mailboxFoldersCmd, mailboxIngestToken, mailboxResume, aiResume];

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomInt } from "node:crypto";
import { DateTime } from "luxon";
import { AUDIT_STRATA, DEFAULT_AUDIT_COUNTS, importAuditLabels, LABEL_INSTRUCTIONS, sampleForAudit, type AuditStratum } from "../../ops/audit.js";
import { evaluateHealth } from "../../ops/health.js";
import { computeKpis, formatKpis } from "../../ops/kpi.js";
import { UsageError } from "../args.js";
import { assertIsoDate, audit, findMailbox, findUser } from "../context.js";
import type { Command } from "./types.js";

function writePrivate(file: string, content: string) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, content, { mode: 0o600 });
  chmodSync(file, 0o600);
}

export const kpi: Command = {
  name: "kpi",
  summary: "KPIs from SQL (aggregates only): tasks, precision signals, suggestions, AI cost, adoption",
  options: {
    from: { type: "string", arg: "<YYYY-MM-DD>", description: "First day (default: 6 days before --to)" },
    to: { type: "string", arg: "<YYYY-MM-DD>", description: "Last day (default: today)" },
    json: { type: "boolean", description: "Machine-readable output" },
  },
  async run(ctx, args) {
    const rt = await ctx.runtime();
    const zone = rt.config.DEFAULT_TIMEZONE;
    const to = args.str("to") ? assertIsoDate(args.str("to")!, "--to") : DateTime.fromJSDate(ctx.now(), { zone }).toISODate()!;
    const from = args.str("from") ? assertIsoDate(args.str("from")!, "--from") : DateTime.fromISO(to, { zone }).minus({ days: 6 }).toISODate()!;
    const report = await computeKpis(rt.db, { from, to, zone });
    ctx.io.out(args.bool("json") ? JSON.stringify(report, null, 2) : formatKpis(report));
  },
};

export const auditSample: Command = {
  name: "audit:sample",
  summary: "Export a stratified random sample of a week's messages for blind labelling (contains e-mail content!)",
  options: {
    week: { type: "string", required: true, arg: "<YYYY-Www>", description: "ISO week, e.g. 2026-W39" },
    filtered: { type: "number", description: "Pre-filtered messages", default: DEFAULT_AUDIT_COUNTS.filtered },
    fyi: { type: "number", description: "Analysed, not actionable", default: DEFAULT_AUDIT_COUNTS.fyi },
    actionable: { type: "number", description: "Analysed as actionable (and parked)", default: DEFAULT_AUDIT_COUNTS.actionable },
    seed: { type: "number", description: "PRNG seed to reproduce a sample (printed when omitted)" },
    mailbox: { type: "string", arg: "<id|address>", description: "Only this mailbox" },
    "out-dir": { type: "string", arg: "<dir>", description: "Output directory (default <DATA_DIR>/audit, git-ignored)" },
  },
  async run(ctx, args) {
    const rt = await ctx.runtime();
    const week = args.req("week");
    const counts = Object.fromEntries(AUDIT_STRATA.map((s) => [s, args.num(s)!])) as Record<AuditStratum, number>;
    for (const [s, n] of Object.entries(counts)) if (!Number.isInteger(n) || n < 0) throw new UsageError(`--${s} must be a non-negative integer`);
    const seed = args.num("seed") ?? randomInt(1, 2 ** 31 - 1);
    const mailboxId = args.str("mailbox") ? (await findMailbox(rt.db, args.str("mailbox")!)).id : null;
    const sample = await sampleForAudit(rt.db, { week, zone: rt.config.DEFAULT_TIMEZONE, counts, seed, mailboxId });
    const dir = args.str("out-dir") ?? path.join(ctx.ops().DATA_DIR, "audit");
    const sampleFile = path.join(dir, `${week}-sample.json`);
    const labelsFile = path.join(dir, `${week}-labels.json`);
    writePrivate(sampleFile, JSON.stringify({ week, seed, generatedAt: ctx.now().toISOString(), instructions: LABEL_INSTRUCTIONS, items: sample.items }, null, 2));
    if (!existsSync(labelsFile)) {
      const template = { week, instructions: LABEL_INSTRUCTIONS, labels: sample.items.map((i) => ({ messageId: i.messageId, n: i.n, expected: [], notes: "" })) };
      writePrivate(labelsFile, JSON.stringify(template, null, 2));
    }
    await audit(rt.db, "audit_sample_export", { detail: { week, count: sample.items.length, seed }, now: ctx.now() });
    const got = (s: AuditStratum) => Object.values(sample.strata).filter((x) => x === s).length;
    ctx.io.out(`Sample ${week} (seed ${seed}): ${AUDIT_STRATA.map((s) => `${s} ${got(s)}/${sample.available[s]}`).join(", ")}`);
    ctx.io.out(`  ${sampleFile}`);
    ctx.io.out(`  ${labelsFile} (fill "expected" blind, then: pnpm cli audit:label --week ${week} ${labelsFile})`);
    ctx.io.err("WARNING: the sample file contains e-mail content. Keep it on this machine, never commit or share it, delete it after labelling.");
  },
};

export const auditLabel: Command = {
  name: "audit:label",
  summary: "Import blind labels (JSON) into message_labels",
  options: {
    week: { type: "string", required: true, arg: "<YYYY-Www>", description: "ISO week of the sample" },
    by: { type: "string", arg: "<email|id>", description: "Labeller (web-app user)" },
  },
  positional: { name: "labels.json", min: 1, max: 1 },
  async run(ctx, args) {
    const rt = await ctx.runtime();
    const week = args.req("week");
    const file = args.positionals[0]!;
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      throw new UsageError(`Cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const labeledBy = args.str("by") ? (await findUser(rt.db, args.str("by")!)).id : null;
    const r = await importAuditLabels(rt.db, data, { week, labeledBy, now: ctx.now() });
    ctx.io.out(`Labels ${week}: ${r.inserted} new, ${r.updated} updated, ${r.skipped.length} skipped.`);
    for (const s of r.skipped) ctx.io.err(`  ${s.messageId}: ${s.reason}`);
  },
};

export const purgeRun: Command = {
  name: "purge:run",
  summary: "Run the retention purge now (the worker runs it nightly at 03:30)",
  options: {},
  async run(ctx) {
    const rt = await ctx.runtime();
    const r = await ctx.services.runRetention(rt.db, ctx.now(), rt.config);
    for (const [k, v] of Object.entries(r)) ctx.io.out(`  ${k.padEnd(24)} ${v}`);
  },
};

export const healthRun: Command = {
  name: "health:run",
  summary: "Run the health checks now and send alerts (as the worker does every 5 minutes)",
  options: { dry: { type: "boolean", description: "Only show the results; no alerts, no state changes" } },
  async run(ctx, args) {
    const rt = await ctx.runtime();
    const ops = ctx.ops();
    const deps = {
      db: rt.db,
      log: rt.log,
      config: rt.config,
      dataDir: existsSync(ops.DATA_DIR) ? ops.DATA_DIR : null,
      backupMarkerFile: ops.BACKUP_MARKER_FILE ?? null,
      ...(args.bool("dry") ? { alert: async () => true } : {}),
    };
    if (args.bool("dry")) {
      const r = await evaluateHealth(deps, ctx.now());
      for (const x of r.results) ctx.io.out(`  ${x.ok ? "ok   " : "ALERT"} ${x.key}${x.ok ? "" : ` — ${x.title}`}`);
      return r.results.some((x) => !x.ok) ? 1 : 0;
    }
    const r = await ctx.services.runHealthChecks(deps, ctx.now());
    for (const x of r.results) ctx.io.out(`  ${x.ok ? "ok   " : "ALERT"} ${x.key}${x.ok ? "" : ` — ${x.title}`}`);
    ctx.io.out(`Alerted ${r.alerted.length}, reminded ${r.reminded.length}, resolved ${r.resolved.length}.`);
    return r.results.some((x) => !x.ok) ? 1 : 0;
  },
};

const DUMP_RE = /^mailme-\d{8}-\d{6}\.dump$/;

export const backupDump: Command = {
  name: "backup:dump",
  summary: "pg_dump (custom format) to BACKUP_DIR, touch BACKUP_MARKER_FILE, prune dumps older than BACKUP_KEEP_DAYS",
  options: { "out-dir": { type: "string", arg: "<dir>", description: "Output directory (default BACKUP_DIR)" } },
  async run(ctx, args) {
    const cfg = ctx.config();
    const ops = ctx.ops();
    if (!/^postgres(ql)?:\/\//.test(cfg.DATABASE_URL)) throw new UsageError("backup:dump needs a PostgreSQL DATABASE_URL (for PGlite, copy its directory while the processes are stopped)");
    const url = new URL(cfg.DATABASE_URL);
    const dir = args.str("out-dir") ?? ops.BACKUP_DIR;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const now = ctx.now();
    const file = path.join(dir, `mailme-${DateTime.fromJSDate(now, { zone: "UTC" }).toFormat("yyyyLLdd-HHmmss")}.dump`);
    // Credentials go through the environment, never the argument list (visible in `ps`).
    const env: NodeJS.ProcessEnv = {
      PGHOST: url.hostname || "localhost",
      PGPORT: url.port || "5432",
      PGDATABASE: decodeURIComponent(url.pathname.replace(/^\//, "")),
      ...(url.username ? { PGUSER: decodeURIComponent(url.username) } : {}),
      ...(url.password ? { PGPASSWORD: decodeURIComponent(url.password) } : {}),
      ...(url.searchParams.get("sslmode") ? { PGSSLMODE: url.searchParams.get("sslmode")! } : {}),
    };
    const r = await ctx.services.exec("pg_dump", ["--format=custom", "--no-owner", "--no-privileges", `--file=${file}`], { env });
    if (r.code !== 0) {
      ctx.io.err(`pg_dump failed (exit ${r.code}): ${r.stderr.trim().split("\n").slice(-3).join(" | ")}`);
      return 1;
    }
    chmodSync(file, 0o600);
    const bytes = statSync(file).size;
    if (ops.BACKUP_MARKER_FILE) writePrivate(ops.BACKUP_MARKER_FILE, JSON.stringify({ at: now.toISOString(), file: path.basename(file), bytes }) + "\n");
    const cutoff = now.getTime() - ops.BACKUP_KEEP_DAYS * 86_400_000;
    let pruned = 0;
    for (const f of readdirSync(dir)) {
      if (!DUMP_RE.test(f) || path.join(dir, f) === file) continue;
      const p = path.join(dir, f);
      if (statSync(p).mtimeMs < cutoff) {
        unlinkSync(p);
        pruned++;
      }
    }
    ctx.io.out(`Backup written: ${file} (${Math.round(bytes / 1024)} KB); pruned ${pruned} old dump(s).`);
    ctx.io.out("Encrypt and copy it off-host (docs/INSTALL.md § Backups). The private credentials key is NOT in the dump.");
  },
};

export const opsCommands: Command[] = [kpi, auditSample, auditLabel, purgeRun, healthRun, backupDump];

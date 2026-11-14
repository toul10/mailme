import { and, eq, inArray } from "drizzle-orm";
import { DateTime } from "luxon";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { messageLabels, messages } from "../db/schema.js";
import type { Segment } from "../domain/types.js";

/**
 * Weekly blind audit: a stratified random sample of ALL messages of an ISO week — including
 * pre-filtered ones — exported for labelling *before* looking at the AI output, and the import of those
 * labels into message_labels. The export contains email content, so it is written only under the
 * (git-ignored) data directory with 0600 permissions. Deny-listed and PERSONAL mail is never sampled.
 */

export const AUDIT_STRATA = ["filtered", "fyi", "actionable"] as const;
export type AuditStratum = (typeof AUDIT_STRATA)[number];

export const DEFAULT_AUDIT_COUNTS: Record<AuditStratum, number> = { filtered: 15, fyi: 15, actionable: 20 };

const QUOTED_CAP = 1000;

export interface AuditItem {
  /** Position in the (shuffled) sample; the stratum is deliberately not shown. */
  n: number;
  messageId: string;
  date: string;
  direction: string;
  from: string | null;
  to: string[];
  cc: string[];
  subject: string;
  attachments: string[];
  segments: Array<{ id: string; kind: string; text: string }>;
  bodyPurged: boolean;
}

/** "2026-W39" → [Monday 00:00, next Monday 00:00) in `zone`. */
export function isoWeekRange(week: string, zone: string): { from: Date; to: Date } {
  if (!/^\d{4}-W\d{2}$/.test(week)) throw new Error(`Invalid week "${week}" (expected YYYY-Www, e.g. 2026-W39)`);
  const start = DateTime.fromISO(`${week}-1`, { zone });
  if (!start.isValid) throw new Error(`Invalid week "${week}"`);
  return { from: start.startOf("day").toJSDate(), to: start.plus({ weeks: 1 }).startOf("day").toJSDate() };
}

export function stratumOf(m: { state: string; classification: string | null; filterReason: string | null }): AuditStratum | null {
  if (m.filterReason === "DENYLIST" || m.classification === "PERSONAL") return null;
  if (m.state === "filtered") return "filtered";
  if (m.state === "failed") return "actionable";
  if (m.state === "applied") return m.classification === "ACTIONABLE" ? "actionable" : "fyi";
  return null;
}

/** Deterministic PRNG (mulberry32) so a sample can be reproduced from its seed. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(xs: T[], rnd: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export interface AuditSample {
  week: string;
  seed: number;
  items: AuditItem[];
  /** Stratum per message id — kept out of the labelling file (blind). */
  strata: Record<string, AuditStratum>;
  available: Record<AuditStratum, number>;
}

export async function sampleForAudit(
  db: Db,
  opts: { week: string; zone: string; counts?: Partial<Record<AuditStratum, number>>; seed: number; mailboxId?: string | null },
): Promise<AuditSample> {
  const { from, to } = isoWeekRange(opts.week, opts.zone);
  const counts = { ...DEFAULT_AUDIT_COUNTS, ...opts.counts };
  const rnd = seededRandom(opts.seed);
  const candidates = await db
    .select({ id: messages.id, state: messages.state, classification: messages.classification, filterReason: messages.filterReason, sortTs: messages.sortTs })
    .from(messages)
    .where(
      and(
        inArray(messages.state, ["filtered", "applied", "failed"]),
        opts.mailboxId ? eq(messages.mailboxId, opts.mailboxId) : undefined,
      ),
    );
  const byStratum: Record<AuditStratum, string[]> = { filtered: [], fyi: [], actionable: [] };
  for (const c of candidates) {
    if (c.sortTs < from || c.sortTs >= to) continue;
    const s = stratumOf(c);
    if (s) byStratum[s].push(c.id);
  }
  // Sort before shuffling so the same seed reproduces the same sample regardless of row order.
  const strata: Record<string, AuditStratum> = {};
  for (const s of AUDIT_STRATA) {
    for (const id of shuffle(byStratum[s].sort(), rnd).slice(0, Math.max(0, counts[s]))) strata[id] = s;
  }
  const ids = shuffle(Object.keys(strata).sort(), rnd);
  const rows = ids.length ? await db.select().from(messages).where(inArray(messages.id, ids)) : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const items: AuditItem[] = ids.map((id, i) => {
    const m = byId.get(id)!;
    return {
      n: i + 1,
      messageId: m.id,
      date: DateTime.fromJSDate(m.sortTs, { zone: opts.zone }).toFormat("yyyy-LL-dd HH:mm"),
      direction: m.direction,
      from: m.fromAddress ? (m.fromName ? `${m.fromName} <${m.fromAddress}>` : m.fromAddress) : null,
      to: m.to.map((a) => a.address),
      cc: m.cc.map((a) => a.address),
      subject: m.subject,
      attachments: m.attachments.map((a) => a.filename),
      segments: (m.segments as Segment[]).map((sg) => ({
        id: sg.id,
        kind: sg.kind,
        text: sg.kind === "QUOTED" && sg.text.length > QUOTED_CAP ? sg.text.slice(0, QUOTED_CAP) + "…" : sg.text,
      })),
      bodyPurged: m.bodyPurgedAt !== null,
    };
  });
  return {
    week: opts.week,
    seed: opts.seed,
    items,
    strata,
    available: { filtered: byStratum.filtered.length, fyi: byStratum.fyi.length, actionable: byStratum.actionable.length },
  };
}

export const LABEL_INSTRUCTIONS =
  "Blind labelling: for each message in the sample file write the tasks it SHOULD produce, before looking at MailMe's output. " +
  'expected = [] means "no task". Each expected task: { "title": "<Company> — <verb> <object>", ' +
  '"status": "ACTION_REQUIRED|WAITING_FOR_ME|WAITING_FOR_OTHER", "owner": "ME|INTERNAL|EXTERNAL", "due": "YYYY-MM-DD" | null }. ' +
  "Import with: pnpm cli audit:label --week <week> <this file>. Delete the sample file afterwards.";

const LabelEntry = z.object({
  messageId: z.string().uuid(),
  expected: z.array(z.record(z.string(), z.unknown())),
  verdict: z.unknown().optional(),
  notes: z.string().nullable().optional(),
});
const LabelFile = z.union([z.array(LabelEntry), z.object({ week: z.string().optional(), labels: z.array(LabelEntry) })]);

export interface LabelImportReport {
  inserted: number;
  updated: number;
  skipped: Array<{ messageId: string; reason: string }>;
}

/** Import labels (idempotent per message + week: re-importing updates). The stratum is recomputed from the DB. */
export async function importAuditLabels(db: Db, input: unknown, opts: { week: string; labeledBy?: string | null; now: Date }): Promise<LabelImportReport> {
  const parsed = LabelFile.safeParse(input);
  if (!parsed.success) throw new Error(`Invalid labels file: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const entries = Array.isArray(parsed.data) ? parsed.data : parsed.data.labels;
  const report: LabelImportReport = { inserted: 0, updated: 0, skipped: [] };
  await db.transaction(async (tx) => {
    for (const e of entries) {
      const [m] = await tx
        .select({ id: messages.id, state: messages.state, classification: messages.classification, filterReason: messages.filterReason })
        .from(messages)
        .where(eq(messages.id, e.messageId));
      if (!m) {
        report.skipped.push({ messageId: e.messageId, reason: "message not found" });
        continue;
      }
      const values = {
        expected: e.expected,
        verdict: e.verdict ?? null,
        notes: e.notes ?? null,
        stratum: stratumOf(m),
        labeledBy: opts.labeledBy ?? null,
      };
      const [existing] = await tx
        .select({ id: messageLabels.id })
        .from(messageLabels)
        .where(and(eq(messageLabels.messageId, e.messageId), eq(messageLabels.sampleWeek, opts.week)));
      if (existing) {
        await tx.update(messageLabels).set(values).where(eq(messageLabels.id, existing.id));
        report.updated++;
      } else {
        await tx.insert(messageLabels).values({ messageId: e.messageId, sampleWeek: opts.week, createdAt: opts.now, ...values });
        report.inserted++;
      }
    }
  });
  return report;
}

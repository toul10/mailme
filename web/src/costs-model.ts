/**
 * "AI costs" (screens/AiCosts.tsx), pure: amounts as text, the chart's series and scale, and the sums the page
 * leads with. Runs under vitest.
 */
import { GEMINI_LAUNCH_PRICES, GEMINI_PRICING } from "../../src/ai/pricing.js";
import type { AiCostDay, AiCosts } from "../../src/server/api-types.js";
import { addDays } from "./format.js";

const NUMBER = new Map<number, Intl.NumberFormat>();
function numberFormat(digits: number): Intl.NumberFormat {
  let f = NUMBER.get(digits);
  if (!f) NUMBER.set(digits, (f = new Intl.NumberFormat("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })));
  return f;
}

/** "$14.85"; `digits` 3 for a cost per email ("$0.010"); "< $0.01" for a cost too small to show. */
export function formatUsd(v: number, digits = 2): string {
  const value = Number.isFinite(v) ? v : 0;
  const least = 10 ** -digits;
  if (value > 0 && value < least) return `< $${numberFormat(digits).format(least)}`;
  return `$${numberFormat(digits).format(value)}`;
}

/** Model ids as their makers write them; an unknown id as it is. */
const MODEL_LABELS: Record<string, string> = {
  "claude-opus-5-5": "Claude Opus 5.5",
  "claude-opus-5": "Claude Opus 5",
  "claude-opus-4-8": "Claude Opus 4.8",
  "claude-sonnet-5": "Claude Sonnet 5",
  "claude-haiku-4-5": "Claude Haiku 4.5",
  "gemini-3.5-flash-lite": "Gemini 3.5 Flash-Lite",
  "gemini-3.6-flash": "Gemini 3.6 Flash",
  "gemini-3.8-flash": "Gemini 3.8 Flash",
  "gemini-4-hydrogen": "Gemini 4 Hydrogen",
  "gemini-4-neon": "Gemini 4 Neon",
  "gemini-4-argon": "Gemini 4 Argon",
  "gemini-4-carbon": "Gemini 4 Carbon",
};
export const modelLabel = (id: string): string => MODEL_LABELS[id] ?? id;

/**
 * Where a model's stored cost comes from (src/ai/pricing.ts and the adapters): `table`, the provider's published
 * price (Claude: an unlisted model at the default model's rates); `reported`, the provider's own figure (xAI reports
 * the cost of each call); `ceiling`, MailMe's deliberately high rates for a model without a known price (OpenAI, a
 * Gemini model missing from the table), which shows more than the bill.
 */
export function priceSource(model: string): "table" | "reported" | "ceiling" {
  const id = model.trim().toLowerCase();
  if (id.startsWith("claude")) return "table";
  if (Object.hasOwn(GEMINI_PRICING, id)) return "table";
  if (id.startsWith("grok")) return "reported";
  return "ceiling";
}

/** A launch price still in force for a model in use: billed at `factor` of the later price up to `lastDay`. */
export interface LaunchPrice {
  model: string;
  factor: number;
  /** The last day at the launch price, and the first at the full one (YYYY-MM-DD, UTC). */
  lastDay: string;
  from: string;
}

/** The launch prices (src/ai/pricing.ts) that still apply at `now` to one of `models`, once each. */
export function launchPricesInUse(models: readonly string[], now: Date): LaunchPrice[] {
  return GEMINI_LAUNCH_PRICES.filter((p) => Date.parse(p.until) > now.getTime() && models.includes(p.model)).map((p) => {
    const from = p.until.slice(0, 10);
    return { model: p.model, factor: p.factor, from, lastDay: addDays(from, -1) };
  });
}

/** One stacked series of the daily chart; `slot` is its colour (--cost-s1 … --cost-s8 in styles.css). */
export interface CostSeries {
  key: string;
  label: string;
  slot: number;
}

/**
 * Colours follow the mailbox, by its place in the list; slot 3 is always the chat's, slot 8 (grey) the folded rest.
 * The slots are the dataviz reference palette, whose order is what keeps neighbours in a stack apart for colour-blind
 * readers, so the series are stacked (and listed) by slot.
 */
const MAILBOX_SLOTS = [1, 2, 4, 5, 6, 7];
export const CHAT_SERIES = "chat";
export const OTHER_SERIES = "other";

/** The mailboxes ("Other mailboxes" past six) and the chat, by slot; only series with a cost in the window are drawn. */
export function costSeries(c: Pick<AiCosts, "mailboxes" | "days">, names: ReadonlyMap<string, string>): CostSeries[] {
  const out: CostSeries[] = [];
  c.mailboxes.slice(0, MAILBOX_SLOTS.length).forEach((m, i) => {
    if (c.days.some((d) => (d.mail[m.id] ?? 0) > 0)) out.push({ key: m.id, label: names.get(m.id) ?? m.address, slot: MAILBOX_SLOTS[i]! });
  });
  const rest = new Set(c.mailboxes.slice(MAILBOX_SLOTS.length).map((m) => m.id));
  if (c.days.some((d) => Object.entries(d.mail).some(([id, v]) => rest.has(id) && v > 0))) out.push({ key: OTHER_SERIES, label: "Other mailboxes", slot: 8 });
  if (c.days.some((d) => d.chat > 0)) out.push({ key: CHAT_SERIES, label: "Ask your mail", slot: 3 });
  return out.sort((a, b) => a.slot - b.slot);
}

/** A series' amount on one day. */
export function seriesValue(day: AiCostDay, s: CostSeries, shown: ReadonlySet<string>): number {
  if (s.key === CHAT_SERIES) return day.chat;
  if (s.key === OTHER_SERIES) return Object.entries(day.mail).reduce((n, [id, v]) => (shown.has(id) ? n : n + v), 0);
  return day.mail[s.key] ?? 0;
}

export const dayTotal = (d: AiCostDay): number => Object.values(d.mail).reduce((n, v) => n + v, 0) + d.chat;

export interface CostSum {
  mail: number;
  chat: number;
  mails: number;
  questions: number;
}

/** The days from `from` (YYYY-MM-DD, inclusive) on, added up. */
export function sumDays(days: readonly AiCostDay[], from = ""): CostSum {
  const out: CostSum = { mail: 0, chat: 0, mails: 0, questions: 0 };
  for (const d of days) {
    if (d.date < from) continue;
    out.mail += Object.values(d.mail).reduce((n, v) => n + v, 0);
    out.chat += d.chat;
    out.mails += d.mails;
    out.questions += d.questions;
  }
  return out;
}

/** One mailbox's mail cost from `from` (YYYY-MM-DD, inclusive) on. */
export function mailboxSince(days: readonly AiCostDay[], id: string, from = ""): number {
  return days.reduce((n, d) => (d.date >= from ? n + (d.mail[id] ?? 0) : n), 0);
}

/** A y axis of round steps (1, 2, 2.5, 5 × 10ⁿ) from 0 to at least `max`, with about `target` steps. */
export function niceScale(max: number, target = 4): { top: number; ticks: number[] } {
  if (!(max > 0) || !Number.isFinite(max)) return { top: 1, ticks: [0, 0.5, 1] };
  const raw = max / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((f) => f * mag).find((st) => st >= raw - 1e-12)!;
  const top = Math.ceil(max / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(Math.round(v * 1e9) / 1e9);
  return { top: Math.round(top * 1e9) / 1e9, ticks };
}

/** An axis label: "$0", "$2", "$0.5". */
export function formatTick(v: number): string {
  return v === 0 ? "$0" : `$${numberFormat(Number.isInteger(v) ? 0 : v < 0.1 ? 2 : 1).format(v)}`;
}

/** The columns that carry their total above them: the highest, and today when it is not right next to it. */
export function cappedDays(totals: readonly number[]): Set<number> {
  const out = new Set<number>();
  if (!totals.length) return out;
  const max = Math.max(...totals);
  const last = totals.length - 1;
  if (max > 0) out.add(totals.lastIndexOf(max));
  if (totals[last]! > 0 && [...out].every((i) => last - i >= 4)) out.add(last);
  return out;
}

/** Which days get a date under the axis: all of a short run, else the first, every 7th back from today, and today. */
export function labelledDays(days: readonly AiCostDay[]): Set<number> {
  if (days.length <= 10) return new Set(days.map((_, i) => i));
  const out = new Set<number>([0]);
  for (let i = days.length - 1; i >= 0; i -= 7) out.add(i);
  // Not a label crowding the first one.
  for (const i of out) if (i !== 0 && i < 3) out.delete(i);
  return out;
}

/** Cost per message of the model used last; null before any. */
export function perMail(c: Pick<AiCosts, "models">): { model: string; usd: number } | null {
  const m = c.models[0];
  return m && m.mails > 0 ? { model: m.model, usd: m.usd / m.mails } : null;
}

/** The share of a cap used, 0…1 and over; caps of 0 count as used up. */
export function share(used: number, cap: number): number {
  return cap > 0 ? used / cap : 1;
}

/** Meter colour: the accent, then warn from 80%, danger when used up. */
export function meterTone(fraction: number): "ok" | "warn" | "danger" {
  return fraction >= 1 ? "danger" : fraction >= 0.8 ? "warn" : "ok";
}

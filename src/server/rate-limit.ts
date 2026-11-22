/**
 * In-memory token buckets (a single API process). One bucket per (group, key), refilled
 * continuously: `capacity` requests per `windowMs`.
 */
export interface RateRule {
  capacity: number;
  windowMs: number;
}

export const RATE_RULES = {
  login: { capacity: 10, windowMs: 15 * 60_000 },
  totp: { capacity: 10, windowMs: 15 * 60_000 },
  /** One-time setup links (check + use): guessing a 256-bit token is hopeless, this only caps noise. */
  setup: { capacity: 10, windowMs: 15 * 60_000 },
  oneClick: { capacity: 30, windowMs: 60_000 },
  ingest: { capacity: 120, windowMs: 60_000 },
  /** Mailbox credential probes: each one is a real IMAP login against the shared host's ban budget. */
  probe: { capacity: 5, windowMs: 15 * 60_000 },
  probeMailbox: { capacity: 3, windowMs: 15 * 60_000 },
  /** Admin → AI: listing a pasted key's models (fires as the admin types; each one is a provider call). */
  aiModels: { capacity: 30, windowMs: 15 * 60_000 },
  /** Chat questions per user (each one is several paid model calls); the daily limits are in src/chat/usage.ts. */
  chat: { capacity: 20, windowMs: 10 * 60_000 },
} as const satisfies Record<string, RateRule>;

export type RateGroup = keyof typeof RATE_RULES;

interface Bucket {
  tokens: number;
  updatedMs: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private ops = 0;

  constructor(private readonly nowMs: () => number) {}

  /** Take one token. `retryAfterSec` is set when refused. */
  take(group: RateGroup, key: string): { ok: boolean; retryAfterSec: number } {
    const rule = RATE_RULES[group];
    const now = this.nowMs();
    const id = `${group}|${key}`;
    const rate = rule.capacity / rule.windowMs;
    const b = this.buckets.get(id) ?? { tokens: rule.capacity, updatedMs: now };
    b.tokens = Math.min(rule.capacity, b.tokens + Math.max(0, now - b.updatedMs) * rate);
    b.updatedMs = now;
    this.buckets.set(id, b);
    if (++this.ops % 1000 === 0) this.prune(now);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { ok: true, retryAfterSec: 0 };
    }
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((1 - b.tokens) / rate / 1000)) };
  }

  /** Drop buckets that have refilled completely (they carry no state). */
  private prune(now: number): void {
    for (const [id, b] of this.buckets) {
      const group = id.slice(0, id.indexOf("|")) as RateGroup;
      const rule = RATE_RULES[group];
      if (b.tokens + (now - b.updatedMs) * (rule.capacity / rule.windowMs) >= rule.capacity) this.buckets.delete(id);
    }
  }

  get size(): number {
    return this.buckets.size;
  }
}

import type { Logger } from "../domain/types.js";
import type { DrainReport } from "../engine/pipeline.js";
import { errorCode } from "../ops/alerts.js";

/**
 * Per-mailbox drain coordination for the worker. Drains are started fire-and-forget (the IMAP watcher's
 * onCycle must return quickly), coalesced (a request during a running drain re-runs it once afterwards
 * with the newest fullCycleAt), and cut into small batches so a shutdown waits for the current message
 * only — drainMailbox itself is advisory-locked per mailbox.
 */

export type DrainFn = (mailboxId: string, opts: { maxMessages: number; fullCycleAt: Date }) => Promise<DrainReport>;

export interface DrainCoordinatorOptions {
  drain: DrainFn;
  log: Logger;
  /** Messages per drainMailbox call (shutdown granularity). Default 1. */
  batchSize?: number;
  /** Safety valve against a drain that reports progress forever. Default 1000 batches per run. */
  maxBatchesPerRun?: number;
}

export interface DrainCoordinator {
  /** Drain a mailbox up to `fullCycleAt`. Resolves when this request (or the run it was merged into) is done. */
  request(mailboxId: string, fullCycleAt: Date): Promise<void>;
  /** Stop starting new batches; running batches finish. */
  stop(): void;
  /** Resolves when no drain is running. */
  idle(): Promise<void>;
  active(): string[];
}

interface MailboxDrain {
  running: Promise<void>;
  /** Newest fullCycleAt requested while running → one more run afterwards. */
  next: Date | null;
}

export function createDrainCoordinator(opts: DrainCoordinatorOptions): DrainCoordinator {
  const batch = opts.batchSize ?? 1;
  const maxBatches = opts.maxBatchesPerRun ?? 1000;
  const state = new Map<string, MailboxDrain>();
  let stopping = false;

  const runOnce = async (mailboxId: string, fullCycleAt: Date) => {
    for (let i = 0; i < maxBatches && !stopping; i++) {
      let r: DrainReport;
      try {
        r = await opts.drain(mailboxId, { maxMessages: batch, fullCycleAt });
      } catch (err) {
        opts.log.error({ mailboxId, code: errorCode(err) }, "drain failed");
        return;
      }
      if (r.lockBusy || r.transientBackoff || r.globalPause || r.budgetPaused || r.processed < batch) return;
    }
  };

  const start = (mailboxId: string, fullCycleAt: Date): Promise<void> => {
    const entry: MailboxDrain = { running: Promise.resolve(), next: null };
    entry.running = (async () => {
      let at: Date | null = fullCycleAt;
      while (at && !stopping) {
        await runOnce(mailboxId, at);
        at = entry.next;
        entry.next = null;
      }
    })().finally(() => {
      if (state.get(mailboxId) === entry) state.delete(mailboxId);
    });
    state.set(mailboxId, entry);
    return entry.running;
  };

  return {
    request(mailboxId, fullCycleAt) {
      if (stopping) return Promise.resolve();
      const cur = state.get(mailboxId);
      if (cur) {
        if (!cur.next || cur.next.getTime() < fullCycleAt.getTime()) cur.next = fullCycleAt;
        return cur.running;
      }
      return start(mailboxId, fullCycleAt);
    },
    stop() {
      stopping = true;
    },
    async idle() {
      while (state.size > 0) await Promise.allSettled([...state.values()].map((s) => s.running));
    },
    active() {
      return [...state.keys()];
    },
  };
}

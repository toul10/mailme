import type { Logger } from "../domain/types.js";
import type { SyncReport } from "../mail/imap/sync.js";
import { errorCode } from "../ops/alerts.js";
import { waitAtMost } from "./scheduler.js";

/**
 * Keeps exactly one IMAP watcher per active mailbox: `reconcile(ids)` starts watchers for newly active
 * mailboxes and stops those that were paused, failed auth or were disabled.
 */

export type StartWatcherFn = (mailboxId: string, hooks: { onCycle(report: SyncReport): void | Promise<void> }) => { stop(): Promise<void> };

export interface WatcherManager {
  reconcile(activeIds: string[]): Promise<{ started: string[]; stopped: string[] }>;
  stopAll(timeoutMs?: number): Promise<void>;
  running(): string[];
}

export function createWatcherManager(opts: { start: StartWatcherFn; onCycle(report: SyncReport): void; log: Logger; stopTimeoutMs?: number }): WatcherManager {
  const watchers = new Map<string, { stop(): Promise<void> }>();
  const stopTimeout = opts.stopTimeoutMs ?? 30_000;

  const stopOne = async (id: string) => {
    const w = watchers.get(id);
    watchers.delete(id);
    if (!w) return;
    try {
      const done = await waitAtMost(w.stop(), stopTimeout);
      if (!done) opts.log.warn({ mailboxId: id }, "watcher did not stop in time");
    } catch (err) {
      opts.log.warn({ mailboxId: id, code: errorCode(err) }, "watcher stop failed");
    }
  };

  return {
    async reconcile(activeIds) {
      const want = new Set(activeIds);
      const stopped = [...watchers.keys()].filter((id) => !want.has(id));
      await Promise.all(stopped.map(stopOne));
      const started: string[] = [];
      for (const id of want) {
        if (watchers.has(id)) continue;
        try {
          // The watcher awaits onCycle before its next cycle, so the hook only schedules work.
          watchers.set(id, opts.start(id, { onCycle: (r) => opts.onCycle(r) }));
          started.push(id);
        } catch (err) {
          opts.log.error({ mailboxId: id, code: errorCode(err) }, "watcher start failed; retrying on next refresh");
        }
      }
      if (started.length || stopped.length) opts.log.info({ started: started.length, stopped: stopped.length, running: watchers.size }, "mailbox watchers updated");
      return { started, stopped };
    },
    async stopAll(timeoutMs) {
      const ids = [...watchers.keys()];
      const all = Promise.all(ids.map(stopOne));
      await (timeoutMs === undefined ? all : waitAtMost(all, timeoutMs));
    },
    running() {
      return [...watchers.keys()];
    },
  };
}

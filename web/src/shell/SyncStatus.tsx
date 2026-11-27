/**
 * The sync bar: what the worker is doing now (sync-status.ts), in the rail, as a strip under the phone's top bar
 * while something happens, and per mailbox in "System status". The shell reads /api/health every 5 seconds while
 * the worker is at work (App.tsx), so the bar moves as the AI works through a queue.
 */
import type { MailboxActivity } from "../../../src/server/api-types.js";
import { routeHref } from "../router.js";
import { mailboxActivityLine, mailboxActivityState, type SyncContext, type SyncView } from "../sync-status.js";

/** A thin bar: filled to `progress`, or moving when there is nothing to count. */
export function SyncBar({ progress, label, className }: { progress: number | "busy"; label: string; className?: string }) {
  const cls = `sync-bar${progress === "busy" ? " is-busy" : ""}${className ? ` ${className}` : ""}`;
  if (progress === "busy") return <span className={cls} role="progressbar" aria-label={label} />;
  const pct = Math.max(0, Math.min(100, Math.round(progress * 100)));
  return (
    <span className={cls} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
      {/* At least a sliver, so a bar that has just started reads as started. */}
      <span className="sync-bar-fill" style={{ width: `${Math.max(pct, 3)}%` }} />
    </span>
  );
}

/** The rail's sync light: title, detail and bar; a link to "System status" in Settings. */
export function SyncRail({ view }: { view: SyncView }) {
  return (
    <a className={`side-sync is-${view.tone}`} href={routeHref({ name: "settings" })}>
      <span className="pulse" aria-hidden="true" />
      <span className="side-sync-text">
        <span className="side-sync-title">{view.title}</span>
        {view.detail ? <span className="side-sync-detail">{view.detail}</span> : null}
        {view.progress !== null ? <SyncBar progress={view.progress} label={view.title} /> : null}
      </span>
    </a>
  );
}

/** On a phone: a strip under the top bar while the worker is at work, or when something stopped; nothing when all is well. */
export function SyncStrip({ view }: { view: SyncView }) {
  if (view.tone !== "live" && view.tone !== "warn" && view.tone !== "error") return null;
  return (
    <a className={`mstrip is-${view.tone}`} href={routeHref({ name: "settings" })}>
      <span className="pulse" aria-hidden="true" />
      <span className="mstrip-text">
        <strong>{view.title}</strong>
        {view.detail ? <span className="mstrip-detail">{view.detail}</span> : null}
      </span>
      {view.progress !== null ? <SyncBar progress={view.progress} label={view.title} className="mstrip-bar" /> : null}
    </a>
  );
}

/** "System status": the same words, then one row per mailbox with its own bar while the AI reads it. */
export function SyncActivityPanel({ view, mailboxes, ctx }: { view: SyncView; mailboxes: MailboxActivity[]; ctx: SyncContext }) {
  return (
    <div className="activity">
      <div className={`activity-head is-${view.tone}`} role="status">
        <span className="activity-dot" aria-hidden="true" />
        <span className="activity-text">
          <strong>{view.title}</strong>
          {view.detail ? <span className="muted small">{view.detail}</span> : null}
        </span>
      </div>
      {view.progress !== null ? <SyncBar progress={view.progress} label={view.title} className="activity-bar" /> : null}
      {mailboxes.length > 0 ? (
        <ul className="activity-list">
          {mailboxes.map((m) => {
            const state = mailboxActivityState(m);
            const total = m.done + m.queued;
            return (
              <li key={m.id} className="activity-row">
                <span className="activity-address">{m.address}</span>
                <span className={`chip activity-chip is-${state.tone}`}>{state.label}</span>
                <span className="activity-line muted small">{mailboxActivityLine(m, ctx)}</span>
                {m.analysing && total > 0 ? (
                  <span className="activity-progress">
                    <SyncBar progress={m.done / total} label={`${m.address}: ${m.done} of ${total}`} className="activity-bar" />
                    <span className="small">
                      {m.done} of {total}
                    </span>
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

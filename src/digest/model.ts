/** Digest data model. Pure data: rendering is separate. */
export type DigestSectionKey = "today" | "promises" | "followup" | "new" | "autoClosed" | "stillValid" | "problems";

export interface DigestItem {
  taskId: string;
  ref: number;
  title: string;
  company: string | null;
  nextAction: string | null;
  status: string;
  dueDate: string | null;
  duePhrase: string | null;
  overdueDays: number | null;
  businessDaysWaiting: number | null;
  subject: string | null;
  sender: string | null;
  lastMessageDate: string | null;
  needsReview: boolean;
  tags: string[];
}

export interface DigestProblem {
  kind: "not_analyzed" | "bounce" | "auth_failed" | "stale" | "paused";
  text: string;
}

export interface Freshness {
  lastSyncAt: Date | null;
  staleMinutes: number | null;
  pendingCount: number;
  oldestPendingMinutes: number | null;
  failedCount: number;
  paused: boolean;
  /** Red banner text or null. */
  banner: string | null;
}

export interface DigestModel {
  userId: string;
  userName: string;
  /** Org IANA timezone (formatting of times in the report). */
  zone: string;
  localDate: string;
  weekdayLabel: string;
  late: boolean;
  freshness: Freshness;
  counts: { openTotal: number; actionToday: number; waiting: number; overdue: number };
  sections: Record<DigestSectionKey, { items: DigestItem[]; more: number }>;
  problems: DigestProblem[];
  isEmpty: boolean;
  /** Blocks from the owner's own rules (src/digest/rule-blocks.ts); absent when the owner has none of those rules. */
  rules?: DigestRuleBlocks;
}

/** "Summary", "Answered", "Updates": what happened since the previous report, per the owner's rules. */
export interface DigestRuleBlocks {
  /** summary rule: the period in numbers; null without that rule. */
  summary: { received: number; newTasks: number; answered: number; updates: number; ignored: number; openTotal: number } | null;
  /** answered rule: tasks someone at the organization answered (completed by the rule). */
  answered: Array<{ taskId: string; ref: number; title: string; by: string | null }>;
  answeredMore: number;
  /** updates rule: the owner's own announcements ("New arrivals" …). */
  updates: Array<{ subject: string; recipients: number; at: Date }>;
  updatesMore: number;
}

export interface LinkFactory {
  /** Signed single-use one-click link (confirm page → POST). */
  action(taskId: string, action: "complete" | "dismiss" | "snooze" | "confirm" | "reopen" | "still_valid"): Promise<string>;
  /** Link to the task page in the web app (login required). */
  task(taskId: string): string;
  list(tab: "todo" | "waiting" | "all"): string;
}

/**
 * The per-mailbox view. A user with two or more mailboxes sees everything together (the default) or, when they
 * choose, one mailbox at a time: its tasks, what the AI asks about them, the counts, and what the chat reads.
 *
 * The choice is this tab's: it survives a reload and is gone with the tab, so a view chosen last week never hides
 * today's tasks. What is remembered is a mailbox id, never content. The server accepts only a mailbox of the session
 * user (`?mailbox=`, src/server/queries.ts: ownMailboxId); a view it no longer knows is dropped here.
 *
 * No DOM: the storage is injected (the tab's session storage in the browser, a Map in tests).
 */
import type { OwnMailbox } from "../../src/server/api-types.js";
import type { KeyValueStore } from "./api.js";

export const VIEW_KEY_PREFIX = "mailme.mailboxView.";
/** A view means something only for a user with at least this many mailboxes. */
export const VIEW_MIN_MAILBOXES = 2;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const cleanId = (id: string | null | undefined): string | null => (id && UUID_RE.test(id) ? id.toLowerCase() : null);

export class MailboxViewStore {
  private id: string | null = null;
  private owner: string | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly storage: KeyValueStore | null) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  /** The id of the mailbox everything is about; null for all of them. */
  readonly getSnapshot = (): string | null => this.id;

  /** The signed-in user: their choice in this tab is read back; another user's is never used. */
  bindUser(userId: string): void {
    if (this.owner === userId) return;
    this.owner = userId;
    this.replace(this.read(userId));
  }

  /** Chooses one mailbox, or all of them (null). */
  set(id: string | null): void {
    const next = cleanId(id);
    if (this.owner) this.write(this.owner, next);
    this.replace(next);
  }

  /**
   * The user's mailboxes as the server lists them now: a view of a mailbox that is not among them, or a view left
   * from when they had several, is dropped — a list must never stay narrowed to something the user cannot switch off.
   */
  reconcile(own: readonly OwnMailbox[]): void {
    if (this.id !== null && !viewOf(own, this.id)) this.set(null);
  }

  private replace(id: string | null): void {
    if (id === this.id) return;
    this.id = id;
    for (const l of this.listeners) l();
  }

  private read(userId: string): string | null {
    try {
      return cleanId(this.storage?.getItem(VIEW_KEY_PREFIX + userId));
    } catch {
      return null;
    }
  }

  private write(userId: string, id: string | null): void {
    try {
      if (id) this.storage?.setItem(VIEW_KEY_PREFIX + userId, id);
      else this.storage?.removeItem(VIEW_KEY_PREFIX + userId);
    } catch {
      // Storage may be unavailable (private mode): the choice then lasts until the page is reloaded.
    }
  }
}

/** Whether the user has enough mailboxes for a view to mean something (and for the switch to be shown). */
export function hasViews(own: readonly OwnMailbox[]): boolean {
  return own.length >= VIEW_MIN_MAILBOXES;
}

/** The mailbox a view id stands for; null when there is no view, or it is not one this user can choose. */
export function viewOf(own: readonly OwnMailbox[], viewId: string | null): OwnMailbox | null {
  if (!viewId || !hasViews(own)) return null;
  return own.find((m) => m.id === viewId) ?? null;
}

/**
 * What each mailbox is called on screen: the name the user gave it, else its address. Two mailboxes with the same
 * name are called by their addresses, so that a name always tells one mailbox from the others.
 */
export function mailboxNames(own: readonly OwnMailbox[]): Map<string, string> {
  const wanted = own.map((m) => m.displayName?.trim() || m.address);
  const fold = (s: string) => s.toLocaleLowerCase("el");
  const seen = new Map<string, number>();
  for (const name of wanted) seen.set(fold(name), (seen.get(fold(name)) ?? 0) + 1);
  return new Map(own.map((m, i) => [m.id, (seen.get(fold(wanted[i]!)) ?? 0) > 1 ? m.address : wanted[i]!]));
}

/**
 * The part of each name that is enough where room is short (the switch on a phone, the rail): for mailboxes called by
 * their addresses at one shared domain, what is before the "@". Every short name is the start of the full one, and
 * they still tell the mailboxes apart — otherwise the full names are returned.
 */
export function mailboxShortNames(own: readonly OwnMailbox[]): Map<string, string> {
  const names = mailboxNames(own);
  const byAddress = own.filter((m) => names.get(m.id) === m.address && m.address.lastIndexOf("@") > 0);
  const domains = new Set(byAddress.map((m) => m.address.slice(m.address.lastIndexOf("@")).toLowerCase()));
  if (domains.size !== 1) return names;
  const cut = new Set(byAddress.map((m) => m.id));
  const short = new Map(own.map((m) => [m.id, cut.has(m.id) ? m.address.slice(0, m.address.lastIndexOf("@")) : (names.get(m.id) ?? m.address)]));
  const distinct = new Set([...short.values()].map((s) => s.toLocaleLowerCase("el"))).size === short.size;
  return distinct ? short : names;
}

/** The name of one mailbox (see {@link mailboxNames}); null when it is not one of the user's. */
export function mailboxName(own: readonly OwnMailbox[], id: string | null | undefined): string | null {
  return id ? (mailboxNames(own).get(id) ?? null) : null;
}

/**
 * The mailbox named on a task's row or on a question of the AI: only for a user with several mailboxes who looks at
 * all of them together — inside a view every row is of the same mailbox, and the switch already says which.
 */
export function rowMailboxName(own: readonly OwnMailbox[], viewId: string | null, mailboxId: string | null | undefined): string | null {
  if (!mailboxId || !hasViews(own) || viewOf(own, viewId)) return null;
  return mailboxName(own, mailboxId);
}

/** The mailbox a new task is offered first: the one being looked at; none when all of them are. */
export function newTaskMailbox(own: readonly OwnMailbox[], viewId: string | null): string {
  return viewOf(own, viewId)?.id ?? "";
}

/** The mailbox a new task is sent with: the chosen one while it is still the user's, else none (the server decides). */
export function chosenMailbox(own: readonly OwnMailbox[], choice: string): string | null {
  return hasViews(own) && own.some((m) => m.id === choice) ? choice : null;
}

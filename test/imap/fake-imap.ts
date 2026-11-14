import { EventEmitter } from "node:events";
import type {
  AppendResponseObject,
  DownloadObject,
  ExistsEvent,
  FetchBodyPartQuery,
  FetchMessageObject,
  FetchQueryObject,
  ListResponse,
  MailboxObject,
  MessageStructureObject,
  NamespaceObject,
  QuotaResponse,
  SearchObject,
  StatusObject,
  StatusQuery,
} from "imapflow";
import type { ImapClientLike, ImapConnectOptions } from "../../src/mail/imap/client.js";

/**
 * In-memory IMAP server + client implementing ImapClientLike. It records every call, rejects non-read-only
 * opens, and emulates the real `N:*` quirk (a range starting above the highest UID returns the last message).
 */

export interface FakeMessage {
  uid: number;
  raw: Buffer;
  flags?: string[];
  internalDate: Date;
  /** Date header for SENTSINCE (defaults to internalDate). */
  date?: Date;
  /** RFC822.SIZE override (large-message path). */
  size?: number;
  bodyStructure?: MessageStructureObject;
  /** Section key (lower-case, e.g. "1.1", "text", "2.header") → bytes, for BODY.PEEK[section]. */
  parts?: Record<string, Buffer>;
}

export interface FakeFolder {
  path: string;
  delimiter: string;
  flags: string[];
  specialUse?: string;
  uidValidity: number;
  uidNext: number;
  messages: FakeMessage[];
}

export interface Call {
  method: string;
  args: unknown[];
}

/** Read-only surface the sync is allowed to use. */
export const READ_ONLY_METHODS = new Set(["connect", "list", "status", "mailboxOpen", "search", "fetchAll", "fetchOne", "logout", "close", "getQuota", "on", "off"]);

export class FakeImapServer {
  readonly folders = new Map<string, FakeFolder>();
  readonly calls: Call[] = [];
  readonly clients: FakeImapClient[] = [];
  readonly violations: string[] = [];
  connectError: unknown = null;
  /**
   * Dovecot/Courier/Plesk with the personal namespace "INBOX.": a namespace-prefixed LIST returns only the
   * children, and imapflow skips its INBOX fix-up when `listOnly` is set.
   */
  inboxHiddenFromListOnly = false;
  /** Errors thrown by the next call of a method (consumed once). */
  readonly failNext = new Map<string, unknown>();
  capabilities = new Map<string, boolean | number>([
    ["IMAP4rev1", true],
    ["IDLE", true],
    ["SPECIAL-USE", true],
    ["UIDPLUS", true],
    ["QUOTA", true],
  ]);
  quota: QuotaResponse | false = { path: "INBOX", storage: { used: 512 * 1024, limit: 1024 * 1024 * 1024 } };
  connectOptions: ImapConnectOptions[] = [];

  addFolder(path: string, opts: Partial<Omit<FakeFolder, "path" | "messages">> = {}): FakeFolder {
    const f: FakeFolder = { path, delimiter: opts.delimiter ?? ".", flags: opts.flags ?? [], specialUse: opts.specialUse, uidValidity: opts.uidValidity ?? 1000, uidNext: opts.uidNext ?? 1, messages: [] };
    this.folders.set(path, f);
    return f;
  }

  addMessage(path: string, m: Omit<FakeMessage, "uid"> & { uid?: number }): FakeMessage {
    const f = this.folders.get(path)!;
    const uid = m.uid ?? f.uidNext;
    const msg: FakeMessage = { ...m, uid };
    f.messages.push(msg);
    f.messages.sort((a, b) => a.uid - b.uid);
    f.uidNext = Math.max(f.uidNext, uid + 1);
    return msg;
  }

  factory = (opts: ImapConnectOptions): ImapClientLike => {
    this.connectOptions.push(opts);
    const c = new FakeImapClient(this);
    this.clients.push(c);
    return c;
  };

  methodNames(): Set<string> {
    return new Set(this.calls.map((c) => c.method));
  }

  callsOf(method: string): Call[] {
    return this.calls.filter((c) => c.method === method);
  }

  /** Simulate new mail: add the message and emit EXISTS on clients that have the folder selected. */
  deliver(path: string, m: Omit<FakeMessage, "uid">): FakeMessage {
    const msg = this.addMessage(path, m);
    const f = this.folders.get(path)!;
    for (const c of this.clients) if (c.selectedPath === path) c.emitter.emit("exists", { path, count: f.messages.length, prevCount: f.messages.length - 1 } satisfies ExistsEvent);
    return msg;
  }
}

function headerSection(raw: Buffer): Buffer {
  const idx = raw.indexOf("\r\n\r\n");
  if (idx >= 0) return raw.subarray(0, idx + 4);
  const idx2 = raw.indexOf("\n\n");
  return idx2 >= 0 ? raw.subarray(0, idx2 + 2) : raw;
}

function headerValue(raw: Buffer, name: string): string | null {
  const head = headerSection(raw).toString("latin1");
  const re = new RegExp(`^${name}:[ \\t]*(.*)$`, "im");
  const m = re.exec(head);
  return m ? m[1]!.trim() : null;
}

const dayOf = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

function matches(m: FakeMessage, q: SearchObject): boolean {
  if (q.or) return q.or.some((sub) => matches(m, sub));
  if (q.since !== undefined && !(dayOf(m.internalDate) >= dayOf(new Date(q.since)))) return false;
  if (q.sentSince !== undefined && !(dayOf(m.date ?? m.internalDate) >= dayOf(new Date(q.sentSince)))) return false;
  if (q.header) {
    for (const [k, v] of Object.entries(q.header)) {
      const hv = headerValue(m.raw, k);
      if (hv === null) return false;
      if (typeof v === "string" && !hv.toLowerCase().includes(v.toLowerCase())) return false;
    }
  }
  return true;
}

function parseRange(range: string, folder: FakeFolder): Set<number> {
  const max = folder.messages.length ? folder.messages[folder.messages.length - 1]!.uid : 0;
  const out = new Set<number>();
  for (const part of range.split(",")) {
    const [a, b] = part.split(":");
    const lo0 = a === "*" ? max : Number(a);
    const hi0 = b === undefined ? lo0 : b === "*" ? max : Number(b);
    const lo = Math.min(lo0, hi0);
    const hi = Math.max(lo0, hi0);
    for (const m of folder.messages) if (m.uid >= lo && m.uid <= hi) out.add(m.uid);
  }
  return out;
}

export class FakeImapClient implements ImapClientLike {
  readonly emitter = new EventEmitter();
  selectedPath: string | null = null;
  connected = false;
  namespace: NamespaceObject | undefined = { prefix: "INBOX.", delimiter: "." };

  constructor(private readonly server: FakeImapServer) {
    this.emitter.on("error", () => {});
  }

  get capabilities(): ReadonlyMap<string, boolean | number> {
    return this.server.capabilities;
  }

  private record(method: string, ...args: unknown[]) {
    this.server.calls.push({ method, args });
    const err = this.server.failNext.get(method);
    if (err !== undefined) {
      this.server.failNext.delete(method);
      throw err;
    }
  }

  private selected(): FakeFolder {
    const f = this.selectedPath ? this.server.folders.get(this.selectedPath) : undefined;
    if (!f) throw Object.assign(new Error("No mailbox selected"), { code: "NoConnection" });
    return f;
  }

  async connect(): Promise<void> {
    this.record("connect");
    if (this.server.connectError) throw this.server.connectError;
    this.connected = true;
  }

  async logout(): Promise<void> {
    this.record("logout");
    this.connected = false;
    this.selectedPath = null;
  }

  close(): void {
    this.server.calls.push({ method: "close", args: [] });
    const wasConnected = this.connected;
    this.connected = false;
    this.selectedPath = null;
    if (wasConnected) this.emitter.emit("close");
  }

  /** Server-side disconnect. */
  drop(): void {
    this.connected = false;
    this.selectedPath = null;
    this.emitter.emit("close");
  }

  async list(options?: { statusQuery?: StatusQuery; listOnly?: boolean }): Promise<ListResponse[]> {
    this.record("list", options);
    const hideInbox = this.server.inboxHiddenFromListOnly && options?.listOnly === true;
    return [...this.server.folders.values()].filter((f) => !(hideInbox && f.path === "INBOX")).map((f) => {
      const segs = f.path.split(f.delimiter);
      const name = segs[segs.length - 1]!;
      const entry: ListResponse = {
        path: f.path,
        pathAsListed: f.path,
        name,
        delimiter: f.delimiter,
        parent: segs.slice(0, -1),
        parentPath: segs.slice(0, -1).join(f.delimiter),
        flags: new Set(f.flags),
        specialUse: f.specialUse,
        specialUseSource: f.specialUse ? "extension" : undefined,
        listed: true,
        subscribed: true,
      };
      if (options?.statusQuery && !f.flags.includes("\\Noselect")) entry.status = { path: f.path, messages: f.messages.length };
      return entry;
    });
  }

  async status(path: string, query: StatusQuery): Promise<StatusObject> {
    this.record("status", path, query);
    const f = this.server.folders.get(path);
    if (!f) throw Object.assign(new Error("Mailbox doesn't exist"), { serverResponseCode: "NONEXISTENT", responseStatus: "NO" });
    return { path, messages: f.messages.length, uidNext: f.uidNext, uidValidity: BigInt(f.uidValidity) };
  }

  async mailboxOpen(path: string, options: { readOnly: true }): Promise<MailboxObject> {
    this.record("mailboxOpen", path, options);
    if (options?.readOnly !== true) {
      this.server.violations.push(`mailboxOpen(${path}) without readOnly`);
      throw new Error("read-write open is forbidden");
    }
    const f = this.server.folders.get(path);
    if (!f) throw Object.assign(new Error("Mailbox doesn't exist"), { serverResponseCode: "NONEXISTENT", responseStatus: "NO", mailboxMissing: true });
    this.selectedPath = path;
    return { path, delimiter: f.delimiter, flags: new Set(), uidValidity: BigInt(f.uidValidity), uidNext: f.uidNext, exists: f.messages.length, readOnly: true };
  }

  async search(query: SearchObject, options: { uid: true }): Promise<number[] | false | undefined> {
    this.record("search", query, options);
    if (options?.uid !== true) this.server.violations.push("search without uid");
    return this.selected().messages.filter((m) => matches(m, query)).map((m) => m.uid);
  }

  private toFetch(m: FakeMessage, seq: number, query: FetchQueryObject): FetchMessageObject {
    const out: FetchMessageObject = { seq, uid: m.uid };
    if (query.flags) out.flags = new Set(m.flags ?? []);
    if (query.internalDate) out.internalDate = m.internalDate;
    if (query.size) out.size = m.size ?? m.raw.length;
    if (query.envelope) {
      out.envelope = { messageId: headerValue(m.raw, "message-id") ?? undefined, date: m.date ?? m.internalDate, subject: headerValue(m.raw, "subject") ?? undefined };
    }
    if (query.source) out.source = m.raw;
    if (query.headers) out.headers = headerSection(m.raw);
    if (query.bodyStructure) out.bodyStructure = m.bodyStructure ?? { type: "text/plain", parameters: { charset: "utf-8" }, encoding: "7bit", size: m.raw.length };
    if (query.bodyParts) {
      out.bodyParts = new Map();
      for (const p of query.bodyParts) {
        const key = (typeof p === "string" ? p : (p as FetchBodyPartQuery).key).toLowerCase();
        const buf = m.parts?.[key];
        if (!buf) continue;
        const max = typeof p === "string" ? undefined : (p as FetchBodyPartQuery).maxLength;
        out.bodyParts.set(key, max ? buf.subarray(0, max) : buf);
      }
    }
    return out;
  }

  async fetchAll(range: string, query: FetchQueryObject, options: { uid: true }): Promise<FetchMessageObject[]> {
    this.record("fetchAll", range, query, options);
    if (options?.uid !== true) this.server.violations.push("fetch without uid");
    const f = this.selected();
    const uids = parseRange(range, f);
    return f.messages.map((m, i) => ({ m, i })).filter(({ m }) => uids.has(m.uid)).map(({ m, i }) => this.toFetch(m, i + 1, query));
  }

  async fetchOne(uid: string, query: FetchQueryObject, options: { uid: true }): Promise<FetchMessageObject | false | undefined> {
    this.record("fetchOne", uid, query, options);
    if (options?.uid !== true) this.server.violations.push("fetchOne without uid");
    const f = this.selected();
    const idx = f.messages.findIndex((m) => m.uid === Number(uid));
    return idx === -1 ? false : this.toFetch(f.messages[idx]!, idx + 1, query);
  }

  async download(uid: string, part: string, options: { uid: true; maxBytes?: number }): Promise<Partial<DownloadObject>> {
    this.record("download", uid, part, options);
    return {};
  }

  async append(path: string, content: Buffer, flags: string[], idate?: Date): Promise<AppendResponseObject | false> {
    this.record("append", path, content, flags, idate);
    const f = this.server.folders.get(path);
    if (!f) return false;
    const m = this.server.addMessage(path, { raw: content, flags, internalDate: idate ?? new Date() });
    return { destination: path, uid: m.uid, uidValidity: BigInt(f.uidValidity) };
  }

  async getQuota(path?: string): Promise<QuotaResponse | false> {
    this.record("getQuota", path);
    return this.server.quota;
  }

  on(event: "exists" | "close" | "error", listener: (...args: never[]) => void): unknown {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
    return this;
  }

  off(event: "exists" | "close" | "error", listener: (...args: never[]) => void): unknown {
    this.emitter.off(event, listener as (...args: unknown[]) => void);
    return this;
  }
}

// ── Message builders ─────────────────────────────────────────────────────────

export interface EmlOpts {
  messageId?: string | null;
  from?: string;
  to?: string;
  subject?: string;
  date?: Date;
  body?: string;
  extraHeaders?: string[];
}

let emlCounter = 0;

/** Minimal RFC 5322 message. */
export function makeEml(opts: EmlOpts = {}): Buffer {
  const n = ++emlCounter;
  const lines = [
    `From: ${opts.from ?? "Πελάτης <client@abc-gr.example>"}`,
    `To: ${opts.to ?? "owner@contoso.example"}`,
    `Subject: ${opts.subject ?? `Test ${n}`}`,
    `Date: ${(opts.date ?? new Date("2026-09-20T09:00:00Z")).toUTCString()}`,
  ];
  if (opts.messageId !== null) lines.push(`Message-ID: <${opts.messageId ?? `m${n}.${Date.now()}@abc-gr.example`}>`);
  lines.push(...(opts.extraHeaders ?? []), "MIME-Version: 1.0", 'Content-Type: text/plain; charset="utf-8"', "Content-Transfer-Encoding: 8bit", "", opts.body ?? "Καλημέρα, στείλτε μου την προσφορά.", "");
  return Buffer.from(lines.join("\r\n"), "utf8");
}

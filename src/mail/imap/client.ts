import { isIP } from "node:net";
import { ImapFlow } from "imapflow";
import type {
  AppendResponseObject,
  DownloadObject,
  ExistsEvent,
  FetchMessageObject,
  FetchQueryObject,
  ImapFlowOptions,
  ListResponse,
  MailboxObject,
  NamespaceObject,
  QuotaResponse,
  SearchObject,
  StatusObject,
  StatusQuery,
} from "imapflow";

/**
 * The narrow slice of imapflow the platform uses. There is deliberately no STORE / COPY / MOVE / EXPUNGE /
 * DELETE here, and `mailboxOpen` only accepts `readOnly: true` (EXAMINE): nothing can mark mail read, move or
 * delete it. The only write is `append` (digest delivery, src/mail/transport.ts).
 */
export interface ImapClientLike {
  readonly capabilities: ReadonlyMap<string, boolean | number>;
  /** Personal namespace from NAMESPACE (after connect). */
  readonly namespace: NamespaceObject | undefined;
  connect(): Promise<void>;
  logout(): Promise<void>;
  close(): void;
  list(options?: { statusQuery?: StatusQuery; listOnly?: boolean }): Promise<ListResponse[]>;
  status(path: string, query: StatusQuery): Promise<StatusObject>;
  mailboxOpen(path: string, options: { readOnly: true }): Promise<MailboxObject>;
  search(query: SearchObject, options: { uid: true }): Promise<number[] | false | undefined>;
  fetchAll(range: string, query: FetchQueryObject, options: { uid: true }): Promise<FetchMessageObject[]>;
  fetchOne(uid: string, query: FetchQueryObject, options: { uid: true }): Promise<FetchMessageObject | false | undefined>;
  download(uid: string, part: string, options: { uid: true; maxBytes?: number }): Promise<Partial<DownloadObject>>;
  append(path: string, content: Buffer, flags: string[], idate?: Date): Promise<AppendResponseObject | false>;
  getQuota(path?: string): Promise<QuotaResponse | false>;
  on(event: "exists", listener: (e: ExistsEvent) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  off(event: "exists" | "close" | "error", listener: (...args: never[]) => void): unknown;
}

export interface ImapConnectOptions {
  host: string;
  port: number;
  user: string;
  pass: string;
  /** "watch" keeps a long-lived connection with auto-IDLE; everything else is short-lived. */
  mode: "short" | "watch";
}

export type ImapClientFactory = (opts: ImapConnectOptions) => ImapClientLike;

const CLIENT_INFO = { name: "MailMe", vendor: "MailMe", "support-url": false as const };

/** imapflow options: implicit TLS with full certificate verification, no protocol logging. */
export function imapFlowOptions(opts: ImapConnectOptions): ImapFlowOptions {
  const watch = opts.mode === "watch";
  // SNI must be a hostname; for an IP literal the certificate is verified against the IP itself.
  const sni = isIP(opts.host) === 0 ? opts.host : undefined;
  return {
    host: opts.host,
    port: opts.port,
    secure: true,
    servername: sni,
    auth: { user: opts.user, pass: opts.pass },
    tls: { rejectUnauthorized: true, servername: sni, minVersion: "TLSv1.2" },
    logger: false,
    emitLogs: false,
    clientInfo: CLIENT_INFO,
    // Short-lived sessions never IDLE; the watcher IDLEs on INBOX between commands.
    disableAutoIdle: !watch,
    maxIdleTime: watch ? 10 * 60_000 : undefined,
    connectionTimeout: 30_000,
    greetingTimeout: 20_000,
    socketTimeout: watch ? 5 * 60_000 : 2 * 60_000,
  };
}

/** Adapter over a real ImapFlow connection. */
class ImapFlowClient implements ImapClientLike {
  private readonly flow: ImapFlow;

  constructor(opts: ImapConnectOptions) {
    this.flow = new ImapFlow(imapFlowOptions(opts));
    // An unhandled 'error' event would crash the process; callers add their own listeners on top.
    this.flow.on("error", () => {});
  }

  get capabilities(): ReadonlyMap<string, boolean | number> {
    return this.flow.capabilities;
  }
  get namespace(): NamespaceObject | undefined {
    return this.flow.namespace;
  }
  connect(): Promise<void> {
    return this.flow.connect();
  }
  async logout(): Promise<void> {
    await this.flow.logout();
  }
  close(): void {
    this.flow.close();
  }
  list(options?: { statusQuery?: StatusQuery; listOnly?: boolean }): Promise<ListResponse[]> {
    return this.flow.list(options);
  }
  status(path: string, query: StatusQuery): Promise<StatusObject> {
    return this.flow.status(path, query);
  }
  mailboxOpen(path: string, options: { readOnly: true }): Promise<MailboxObject> {
    // Belt and braces for callers that bypass the type: EXAMINE only.
    if (options?.readOnly !== true) throw new Error("mailboxOpen must be read-only");
    return this.flow.mailboxOpen(path, { readOnly: true });
  }
  search(query: SearchObject, options: { uid: true }): Promise<number[] | false | undefined> {
    return this.flow.search(query, options);
  }
  fetchAll(range: string, query: FetchQueryObject, options: { uid: true }): Promise<FetchMessageObject[]> {
    return this.flow.fetchAll(range, query, options);
  }
  fetchOne(uid: string, query: FetchQueryObject, options: { uid: true }): Promise<FetchMessageObject | false | undefined> {
    return this.flow.fetchOne(uid, query, options);
  }
  download(uid: string, part: string, options: { uid: true; maxBytes?: number }): Promise<Partial<DownloadObject>> {
    return this.flow.download(uid, part, options);
  }
  append(path: string, content: Buffer, flags: string[], idate?: Date): Promise<AppendResponseObject | false> {
    return this.flow.append(path, content, flags, idate);
  }
  getQuota(path?: string): Promise<QuotaResponse | false> {
    return this.flow.getQuota(path);
  }
  on(event: "exists" | "close" | "error", listener: (...args: never[]) => void): unknown {
    return this.flow.on(event, listener as (...args: unknown[]) => void);
  }
  off(event: "exists" | "close" | "error", listener: (...args: never[]) => void): unknown {
    return this.flow.off(event, listener as (...args: unknown[]) => void);
  }
}

/** Default factory: a real imapflow connection (not connected yet). */
export const createImapFlowClient: ImapClientFactory = (opts) => new ImapFlowClient(opts);

/** Logout, falling back to a hard close; never throws. */
export async function safeLogout(client: ImapClientLike): Promise<void> {
  try {
    await client.logout();
  } catch {
    try {
      client.close();
    } catch {
      // already closed
    }
  }
}

/** Compact UID list → IMAP sequence set ("3:5,9"). */
export function toSequenceSet(uids: readonly number[]): string {
  const sorted = [...new Set(uids)].filter((u) => Number.isInteger(u) && u > 0).sort((a, b) => a - b);
  const parts: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    parts.push(j > i ? `${sorted[i]}:${sorted[j]}` : String(sorted[i]));
    i = j + 1;
  }
  return parts.join(",");
}

/** "<id@host>" / "id@host" → "id@host" (trimmed). */
export function stripMessageId(id: string | null | undefined): string {
  return (id ?? "").trim().replace(/^<+/, "").replace(/(?<!>)>+$/, "").trim();
}

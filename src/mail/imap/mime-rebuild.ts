import { randomBytes } from "node:crypto";
import type { FetchBodyPartQuery, MessageStructureObject } from "imapflow";
import type { ImapClientLike } from "./client.js";

/**
 * Large-message path (MAX_FETCH_BYTES): instead of downloading a 20 MB message for its three
 * paragraphs, fetch the header + BODYSTRUCTURE, download only the textual leaves (text/plain, text/html,
 * text/calendar, delivery reports) and the headers of embedded messages, and rebuild a small MIME document
 * with the original structure. Every other leaf becomes an empty placeholder part that keeps its
 * Content-Type, filename and size (`Content-Disposition: …; size=N`), so parseMime still sees the attachment
 * names/types ("Please find attached…" + Prosfora_ABC.pdf). Text leaves keep their original charset and
 * transfer encoding, so the normal parser (and its charset repairs) decodes them as usual.
 *
 * The result is passed to ingest as an ordinary `{ kind: "mime" }` source and carries
 * `X-MailMe-Partial: large-message`.
 */

/** Leaves whose bytes are fetched; everything else is a placeholder. */
const CONTENT_TYPES = new Set([
  "text/plain",
  "text/html",
  "text/calendar",
  "text/rfc822-headers",
  "message/delivery-status",
  "message/global-delivery-status",
  "message/disposition-notification",
]);

/** Header fields replaced by the rebuilt structure. */
const STRUCTURE_HEADERS = new Set([
  "content-type",
  "content-transfer-encoding",
  "mime-version",
  "content-disposition",
  "content-id",
  "content-description",
  "content-length",
  "content-md5",
]);

const MAX_DEPTH = 8;
const MAX_TEXT_PARTS = 16;
const MAX_EMBEDDED = 8;
const MIN_PART_BYTES = 64 * 1024;

export interface LargeFetchOptions {
  /** Total byte budget for all fetched leaves (MAX_FETCH_BYTES). */
  maxTextBytes: number;
}

interface Plan {
  /** fetch keys (lower-case section specifiers) of textual leaves */
  texts: string[];
  /** fetch keys ("2.header") of embedded message headers */
  headers: string[];
}

type Node = MessageStructureObject;

const typeOf = (n: Node) => (n.type || "application/octet-stream").toLowerCase();
const isMultipart = (n: Node) => typeOf(n).startsWith("multipart/") && Array.isArray(n.childNodes) && n.childNodes.length > 0;
const isEmbeddedMessage = (n: Node) => typeOf(n) === "message/rfc822" && !!n.part && Array.isArray(n.childNodes) && n.childNodes.length === 1;
const isContentLeaf = (n: Node) => CONTENT_TYPES.has(typeOf(n)) && (n.disposition ?? "").toLowerCase() !== "attachment";

/**
 * Section specifier of a leaf. The root of a single-part message is TEXT; the single-part body of an embedded
 * message shares its wrapper's part number in imapflow's tree, and is addressed as `<part>.TEXT`.
 */
function leafKey(n: Node, embeddedBodyOf: string | null): string {
  if (embeddedBodyOf !== null && (n.part ?? "") === embeddedBodyOf) return `${embeddedBodyOf}.text`;
  return (n.part ?? "text").toLowerCase();
}

function plan(root: Node): Plan {
  const out: Plan = { texts: [], headers: [] };
  const walk = (n: Node, depth: number, embeddedBodyOf: string | null) => {
    if (depth > MAX_DEPTH) return;
    if (isMultipart(n)) {
      for (const c of n.childNodes!) walk(c, depth + 1, null);
      return;
    }
    if (isEmbeddedMessage(n)) {
      if (out.headers.length >= MAX_EMBEDDED) return;
      out.headers.push(`${n.part!.toLowerCase()}.header`);
      walk(n.childNodes![0]!, depth + 1, n.part!);
      return;
    }
    if (isContentLeaf(n) && out.texts.length < MAX_TEXT_PARTS) out.texts.push(leafKey(n, embeddedBodyOf));
  };
  walk(root, 0, null);
  return out;
}

/** Fetch header + structure + textual leaves of `uid` and rebuild a small MIME message. Null if the message vanished. */
export async function fetchLargeMessage(client: ImapClientLike, uid: number, opts: LargeFetchOptions): Promise<Buffer | null> {
  const head = await client.fetchOne(String(uid), { uid: true, headers: true, bodyStructure: true }, { uid: true });
  if (!head || !head.headers || !head.bodyStructure) return null;
  const p = plan(head.bodyStructure);
  const parts = new Map<string, Buffer>();
  if (p.texts.length + p.headers.length > 0) {
    const perPart = Math.max(MIN_PART_BYTES, Math.floor(opts.maxTextBytes / Math.max(1, p.texts.length)));
    const query: Array<string | FetchBodyPartQuery> = [
      ...p.headers,
      ...p.texts.map((key) => ({ key, maxLength: perPart })),
    ];
    const body = await client.fetchOne(String(uid), { uid: true, bodyParts: query }, { uid: true });
    if (body && body.bodyParts) for (const [k, v] of body.bodyParts) parts.set(k.toLowerCase(), v);
  }
  return rebuildMime(head.headers, head.bodyStructure, parts);
}

// ── Rebuild ──────────────────────────────────────────────────────────────────

const CRLF = "\r\n";

interface Built {
  /** header lines (latin1 strings, no trailing CRLF) */
  headers: string[];
  body: Buffer;
}

/**
 * Pure: rebuild a MIME document from the raw top-level header block, the parsed BODYSTRUCTURE and the fetched
 * sections (keys: lower-case section specifiers such as "1.2", "text", "2.header").
 */
export function rebuildMime(rawHeaders: Buffer, structure: Node, parts: ReadonlyMap<string, Buffer>): Buffer {
  const root = build(structure, 0, null, parts);
  const head = [...filterHeaders(rawHeaders), "MIME-Version: 1.0", "X-MailMe-Partial: large-message", ...root.headers];
  return Buffer.concat([Buffer.from(head.join(CRLF) + CRLF + CRLF, "latin1"), root.body]);
}

function build(n: Node, depth: number, embeddedBodyOf: string | null, parts: ReadonlyMap<string, Buffer>): Built {
  if (depth <= MAX_DEPTH && isMultipart(n)) {
    const boundary = `=_mm_${randomBytes(12).toString("hex")}`;
    const chunks: Buffer[] = [];
    for (const c of n.childNodes!) {
      const b = build(c, depth + 1, null, parts);
      chunks.push(Buffer.from(`--${boundary}${CRLF}${b.headers.join(CRLF)}${CRLF}${CRLF}`, "latin1"), b.body, Buffer.from(CRLF, "latin1"));
    }
    chunks.push(Buffer.from(`--${boundary}--${CRLF}`, "latin1"));
    const params = { ...(n.parameters ?? {}), boundary };
    return { headers: [`Content-Type: ${typeOf(n)}${formatParams(params, ["boundary"])}`], body: Buffer.concat(chunks) };
  }

  if (depth <= MAX_DEPTH && isEmbeddedMessage(n)) {
    const hdr = parts.get(`${n.part!.toLowerCase()}.header`);
    if (hdr) {
      const inner = build(n.childNodes![0]!, depth + 1, n.part!, parts);
      const head = [...filterHeaders(hdr), "MIME-Version: 1.0", ...inner.headers];
      const body = Buffer.concat([Buffer.from(head.join(CRLF) + CRLF + CRLF, "latin1"), inner.body]);
      return { headers: ["Content-Type: message/rfc822", ...dispositionLine(n, false)], body };
    }
  }

  if (isContentLeaf(n)) {
    const content = parts.get(leafKey(n, embeddedBodyOf));
    if (content) {
      const lines = [`Content-Type: ${typeOf(n)}${formatParams(n.parameters ?? {})}`];
      if (n.encoding) lines.push(`Content-Transfer-Encoding: ${sanitizeToken(n.encoding)}`);
      if (n.disposition) lines.push(...dispositionLine(n, false));
      return { headers: lines, body: content };
    }
  }

  return placeholder(n);
}

/** Empty part that keeps type, filename and size of an omitted leaf. */
function placeholder(n: Node): Built {
  const type = isMultipart(n) ? "application/octet-stream" : typeOf(n);
  const params: Record<string, string> = {};
  const name = filenameOf(n);
  if (name) params.name = name;
  const lines = [`Content-Type: ${type}${formatParams(params)}`, "Content-Transfer-Encoding: base64", ...dispositionLine(n, true), "X-MailMe-Omitted: 1"];
  if (n.id) lines.push(`Content-ID: ${sanitizeHeaderValue(n.id)}`);
  return { headers: lines, body: Buffer.alloc(0) };
}

function filenameOf(n: Node): string | null {
  const f = n.dispositionParameters?.filename ?? n.parameters?.name ?? null;
  return f && f.trim() ? f.trim() : null;
}

function dispositionLine(n: Node, withSize: boolean): string[] {
  const name = filenameOf(n);
  let disp = (n.disposition ?? "").toLowerCase();
  if (disp !== "inline" && disp !== "attachment") disp = withSize && (name || !typeOf(n).startsWith("text/")) ? "attachment" : "";
  if (!disp) return [];
  const params: Record<string, string> = {};
  if (name) params.filename = name;
  if (withSize && typeof n.size === "number" && n.size > 0) params.size = String(n.size);
  return [`Content-Disposition: ${disp}${formatParams(params)}`];
}

/** `; key="value"` list. Non-ASCII values become RFC 2047 encoded words (what Outlook sends; mailparser decodes it). */
function formatParams(params: Record<string, string>, raw: string[] = []): string {
  let out = "";
  for (const [k, v] of Object.entries(params)) {
    if (!/^[A-Za-z0-9!#$&^_.+-]+$/.test(k) || typeof v !== "string") continue;
    const key = k.toLowerCase();
    if (raw.includes(key)) out += `; ${key}="${v}"`;
    else out += `; ${key}="${encodeParamValue(v)}"`;
  }
  return out;
}

function encodeParamValue(v: string): string {
  const clean = sanitizeHeaderValue(v);
  if (/^[\x20-\x7e]*$/.test(clean)) return clean.replace(/["\\]/g, "_");
  return encodeWords(clean);
}

/** RFC 2047 B-encoding in ≤ 45-byte UTF-8 chunks (encoded words stay under 75 chars), never splitting a character. */
export function encodeWords(value: string): string {
  const words: string[] = [];
  let cur = "";
  for (const ch of value) {
    if (Buffer.byteLength(cur + ch, "utf8") > 45) {
      words.push(cur);
      cur = "";
    }
    cur += ch;
  }
  if (cur) words.push(cur);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, "utf8").toString("base64")}?=`).join(" ");
}

function sanitizeHeaderValue(v: string): string {
  return v.replace(/[\r\n\0]+/g, " ").trim();
}

function sanitizeToken(v: string): string {
  return v.replace(/[^A-Za-z0-9-]/g, "").toLowerCase() || "7bit";
}

/**
 * Split a raw header block into fields (keeping folded continuation lines) and drop the MIME structure fields.
 * Works on latin1 strings so 8-bit header bytes survive unchanged.
 */
export function filterHeaders(raw: Buffer): string[] {
  const text = raw.toString("latin1").replace(/(\r?\n)+$/, "");
  const lines = text.split(/\r?\n/);
  const fields: string[][] = [];
  for (const line of lines) {
    if (/^[ \t]/.test(line) && fields.length > 0) fields[fields.length - 1]!.push(line);
    else if (line.length > 0) fields.push([line]);
  }
  return fields
    .filter((f) => {
      const name = f[0]!.split(":", 1)[0]!.trim().toLowerCase();
      return f[0]!.includes(":") && !STRUCTURE_HEADERS.has(name);
    })
    .map((f) => f.join(CRLF));
}

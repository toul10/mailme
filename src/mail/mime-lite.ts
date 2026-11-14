/**
 * Minimal, byte-exact MIME walker used next to mailparser for what it hides: raw header bytes
 * (8-bit subjects, unparseable Date), transfer-decoded text-part bytes (charset repair) and the
 * structural parts of reports / S/MIME / TNEF. Works on latin1 strings (1 char = 1 byte). Never throws.
 */

export interface RawHeader {
  /** lower-cased */
  name: string;
  /** Unfolded value as a latin1 byte string (not yet charset-decoded). */
  raw: string;
}

export interface LitePart {
  headers: RawHeader[];
  /** lower-cased "type/subtype" ("text/plain" when absent). */
  contentType: string;
  params: Record<string, string>;
  disposition: string | null;
  transferEncoding: string;
  /** Transfer-encoded body bytes (latin1). */
  body: string;
  children: LitePart[];
}

const MAX_PARTS = 200;
const MAX_DEPTH = 8;

/** Split at the first empty line. Tolerates LF-only mail and messages without a body. */
export function splitHeaderBody(s: string): { head: string; body: string } {
  const crlf = s.indexOf("\r\n\r\n");
  const lf = s.indexOf("\n\n");
  if (crlf < 0 && lf < 0) return /^[\x21-\x39\x3b-\x7e]+:/.test(s) ? { head: s, body: "" } : { head: "", body: s };
  if (crlf >= 0 && (lf < 0 || crlf <= lf)) return { head: s.slice(0, crlf), body: s.slice(crlf + 4) };
  return { head: s.slice(0, lf), body: s.slice(lf + 2) };
}

/** Unfold and split a header block. Lines without a colon are ignored. */
export function parseHeaderBlock(head: string): RawHeader[] {
  const out: RawHeader[] = [];
  const unfolded = head.replace(/\r?\n(?=[ \t])/g, "");
  for (const line of unfolded.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim().toLowerCase();
    if (!/^[\x21-\x39\x3b-\x7e]+$/.test(name)) continue;
    out.push({ name, raw: line.slice(idx + 1).trim() });
  }
  return out;
}

export function headerValue(headers: RawHeader[], name: string): string | null {
  const h = headers.find((x) => x.name === name);
  return h ? h.raw : null;
}

/** "type/subtype; a=b; c="d"" → parts. RFC 2231 continuations are joined (no charset decoding). */
export function parseStructuredHeader(value: string | null): { value: string; params: Record<string, string> } {
  if (!value) return { value: "", params: {} };
  const params: Record<string, string> = {};
  const semi = value.indexOf(";");
  const main = (semi < 0 ? value : value.slice(0, semi)).trim().toLowerCase();
  const rest = semi < 0 ? "" : value.slice(semi + 1);
  // Bounded key and leading space: the search retries from every position, and unbounded runs made that quadratic
  // on a long parameter without "=" (no real parameter name is near 128 characters).
  const re = /\s{0,64}([^=;\s]{1,128})\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]*))\s*;?/g;
  let m: RegExpExecArray | null;
  const continuations: Record<string, string[]> = {};
  while ((m = re.exec(rest))) {
    const key = m[1]!.toLowerCase();
    const val = (m[2] !== undefined ? m[2].replace(/\\(.)/g, "$1") : (m[3] ?? "")).trim();
    const cont = /^(.+?)\*(\d+)\*?$/.exec(key);
    if (cont) {
      (continuations[cont[1]!] ??= [])[+cont[2]!] = val;
    } else {
      params[key.replace(/\*$/, "")] = val;
    }
    if (m[0] === "") break;
  }
  for (const [k, parts] of Object.entries(continuations)) params[k] ??= parts.join("");
  return { value: main, params };
}

/** Parse a whole message (latin1 string) into a part tree. message/rfc822 bodies are NOT descended into. */
export function walkMime(source: string): LitePart {
  let count = 0;
  const walk = (s: string, depth: number): LitePart => {
    count++;
    const { head, body } = splitHeaderBody(s);
    const headers = parseHeaderBlock(head);
    const ct = parseStructuredHeader(headerValue(headers, "content-type"));
    const cd = parseStructuredHeader(headerValue(headers, "content-disposition"));
    const part: LitePart = {
      headers,
      contentType: ct.value || "text/plain",
      params: ct.params,
      disposition: cd.value || null,
      transferEncoding: (headerValue(headers, "content-transfer-encoding") ?? "").trim().toLowerCase(),
      body,
      children: [],
    };
    if (cd.params.filename && !part.params.name) part.params.name = cd.params.filename;
    const boundary = ct.params.boundary;
    if (part.contentType.startsWith("multipart/") && boundary && depth < MAX_DEPTH) {
      for (const chunk of splitMultipart(body, boundary)) {
        if (count >= MAX_PARTS) break;
        part.children.push(walk(chunk, depth + 1));
      }
    }
    return part;
  };
  return walk(source, 0);
}

function splitMultipart(body: string, boundary: string): string[] {
  const delim = "--" + boundary;
  const lines = body.split(/\r?\n/);
  const parts: string[] = [];
  let cur: string[] | null = null;
  for (const line of lines) {
    const t = line.trimEnd();
    if (t === delim + "--") {
      if (cur) parts.push(cur.join("\r\n"));
      cur = null;
      break;
    }
    if (t === delim) {
      if (cur) parts.push(cur.join("\r\n"));
      cur = [];
      continue;
    }
    cur?.push(line);
  }
  if (cur && cur.length) parts.push(cur.join("\r\n"));
  return parts;
}

/** Transfer-decode a part body into bytes. */
export function decodeTransfer(part: Pick<LitePart, "body" | "transferEncoding">): Buffer {
  if (part.transferEncoding === "base64") return Buffer.from(part.body.replace(/[^A-Za-z0-9+/=]/g, ""), "base64");
  if (part.transferEncoding === "quoted-printable") return decodeQuotedPrintable(part.body);
  return Buffer.from(part.body, "latin1");
}

export function decodeQuotedPrintable(s: string): Buffer {
  const out: number[] = [];
  // Trailing spaces before a line break go (RFC 2045, section 6.7), in one pass over each run of spaces:
  // `/[ \t]+(\r?\n)/` retried from every space of a long run that no line break follows (quadratic).
  const src = s.replace(/[ \t]+(\r?\n)?/g, (run, nl: string | undefined) => nl ?? run).replace(/=\r?\n/g, "");
  for (let i = 0; i < src.length; i++) {
    const c = src.charCodeAt(i);
    if (c === 0x3d && /^[0-9A-Fa-f]{2}$/.test(src.slice(i + 1, i + 3))) {
      out.push(parseInt(src.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      out.push(c & 0xff);
    }
  }
  return Buffer.from(out);
}

/** Depth-first list of all parts (including containers). */
export function flattenParts(root: LitePart): LitePart[] {
  const out: LitePart[] = [];
  const visit = (p: LitePart) => {
    out.push(p);
    p.children.forEach(visit);
  };
  visit(root);
  return out;
}

// ── Charset decoding ─────────────────────────────────────────────────────────

const GREEK_LETTER = /[\u{0386}-\u{03ce}]/gu;
const C1_CONTROL = /[\u{0080}-\u{009f}]/u;

function tryDecode(bytes: Uint8Array, charset: string, fatal: boolean): string | null {
  try {
    return new TextDecoder(charset, { fatal }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * `s.replace(/\*.*$/, "")` in one pass: cut at the first "*" after the last line break. The regex retried from every
 * "*" before a line break ("." stops there), which is quadratic on a crafted charset such as `"****…\rx"`.
 */
function cutAtStar(s: string): string {
  const lastBreak = Math.max(s.lastIndexOf("\n"), s.lastIndexOf("\r"), s.lastIndexOf("\u2028"), s.lastIndexOf("\u2029"));
  const star = s.indexOf("*", lastBreak + 1);
  return star < 0 ? s : s.slice(0, star);
}

export function normalizeCharset(cs: string | undefined | null): string {
  const c = cutAtStar((cs ?? "").trim().toLowerCase()).replace(/^"|"$/g, "");
  if (!c || c === "us-ascii" || c === "ascii" || c === "ansi_x3.4-1968") return "utf-8";
  if (c === "cp1253" || c === "win-1253" || c === "x-cp1253") return "windows-1253";
  if (c === "iso8859-7" || c === "iso_8859-7" || c === "greek" || c === "elot_928") return "iso-8859-7";
  if (c === "utf8") return "utf-8";
  return c;
}

/**
 * Decode bytes in their declared charset; if that yields invalid data, try UTF-8, then the Greek
 * single-byte charsets (clean decode, no C1 controls, contains Greek letters). Returns the charset used
 * when it differs from the declared one.
 */
export function decodeWithRepair(bytes: Uint8Array, declared: string | null | undefined): { text: string; repairedAs: string | null } {
  const cs = normalizeCharset(declared);
  const clean = tryDecode(bytes, cs, true);
  if (clean !== null && !C1_CONTROL.test(clean)) {
    // Greek sent as "iso-8859-1"/"windows-1252" decodes cleanly into Latin-1 mojibake ("ÊáëçìÝñá").
    if (LATIN1_LABELS.has(cs) && looksLikeGreekMojibake(clean)) {
      const greek = bestGreekDecoding(bytes, cs);
      if (greek) return greek;
    }
    return { text: clean, repairedAs: null };
  }
  if (cs !== "utf-8") {
    const utf8 = tryDecode(bytes, "utf-8", true);
    if (utf8 !== null) return { text: utf8, repairedAs: "utf-8" };
  }
  const greek = bestGreekDecoding(bytes, cs);
  if (greek) return greek;
  return { text: clean ?? tryDecode(bytes, cs, false) ?? tryDecode(bytes, "utf-8", false) ?? "", repairedAs: null };
}

const LATIN1_LABELS = new Set(["iso-8859-1", "latin1", "l1", "windows-1252", "cp1252", "iso-8859-15"]);

/** Most letters fall in U+00C0–U+00FF: typical of Greek bytes read as Latin-1 (real Latin text stays well below). */
export function looksLikeGreekMojibake(t: string): boolean {
  const hi = (t.match(/[\u{00c0}-\u{00ff}]/gu) ?? []).length;
  if (hi < 3) return false;
  const letters = (t.match(/\p{L}/gu) ?? []).length;
  return hi / Math.max(1, letters) >= 0.3;
}

function bestGreekDecoding(bytes: Uint8Array, exclude: string): { text: string; repairedAs: string } | null {
  let best: { text: string; repairedAs: string; score: number } | null = null;
  for (const cs of ["windows-1253", "iso-8859-7"]) {
    if (cs === exclude) continue;
    const t = tryDecode(bytes, cs, true);
    if (t === null || C1_CONTROL.test(t)) continue;
    const score = (t.match(GREEK_LETTER) ?? []).length;
    if (score === 0) continue;
    if (!best || score > best.score) best = { text: t, repairedAs: cs, score };
  }
  return best ? { text: best.text, repairedAs: best.repairedAs } : null;
}

/** Decode a raw (latin1) header value: 8-bit bytes (UTF-8 or Greek single-byte) and RFC 2047 encoded words. */
export function decodeHeaderValue(raw: string): string {
  let s = raw;
  if (/[\x80-\xff]/.test(s)) s = decodeWithRepair(Buffer.from(s, "latin1"), "utf-8").text;
  return decodeMimeWords(s);
}

/**
 * RFC 2047 encoded-word decoding. Whitespace between adjacent encoded words is dropped, and adjacent words in the
 * same charset are decoded together (clients split multi-byte characters across words).
 */
export function decodeMimeWords(s: string): string {
  if (!s.includes("=?")) return s;
  const re = /=\?([^?\s]+)\?([BbQq])\?([^?]*)\?=/g;
  let out = "";
  let last = 0;
  let pending: { cs: string; bytes: Buffer[] } | null = null;
  const flush = () => {
    if (pending) out += decodeWithRepair(Buffer.concat(pending.bytes), pending.cs).text;
    pending = null;
  };
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const between = s.slice(last, m.index);
    const cs = m[1]!.toLowerCase().replace(/\*.*$/, "");
    const bytes = m[2]!.toUpperCase() === "B" ? Buffer.from(m[3]!, "base64") : decodeQuotedPrintable(m[3]!.replace(/_/g, " "));
    const adjacent = pending !== null && /^\s*$/.test(between);
    if (adjacent && pending!.cs === cs) {
      pending!.bytes.push(bytes);
    } else {
      if (!adjacent) {
        flush();
        out += between;
      } else {
        flush();
      }
      pending = { cs, bytes: [bytes] };
    }
    last = m.index + m[0].length;
  }
  flush();
  return out + s.slice(last);
}

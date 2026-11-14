import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeMessageId, tokens, trimSpaceTabEnd } from "../../../src/lib/text.js";
import { htmlToPlainText } from "../../../src/mail/html.js";
import { decodeQuotedPrintable, normalizeCharset, parseStructuredHeader } from "../../../src/mail/mime-lite.js";
import { dropComments, parseMime, splitAddressList } from "../../../src/mail/parse.js";
import { LABELS, matchLabel, segmentBodyDetailed } from "../../../src/mail/segment.js";

// A crafted e-mail must not stall the worker: these inputs took from minutes to hours in the regexes they replaced
// (backtracking on long runs of spaces, newlines, "<", "(", "," or parameter text). The new code must also give the
// same results as the old regexes, which are kept below as the oracles: on short strings they are still fast.

const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

/** Deterministic PRNG (mulberry32), so a failure reproduces. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function randomStrings(seed: number, count: number, pieces: string[], maxLen: number): string[] {
  const r = rng(seed);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    let s = "";
    const len = Math.floor(r() * maxLen);
    while (s.length < len) s += pieces[Math.floor(r() * pieces.length)];
    out.push(s);
  }
  return out;
}

// ── Oracles: the old implementations ─────────────────────────────────────────────────────────────────────────────

const OLD_LABEL_LINE = /^\s*\*{0,2}\s*([^:：*]{1,32}?)\s*\*{0,2}\s*[:：]\s*\*{0,2}\s*(.*)$/u;
function oldMatchLabel(text: string) {
  if (text.length > 2000) return null;
  const m = OLD_LABEL_LINE.exec(text);
  if (!m) return null;
  const label = LABELS.get(m[1]!.trim().toLowerCase().replace(/\s+/g, " "));
  return label ? { label, value: m[2]!.replace(/\*+$/, "").trim() } : null;
}

function oldDecodeQuotedPrintable(s: string): Buffer {
  const out: number[] = [];
  const src = s.replace(/[ \t]+(\r?\n)/g, "$1").replace(/=\r?\n/g, "");
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

function oldParseStructuredHeader(value: string | null) {
  if (!value) return { value: "", params: {} };
  const params: Record<string, string> = {};
  const semi = value.indexOf(";");
  const main = (semi < 0 ? value : value.slice(0, semi)).trim().toLowerCase();
  const rest = semi < 0 ? "" : value.slice(semi + 1);
  const re = /\s*([^=;\s]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]*))\s*;?/g;
  let m: RegExpExecArray | null;
  const continuations: Record<string, string[]> = {};
  while ((m = re.exec(rest))) {
    const key = m[1]!.toLowerCase();
    const val = (m[2] !== undefined ? m[2].replace(/\\(.)/g, "$1") : (m[3] ?? "")).trim();
    const cont = /^(.+?)\*(\d+)\*?$/.exec(key);
    if (cont) (continuations[cont[1]!] ??= [])[+cont[2]!] = val;
    else params[key.replace(/\*$/, "")] = val;
    if (m[0] === "") break;
  }
  for (const [k, parts] of Object.entries(continuations)) params[k] ??= parts.join("");
  return { value: main, params };
}

function oldNormalizeCharset(cs: string): string {
  const c = cs.trim().toLowerCase().replace(/\*.*$/, "").replace(/^"|"$/g, "");
  if (!c || c === "us-ascii" || c === "ascii" || c === "ansi_x3.4-1968") return "utf-8";
  if (c === "cp1253" || c === "win-1253" || c === "x-cp1253") return "windows-1253";
  if (c === "iso8859-7" || c === "iso_8859-7" || c === "greek" || c === "elot_928") return "iso-8859-7";
  if (c === "utf8") return "utf-8";
  return c;
}

const OLD_ADDRESS_SPLIT = /,(?=(?:[^"]*"[^"]*")*[^"]*$)/;
const OLD_COMMENT = /\([^)]*\)/g;

/** Trailing-run regexes before and after the lookbehind, as the code has them (one of each shape). */
const TRAILING_RUNS: Array<[RegExp, RegExp]> = [
  [/[\s,]+$/, /(?<![\s,])[\s,]+$/],
  [/[,.!;:\-–—]+$/, /(?<![,.!;:\-–—])[,.!;:\-–—]+$/],
  [/[»”"')\].,;:!?·]+$/u, /(?<![»”"')\].,;:!?·])[»”"')\].,;:!?·]+$/u],
  [/[\s,;:·.\-–—]+$/u, /(?<![\s,;:·.\-–—])[\s,;:·.\-–—]+$/u],
  [/\*+$/, /(?<!\*)\*+$/],
  [/^<+|>+$/g, /^<+|(?<!>)>+$/g],
  [/^[.\-_@]+|[.\-_@]+$/g, /^[.\-_@]+|(?<![.\-_@])[.\-_@]+$/g],
  [/^["'\s.…]+|["'\s.…]+$/g, /^["'\s.…]+|(?<!["'\s.…])["'\s.…]+$/g],
  [/^["\s]+|["\s]+$/g, /^["\s]+|(?<!["\s])["\s]+$/g],
  [/^[-/.]+|[-/.]+$/gu, /^[-/.]+|(?<![-/.])[-/.]+$/gu],
];

// ── Lines from real-looking mail: every fixture and every eval case ──────────────────────────────────────────────

const root = path.resolve(import.meta.dirname, "../../..");
function emlFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? emlFiles(path.join(dir, e.name)) : e.name.endsWith(".eml") ? [path.join(dir, e.name)] : [],
  );
}
function stringsIn(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(stringsIn);
  if (v && typeof v === "object") return Object.values(v).flatMap(stringsIn);
  return [];
}
async function corpusLines(): Promise<string[]> {
  const texts: string[] = [];
  for (const f of emlFiles(path.join(root, "test/fixtures"))) {
    const parsed = await parseMime(readFileSync(f));
    if (parsed.textPlain) texts.push(parsed.textPlain);
    if (parsed.textHtml) texts.push(htmlToPlainText(parsed.textHtml));
  }
  const cases = path.join(root, "eval/cases");
  for (const f of readdirSync(cases).filter((n) => n.endsWith(".json"))) texts.push(...stringsIn(JSON.parse(readFileSync(path.join(cases, f), "utf8"))));
  return texts.flatMap((t) => t.replace(/\r\n?/g, "\n").split("\n"));
}

describe("matchLabel gives the old regex's result", () => {
  const LABEL_PIECES = [" ", "  ", "\t", "\u00a0", "*", "**", ":", "：", "\n", "\r", LS, PS, "x", "-", ".", "/",
    "from", "From", "FROM", "subject", "Subject", "sent on", "Sent", "date", "to", "cc", "reply-to", "reply to",
    "θέμα", "Θέμα", "από", "Από", "κοιν.", "ημ/νία", "pièces jointes", "Fwd", "Re"];

  it("on 30,000 random label-like lines", () => {
    for (const s of randomStrings(20261114, 30_000, LABEL_PIECES, 40)) expect(matchLabel(s), JSON.stringify(s)).toEqual(oldMatchLabel(s));
  });

  it("on every line of the test mail and the eval cases", async () => {
    const lines = await corpusLines();
    expect(lines.length).toBeGreaterThan(500);
    for (const s of lines) expect(matchLabel(s), JSON.stringify(s)).toEqual(oldMatchLabel(s));
  });

  it("on header lines written in every way the mail clients do", () => {
    for (const s of ["From: Pat <pat@contoso.example>", "**From:** Pat", "*Από:* Μαρία", "Sent on : Monday", "Θέμα：Προσφορά",
      "  Subject:   Re: quote  ", "**Subject:**", "From:", "From: x **", "***From: x", "From** : x", "Fr*om: x", "sent\non: x",
      `From: a${LS}b`, "To:\n x", "Reply-To: a@b.example"]) {
      expect(matchLabel(s), JSON.stringify(s)).toEqual(oldMatchLabel(s));
    }
  });
});

describe("the other rewritten regexes give the same results", () => {
  it("decodeQuotedPrintable (30,000 random strings)", () => {
    for (const s of randomStrings(7, 30_000, [" ", "\t", "\r", "\n", "\r\n", "=", "=\r\n", "=3D", "=C3=A9", "a", "3", "D"], 30)) {
      expect(decodeQuotedPrintable(s).equals(oldDecodeQuotedPrintable(s)), JSON.stringify(s)).toBe(true);
    }
  });

  it("parseStructuredHeader (30,000 random headers)", () => {
    const pieces = ["text/plain", ";", " ", "\t", "=", '"', "\\", "*", "0", "1", "charset", "name", "a", "b c", "utf-8", "*0*", "''"];
    for (const s of randomStrings(11, 30_000, pieces, 50)) expect(parseStructuredHeader(s), JSON.stringify(s)).toEqual(oldParseStructuredHeader(s));
  });

  it("trimSpaceTabEnd strips spaces and tabs only, like /[ \\t]+$/", () => {
    for (const s of randomStrings(3, 10_000, [" ", "\t", "\u00a0", "\n", "x", "  "], 20)) expect(trimSpaceTabEnd(s)).toBe(s.replace(/[ \t]+$/, ""));
  });

  it("normalizeCharset (30,000 random charset values)", () => {
    const pieces = ["*", "**", "\n", "\r", "\r\n", LS, PS, '"', " ", "\t", "utf-8", "UTF8", "us-ascii", "cp1253", "iso8859-7", "en", "x"];
    for (const s of randomStrings(13, 30_000, pieces, 30)) expect(normalizeCharset(s), JSON.stringify(s)).toBe(oldNormalizeCharset(s));
  });

  it("splitAddressList splits at the same commas (30,000 random address lists)", () => {
    const pieces = [",", ",", '"', '"', " ", "a", "Pat", "@", "<", ">", "\\", "\n", "x@y.example"];
    for (const s of randomStrings(17, 30_000, pieces, 40)) expect(splitAddressList(s), JSON.stringify(s)).toEqual(s.split(OLD_ADDRESS_SPLIT));
  });

  it("dropComments removes the same (comments) from a Date (30,000 random values)", () => {
    const pieces = ["(", "(", ")", "a", " ", "1", "Mon", "+0300", "\n"];
    for (const s of randomStrings(19, 30_000, pieces, 30)) expect(dropComments(s), JSON.stringify(s)).toBe(s.replace(OLD_COMMENT, " "));
  });

  it("a trailing run with a lookbehind, (?<!X)X+$, removes the same text as X+$", () => {
    // The lookbehind only lets a match start where a run starts, so each run is read once instead of once per character.
    const pieces = [" ", "\t", "\n", "\u00a0", LS, PS, ",", ".", "-", "–", "—", "*", "<", ">", "@", "_", "/", '"', "'", "…", "»", "”", "·", ";", "x", "αβ"];
    for (const [old, now] of TRAILING_RUNS) {
      for (const s of randomStrings(23, 5_000, pieces, 24)) expect(s.replace(now, ""), `${now} on ${JSON.stringify(s)}`).toBe(s.replace(old, ""));
    }
  });
});

// ── End to end: parse + segment within a loose budget (slow CI machines); before the fix, minutes to hours ──────

const BUDGET_MS = 2000;
const HEAD = "From: \"Pat Doe\" <pat@contoso.example>\r\nTo: owner@contoso.example\r\nDate: Mon, 14 Sep 2026 10:00:00 +0300\r\nMIME-Version: 1.0\r\n";
const plain = (body: string) =>
  `${HEAD}Subject: Hello\r\nMessage-ID: <p@contoso.example>\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${body}\r\n`;
const html = (body: string) =>
  `${HEAD}Subject: Hello\r\nMessage-ID: <h@contoso.example>\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<html><body><pre>${body}</pre></body></html>\r\n`;
const calendarQp = (summary: string) =>
  `${HEAD}Subject: Meeting\r\nMessage-ID: <c@contoso.example>\r\nContent-Type: multipart/alternative; boundary="BB"\r\n\r\n--BB\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nhi\r\n--BB\r\nContent-Type: text/calendar; method=REQUEST; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nBEGIN:VCALENDAR\r\nSUMMARY:${summary}\r\nEND:VCALENDAR\r\n--BB--\r\n`;
const bounce = (body: string) =>
  `From: Mail Delivery System <MAILER-DAEMON@mail.example>\r\nTo: owner@contoso.example\r\nSubject: Undelivered Mail Returned to Sender\r\nDate: Mon, 14 Sep 2026 10:00:00 +0300\r\nMessage-ID: <b@mail.example>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`;
const param = (value: string) => `${HEAD}Subject: Hello\r\nMessage-ID: <q@contoso.example>\r\nContent-Type: text/plain; charset=utf-8; ${value}\r\n\r\nhi\r\n`;
const embedded = (first: string) =>
  `${HEAD}Subject: Fwd: offer\r\nMessage-ID: <e@contoso.example>\r\nContent-Type: multipart/mixed; boundary="BB"\r\n\r\n--BB\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${first}\r\n--BB\r\nContent-Type: message/rfc822\r\n\r\n${plain("the forwarded text")}\r\n--BB--\r\n`;
const calendarCharset = (charset: string) =>
  `${HEAD}Subject: Meeting\r\nMessage-ID: <cs@contoso.example>\r\nContent-Type: text/calendar; method=REQUEST; charset="${charset}"\r\n\r\nBEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n`;
const dated = (date: string) =>
  `From: "Pat Doe" <pat@contoso.example>\r\nTo: owner@contoso.example\r\nSubject: Hello\r\nDate: ${date}\r\nMessage-ID: <d@contoso.example>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nhi\r\n`;

async function parseAndSegment(raw: string): Promise<number> {
  const t0 = performance.now();
  const parsed = await parseMime(Buffer.from(raw, "utf8"));
  segmentBodyDetailed({ textPlain: parsed.textPlain, textHtml: parsed.textHtml }, { subject: parsed.subject });
  return performance.now() - t0;
}

describe("crafted mail is parsed and segmented in linear time", () => {
  it.each([
    ["200 lines that start with 300 spaces", plain((" ".repeat(300) + "x\n").repeat(200))],
    ["200 lines that start with 300 no-break spaces", plain(("\u00a0".repeat(300) + "x\n").repeat(200))],
    ["the same in an HTML <pre>", html((" ".repeat(300) + "x\n").repeat(200))],
    ["a 1 MB run of spaces inside a line", plain(" ".repeat(1_000_000) + "x")],
    ["a 1 MB run of spaces and tabs", plain(" \t".repeat(500_000) + "x")],
    ["a quoted-printable calendar part with 200k spaces", calendarQp(" ".repeat(200_000) + "x")],
    ["a bounce of 30k empty lines", bounce("\n".repeat(30_000) + "x")],
    ["a bounce: failed recipient, then 50k spaces", bounce("failed recipient:" + " ".repeat(50_000) + "x")],
    ["50k \"<\" in the text", plain("<".repeat(50_000))],
    ["a 40k Content-Type parameter without \"=\"", param("x" + "a".repeat(40_000))],
    ["a 40k run of spaces in a Content-Type parameter", param(" ".repeat(40_000) + "x")],
    ["an embedded message after a 1 MB run of spaces", embedded(" ".repeat(1_000_000) + "x")],
    // 0.3 s here, 2.6 s on a busy CI runner, 58 s before the fix: its own budget.
    ["600k \"<\" in an HTML part", html("<".repeat(600_000)), 8_000],
    ["two lines of 100k dashes", plain(("-".repeat(100_000) + "x\n").repeat(2))],
    ["a calendar part whose charset is 100k \"*\" and a bare CR", calendarCharset("*".repeat(100_000) + "\rx")],
    ["a Date header of 200k \"(\"", dated("(".repeat(200_000))],
    ["a Date header of 100k \"(a\"", dated("(a".repeat(100_000))],
  ] as [string, string, number?][])("%s", async (_, raw, budgetMs = BUDGET_MS) => {
    expect(await parseAndSegment(raw)).toBeLessThan(budgetMs);
  });

  it("a header section over 1 MB is read by the fallback parser, quickly, instead of failing the message", async () => {
    // mailparser stops at about 1 MB of headers; the fallback then splits a To: of 1.1 million commas and a From:
    // name with a 100k run of quotes and spaces in the middle (both took hours in the old regexes).
    const raw =
      `From: "Pat${'" '.repeat(50_000)}Doe" <pat@contoso.example>\r\nTo: owner@contoso.example${",".repeat(1_100_000)}\r\n` +
      `Subject: Hello\r\nDate: Mon, 14 Sep 2026 10:00:00 +0300\r\nMessage-ID: <big@contoso.example>\r\nMIME-Version: 1.0\r\n` +
      `Content-Type: text/plain; charset=utf-8\r\n\r\nthe body\r\n`;
    const t0 = performance.now();
    const parsed = await parseMime(Buffer.from(raw, "utf8"));
    expect(performance.now() - t0).toBeLessThan(BUDGET_MS);
    expect(parsed.decodeWarnings).toContain("parse_error"); // the fallback path, not mailparser's
    expect(parsed.subject).toBe("Hello");
    expect(parsed.from?.address).toBe("pat@contoso.example");
    expect(parsed.from?.name?.startsWith("Pat")).toBe(true);
    expect(parsed.from?.name?.endsWith("Doe")).toBe(true);
    expect(parsed.to.map((a) => a.address)).toEqual(["owner@contoso.example"]);
    expect(parsed.textPlain).toContain("the body");
  });

  it("a Message-ID with a 100k run of \">\" inside, and a word with a 100k run of dots", () => {
    const t0 = performance.now();
    expect(normalizeMessageId("<a" + ">".repeat(100_000) + "b@Contoso.example>")).toBe("a" + ">".repeat(100_000) + "b@contoso.example");
    expect(tokens("a" + ".".repeat(100_000) + "b cd")).toEqual(["a" + ".".repeat(100_000) + "b", "cd"]);
    expect(normalizeCharset("*".repeat(100_000) + "\nx")).toBe("*".repeat(100_000) + "\nx");
    expect(performance.now() - t0).toBeLessThan(BUDGET_MS);
  });

  it('a "From:" line whose value spans lines, after 1,900 spaces', () => {
    const t0 = performance.now();
    expect(matchLabel("From:" + " ".repeat(1900) + "x\ny")).toBeNull();
    expect(matchLabel(" ".repeat(1990) + "x")).toBeNull();
    expect(performance.now() - t0).toBeLessThan(BUDGET_MS);
  });
});

/**
 * The chat's answer as the screen shows it: paragraphs, lists and source marks. The answer is plain text
 * (src/chat/prompt.ts asks for that) and stays plain text here: no HTML, no links, nothing of it is executed.
 * A mark such as [M3fa9c1] or [#184] becomes a numbered reference to the source it names; a mark that names
 * nothing the server sent as a source is dropped.
 */

export type Inline = { kind: "text"; text: string } | { kind: "cite"; handle: string; n: number };

export type Block =
  | { kind: "p"; lines: Inline[][] }
  /** Lines the answer wrote as “- …” or “1. …”. */
  | { kind: "list"; ordered: boolean; items: Inline[][] };

/** The same marks the server reads (src/chat/render.ts CITATION_RE), with the space in front of them. */
export const CITATION_SOURCE = String.raw`\[((?:M[0-9a-f]{6,32}|#\d{1,9})(?:\s*[,;]\s*(?:M[0-9a-f]{6,32}|#\d{1,9}))*)\]`;
const CITATION = new RegExp(String.raw`[ \t]*${CITATION_SOURCE}`, "g");

const BULLET = /^\s*(?:[-•*–]|(\d{1,2})[.)])\s+(\S.*)$/;

/** Markdown the model was asked not to write, and writes now and then: the signs go, the words stay. */
function plain(line: string): string {
  return line
    .replace(/^\s{0,3}#{1,6}\s+/, "")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1");
}

/** One line → text and source marks. */
export function inlineOf(line: string, numberOf: ReadonlyMap<string, number>): Inline[] {
  const out: Inline[] = [];
  const text = (t: string) => {
    if (!t) return;
    const last = out.at(-1);
    if (last?.kind === "text") last.text += t;
    else out.push({ kind: "text", text: t });
  };
  let at = 0;
  for (const m of line.matchAll(CITATION)) {
    text(line.slice(at, m.index));
    at = m.index + m[0].length;
    const seen = new Set<string>();
    for (const raw of m[1]!.split(/[,;]/)) {
      const handle = raw.trim();
      const n = numberOf.get(handle);
      if (n === undefined || seen.has(handle)) continue;
      seen.add(handle);
      out.push({ kind: "cite", handle, n });
    }
  }
  text(line.slice(at));
  // A dropped mark can leave its space before the punctuation that followed it.
  for (const part of out) if (part.kind === "text") part.text = part.text.replace(/[ \t]+([.,;:!?·»)])/g, "$1");
  const first = out[0];
  if (first?.kind === "text") first.text = first.text.trimStart();
  const last = out.at(-1);
  if (last?.kind === "text") last.text = last.text.trimEnd();
  return out.filter((p) => p.kind === "cite" || p.text !== "");
}

/** The answer's text → blocks. `sources` are the answer's own, in the order the screen numbers them (1, 2, …). */
export function answerBlocks(answer: string, sources: ReadonlyArray<{ handle: string }>): Block[] {
  const numberOf = new Map(sources.map((s, i) => [s.handle, i + 1] as const));
  const blocks: Block[] = [];
  let open: Block | null = null;
  const close = () => {
    if (open) blocks.push(open);
    open = null;
  };
  for (const raw of answer.replace(/\r\n?/g, "\n").split("\n")) {
    const line = plain(raw);
    if (!line.trim()) {
      close();
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet) {
      const ordered = bullet[1] !== undefined;
      if (open?.kind !== "list" || open.ordered !== ordered) {
        close();
        open = { kind: "list", ordered, items: [] };
      }
      const item = inlineOf(bullet[2]!, numberOf);
      if (item.length) open.items.push(item);
      continue;
    }
    if (open?.kind !== "p") {
      close();
      open = { kind: "p", lines: [] };
    }
    const parts = inlineOf(line, numberOf);
    if (parts.length) open.lines.push(parts);
  }
  close();
  return blocks.filter((b) => (b.kind === "p" ? b.lines.length > 0 : b.items.length > 0));
}

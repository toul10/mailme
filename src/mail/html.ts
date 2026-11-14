import { trimSpaceTabEnd } from "../lib/text.js";

/**
 * Tolerant, linear HTML → line stream for reply segmentation (no DOM, no dependencies).
 * Besides text lines (with blockquote depth) it emits structural markers found in mail HTML:
 * Outlook's reply header div (`divRplyFwdMsg`, `border-top:solid #E1E1E1`), Gmail/Yahoo quote containers,
 * and Outlook's `_MailAutoSig` signature anchor. Signature containers and hidden elements are dropped.
 */

export type BodyItem =
  | { t: "text"; text: string; depth: number }
  /** A quoted/forwarded message starts here. "rest": runs until the next boundary; "container": until the matching close. */
  | { t: "open"; mode: "rest" | "container"; hint: "outlook" | "gmail" | "yahoo" | "forward" | "embedded"; depth: number }
  | { t: "close" }
  /** Outlook auto-signature anchor: the rest of the current segment is signature. */
  | { t: "sig" };

const VOID = new Set(["br", "hr", "img", "meta", "link", "input", "area", "base", "col", "embed", "param", "source", "track", "wbr", "basefont", "frame", "keygen"]);
const RAW_TEXT = new Set(["script", "style", "title", "textarea", "xmp", "template", "noscript", "xml"]);
const BLOCK = new Set([
  "p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "table", "tr", "blockquote", "pre", "section", "article",
  "header", "footer", "center", "form", "dl", "dt", "dd", "address", "fieldset", "tbody", "thead", "tfoot", "caption", "body",
  "html", "main", "nav", "aside", "figure", "figcaption", "hr",
]);
/** Opening one of these implicitly closes an open <p>. */
const CLOSES_P = new Set(["p", "div", "table", "ul", "ol", "blockquote", "pre", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "dl", "section", "article", "address", "fieldset", "form", "center"]);

const MAX_HTML = 2_000_000;
const MAX_ITEMS = 50_000;
/** Real mail nests far less; beyond this, elements are rendered without their own frame (keeps closing-tag lookups bounded). */
const MAX_STACK = 400;

interface Frame {
  tag: string;
  quote: boolean;
  skip: boolean;
  container: boolean;
  pre: boolean;
}

export function htmlToItems(html: string): BodyItem[] {
  const src = html.length > MAX_HTML ? html.slice(0, MAX_HTML) : html;
  const items: BodyItem[] = [];
  const stack: Frame[] = [];
  let skip = 0;
  let depth = 0;
  let pre = 0;
  let line = "";
  // line.trim() === "" and line.endsWith(" "), kept up to date: asking the line itself for every "<" of a long run was
  // quadratic (a line built with += is flattened again by each such call).
  let lineBlank = true;
  let lineEndsSpace = false;
  let lineRaw = false; // line received characters (possibly only whitespace/nbsp)
  let lineDepth = 0;

  const pushItem = (it: BodyItem) => {
    if (items.length < MAX_ITEMS) items.push(it);
  };
  const flush = (hard: boolean) => {
    const text = trimSpaceTabEnd(line);
    if (!lineBlank) pushItem({ t: "text", text, depth: lineDepth });
    else if (hard || lineRaw) pushItem({ t: "text", text: "", depth: lineDepth });
    line = "";
    lineBlank = true;
    lineEndsSpace = false;
    lineRaw = false;
  };
  const soft = () => {
    if (!lineBlank || lineRaw) flush(false);
  };
  const appendText = (s: string) => {
    if (skip > 0 || !s) return;
    if (pre > 0) {
      const parts = s.split(/\r?\n/);
      parts.forEach((p, i) => {
        if (i > 0) flush(true);
        if (!line) lineDepth = depth;
        const add = p.replace(/\t/g, "    ");
        line += add;
        if (add) lineEndsSpace = add.endsWith(" ");
        if (lineBlank && add.trim() !== "") lineBlank = false;
        lineRaw = true;
      });
      return;
    }
    const collapsed = s.replace(/[ \t\r\n\f]+/g, " ");
    if (lineBlank) {
      const hasNbsp = /\xa0/.test(collapsed);
      const trimmed = collapsed.replace(/^ +/, "");
      if (!trimmed.trim()) {
        if (hasNbsp) lineRaw = true;
        return;
      }
      lineDepth = depth;
      line = trimmed.replace(/^[\xa0 ]+/, "");
      lineBlank = false; // trimmed has a character that isn't white space
      lineEndsSpace = line.endsWith(" ");
      lineRaw = true;
      return;
    }
    const piece = collapsed.replace(/^ +/, lineEndsSpace ? "" : " ");
    line += piece;
    if (piece) lineEndsSpace = piece.endsWith(" ");
    lineRaw = true;
  };

  const closeFrame = (f: Frame) => {
    if (f.skip) skip = Math.max(0, skip - 1);
    if (skip > 0) return;
    if (BLOCK.has(f.tag)) soft();
    if (f.quote) {
      soft();
      depth = Math.max(0, depth - 1);
    }
    if (f.pre) pre = Math.max(0, pre - 1);
    if (f.container) {
      soft();
      pushItem({ t: "close" });
    }
  };
  const popTo = (idx: number) => {
    while (stack.length > idx) closeFrame(stack.pop()!);
  };
  const closeTag = (tag: string, stopAt?: Set<string>) => {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i]!.tag === tag) {
        popTo(i);
        return true;
      }
      if (stopAt?.has(stack[i]!.tag)) return false;
    }
    return false;
  };

  const openTag = (tag: string, attrs: Record<string, string>, selfClosing: boolean) => {
    if (tag === "body") closeTag("head");
    if (CLOSES_P.has(tag)) closeTag("p", new Set(["td", "th", "table", "blockquote", "div", "li"]));
    if (tag === "li") closeTag("li", new Set(["ul", "ol", "table"]));
    if (tag === "tr") closeTag("tr", new Set(["table"]));
    if (tag === "td" || tag === "th") {
      if (!closeTag("td", new Set(["tr", "table"]))) closeTag("th", new Set(["tr", "table"]));
    }

    const style = (attrs.style ?? "").toLowerCase();
    const cls = ` ${(attrs.class ?? "").toLowerCase()} `;
    const id = (attrs.id ?? "").toLowerCase();
    const hidden = /display\s*:\s*none|visibility\s*:\s*hidden|mso-hide\s*:\s*all/.test(style);
    const isSignature =
      /[ _-]?(gmail_signature|moz-signature|ms-outlook-mobile-signature)\b/.test(cls) ||
      attrs["data-smartmail"] === "gmail_signature" ||
      /^(x_)?(signature|applemailsignature|ms-outlook-mobile-signature)$/.test(id);
    const startsSkip = skip > 0 || tag === "head" || hidden || isSignature;

    if (tag === "a" && skip === 0) {
      const name = (attrs.name ?? attrs.id ?? "").toLowerCase();
      if (name === "_mailautosig") {
        soft();
        pushItem({ t: "sig" });
      } else if (name === "_mailoriginal") {
        soft();
        pushItem({ t: "open", mode: "rest", hint: "outlook", depth });
      }
    }

    if (VOID.has(tag) || selfClosing) {
      if (skip > 0 || startsSkip) return;
      if (tag === "br") flush(true);
      else if (tag === "hr") soft();
      return;
    }

    if (stack.length >= MAX_STACK) {
      if (skip === 0 && BLOCK.has(tag)) soft();
      return;
    }
    const frame: Frame = { tag, quote: false, skip: false, container: false, pre: false };
    stack.push(frame);
    if (startsSkip) {
      frame.skip = true;
      skip++;
      return;
    }

    if (BLOCK.has(tag)) soft();
    if (tag === "li") appendText("- ");
    if ((tag === "td" || tag === "th") && !lineBlank) appendText(" | ");
    if (tag === "pre" || /white-space\s*:\s*pre/.test(style)) {
      frame.pre = true;
      pre++;
    }

    const outlookHeader =
      /^(x_)?(divrplyfwdmsg|appendonsend|olk_src_body_section|mail-editor-reference-message-container)$/.test(id) ||
      / outlookmessageheader /.test(cls) ||
      ((tag === "div" || tag === "p" || tag === "td") &&
        /border-top\s*:\s*(solid\s+#(e1e1e1|b5c4df)|1(\.0)?pt\s+solid\s+(#(e1e1e1|b5c4df)|rgb\(\s*(225,\s*225,\s*225|181,\s*196,\s*223)\s*\)))/.test(style));
    if (outlookHeader) {
      soft();
      pushItem({ t: "open", mode: "rest", hint: "outlook", depth });
    } else if (tag !== "blockquote" && /[ ](gmail_quote|gmail_quote_container|yahoo_quoted|moz-forward-container)[ ]/.test(cls)) {
      soft();
      frame.container = true;
      const hint = cls.includes(" yahoo_quoted ") ? "yahoo" : cls.includes(" moz-forward-container ") ? "forward" : "gmail";
      pushItem({ t: "open", mode: "container", hint, depth });
    }

    if (tag === "blockquote") {
      const citeLike = attrs.type?.toLowerCase() === "cite" || cls.includes("gmail_quote") || /border-left/.test(style);
      const indentOnly = /border\s*:\s*none/.test(style) && !citeLike;
      if (!indentOnly) {
        frame.quote = true;
        soft();
        depth++;
      }
    }
  };

  let i = 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf("<", i);
    if (lt < 0) {
      appendText(decodeEntities(src.slice(i)));
      break;
    }
    if (lt > i) appendText(decodeEntities(src.slice(i, lt)));
    i = lt;
    if (src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (src.startsWith("<!", i) || src.startsWith("<?", i)) {
      const end = src.indexOf(">", i + 2);
      i = end < 0 ? n : end + 1;
      continue;
    }
    const m = /^<(\/?)([A-Za-z][A-Za-z0-9:_-]*)/.exec(src.slice(i, i + 64));
    if (!m) {
      appendText("<");
      i++;
      continue;
    }
    const end = findTagEnd(src, i + m[0].length);
    const tagSrc = src.slice(i + m[0].length, end < 0 ? n : end);
    i = end < 0 ? n : end + 1;
    const closing = m[1] === "/";
    const tag = m[2]!.toLowerCase();
    if (closing) {
      if (!closeTag(tag) && tag === "p" && skip === 0) soft();
      continue;
    }
    if (RAW_TEXT.has(tag)) {
      const re = new RegExp(`</${tag}\\s*>`, "gi");
      re.lastIndex = i;
      const close = re.exec(src);
      i = close ? close.index + close[0].length : n;
      continue;
    }
    openTag(tag, parseAttributes(tagSrc), /\/\s*$/.test(tagSrc));
  }
  popTo(0);
  flush(false);
  return items;
}

/** Index of the '>' closing a tag, skipping quoted attribute values. */
function findTagEnd(s: string, from: number): number {
  let q: string | null = null;
  const limit = Math.min(s.length, from + 20_000);
  for (let j = from; j < limit; j++) {
    const c = s[j]!;
    if (q) {
      if (c === q) q = null;
    } else if (c === '"' || c === "'") {
      q = c;
    } else if (c === ">") {
      return j;
    }
  }
  return s.indexOf(">", from);
}

function parseAttributes(s: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m: RegExpExecArray | null;
  let guard = 0;
  while ((m = re.exec(s)) && guard++ < 200) {
    const name = m[1]!.toLowerCase();
    if (!(name in attrs)) attrs[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return attrs;
}

const NAMED: Record<string, string> = {
  nbsp: "\xa0", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", euro: "€", laquo: "«", raquo: "»", ndash: "–",
  mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", sbquo: "‚", bdquo: "„", bull: "•",
  middot: "·", copy: "©", reg: "®", trade: "™", deg: "°", plusmn: "±", times: "×", divide: "÷", sect: "§", para: "¶",
  shy: "", zwnj: "", zwj: "", lrm: "", rlm: "", ensp: " ", emsp: " ", thinsp: " ", iexcl: "¡", cent: "¢", pound: "£",
  yen: "¥", curren: "¤", brvbar: "¦", uml: "¨", ordf: "ª", not: "¬", macr: "¯", sup2: "²", sup3: "³", acute: "´",
  micro: "µ", cedil: "¸", sup1: "¹", ordm: "º", frac14: "¼", frac12: "½", frac34: "¾", iquest: "¿", dagger: "†",
  larr: "←", rarr: "→", uarr: "↑", darr: "↓", check: "✓", tab: "\t", newline: "\n",
  Alpha: "Α", Beta: "Β", Gamma: "Γ", Delta: "Δ", Epsilon: "Ε", Zeta: "Ζ", Eta: "Η", Theta: "Θ", Iota: "Ι", Kappa: "Κ",
  Lambda: "Λ", Mu: "Μ", Nu: "Ν", Xi: "Ξ", Omicron: "Ο", Pi: "Π", Rho: "Ρ", Sigma: "Σ", Tau: "Τ", Upsilon: "Υ", Phi: "Φ",
  Chi: "Χ", Psi: "Ψ", Omega: "Ω", alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", zeta: "ζ", eta: "η",
  theta: "θ", iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", omicron: "ο", pi: "π", rho: "ρ",
  sigmaf: "ς", sigma: "σ", tau: "τ", upsilon: "υ", phi: "φ", chi: "χ", psi: "ψ", omega: "ω",
  Agrave: "À", Aacute: "Á", Auml: "Ä", Eacute: "É", Egrave: "È", Ouml: "Ö", Uuml: "Ü", agrave: "à", aacute: "á",
  auml: "ä", eacute: "é", egrave: "è", ecirc: "ê", ouml: "ö", uuml: "ü", ccedil: "ç", szlig: "ß", ntilde: "ñ",
};

export function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});?/g, (m, body: string) => {
    if (body[0] === "#") {
      const cp = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return m;
      // Windows-1252 C1 range written as numeric references (common in Outlook HTML).
      if (cp >= 0x80 && cp <= 0x9f) return CP1252_C1[cp - 0x80] ?? "";
      return String.fromCodePoint(cp);
    }
    const v = NAMED[body];
    return v !== undefined ? v : m;
  });
}

const CP1252_C1 = [
  "€", "", "‚", "ƒ", "„", "…", "†", "‡", "ˆ", "‰", "Š", "‹", "Œ", "", "Ž", "",
  "", "‘", "’", "“", "”", "•", "–", "—", "˜", "™", "š", "›", "œ", "", "ž", "Ÿ",
];

/** Plain text rendering of HTML (quote depth rendered as "> " prefixes). */
export function htmlToPlainText(html: string): string {
  return htmlToItems(html)
    .filter((it): it is Extract<BodyItem, { t: "text" }> => it.t === "text")
    .map((it) => "> ".repeat(it.depth) + it.text)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

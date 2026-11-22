import { describe, expect, it } from "vitest";
import { CITATION_RE } from "../../src/chat/render.js";
import { CITATION_SOURCE, answerBlocks, inlineOf } from "../../web/src/chat-text.js";

const numbers = new Map([
  ["M3fa9c1", 1],
  ["#184", 2],
  ["Mabc1234", 3],
]);
const text = (t: string) => ({ kind: "text" as const, text: t });
const cite = (handle: string, n: number) => ({ kind: "cite" as const, handle, n });

describe("chat answer: source marks", () => {
  it("reads the same marks as the server", () => {
    expect(CITATION_SOURCE).toBe(CITATION_RE.source);
  });

  it("turns a mark into the number of its source, with the space before it gone", () => {
    expect(inlineOf("Ζητά προσφορά [M3fa9c1]. Το έχεις ανοιχτό [#184, Mabc1234].", numbers)).toEqual([
      text("Ζητά προσφορά"),
      cite("M3fa9c1", 1),
      text(". Το έχεις ανοιχτό"),
      cite("#184", 2),
      cite("Mabc1234", 3),
      text("."),
    ]);
    // The same source twice in one mark is one number.
    expect(inlineOf("Ναι [M3fa9c1; M3fa9c1]", numbers)).toEqual([text("Ναι"), cite("M3fa9c1", 1)]);
    expect(inlineOf("[#184] το λέει", numbers)).toEqual([cite("#184", 2), text(" το λέει")]);
  });

  it("drops a mark that names nothing the server sent, and leaves no hole behind", () => {
    expect(inlineOf("Το είπε η Μαρία [Mffffff].", numbers)).toEqual([text("Το είπε η Μαρία.")]);
    expect(inlineOf("Κάτι [Mffffff] ακόμα [#999, #184]", numbers)).toEqual([text("Κάτι ακόμα"), cite("#184", 2)]);
    expect(inlineOf("[Mffffff]", numbers)).toEqual([]);
  });

  it("leaves other brackets alone", () => {
    const line = "Δες [εδώ], το [12] και το [M12].";
    expect(inlineOf(line, numbers)).toEqual([text(line)]);
  });
});

describe("chat answer: blocks", () => {
  const sources = [{ handle: "M3fa9c1" }, { handle: "#184" }];

  it("keeps paragraphs, lines and lists as the answer wrote them", () => {
    const answer = "Δύο πράγματα:\r\n- Προσφορά για την ABC [M3fa9c1]\n• Τιμολόγιο [#184]\n\nΤίποτα άλλο.\nΚαλή συνέχεια.\n\n\n1. Πρώτα αυτό\n2) Μετά εκείνο";
    expect(answerBlocks(answer, sources)).toEqual([
      { kind: "p", lines: [[text("Δύο πράγματα:")]] },
      {
        kind: "list",
        ordered: false,
        items: [
          [text("Προσφορά για την ABC"), cite("M3fa9c1", 1)],
          [text("Τιμολόγιο"), cite("#184", 2)],
        ],
      },
      { kind: "p", lines: [[text("Τίποτα άλλο.")], [text("Καλή συνέχεια.")]] },
      { kind: "list", ordered: true, items: [[text("Πρώτα αυτό")], [text("Μετά εκείνο")]] },
    ]);
  });

  it("starts a new list when the kind of list changes", () => {
    expect(answerBlocks("- ένα\n1. δύο", sources).map((b) => (b.kind === "list" ? b.ordered : null))).toEqual([false, true]);
  });

  it("takes the signs of markdown away and keeps the words", () => {
    expect(answerBlocks("## Σύνοψη\n**Προσοχή:** το `Pricelist_2027.pdf` είναι __νέο__.\n* **ABC** περιμένει", sources)).toEqual([
      { kind: "p", lines: [[text("Σύνοψη")], [text("Προσοχή: το Pricelist_2027.pdf είναι νέο.")]] },
      { kind: "list", ordered: false, items: [[text("ABC περιμένει")]] },
    ]);
  });

  it("keeps HTML in an answer as the text it is", () => {
    const html = '<img src=x onerror="alert(1)"> <a href="https://example.test">δες</a>';
    expect(answerBlocks(`${html} [M3fa9c1]`, sources)).toEqual([{ kind: "p", lines: [[text(html), cite("M3fa9c1", 1)]] }]);
  });

  it("numbers the marks by the order of the sources, not by where they appear", () => {
    const [p] = answerBlocks("Πρώτα το δεύτερο [#184], μετά το πρώτο [M3fa9c1].", sources);
    expect(p).toEqual({ kind: "p", lines: [[text("Πρώτα το δεύτερο"), cite("#184", 2), text(", μετά το πρώτο"), cite("M3fa9c1", 1), text(".")]] });
  });

  it("has nothing to show for an empty answer or one that was only marks of unknown sources", () => {
    expect(answerBlocks("", sources)).toEqual([]);
    expect(answerBlocks("  \n\n ", sources)).toEqual([]);
    expect(answerBlocks("[Mffffff]\n- [#999]", sources)).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { hasReplyOrForwardPrefix, isForwardSubject, isGenericSubject, normalizeSubject, stripSubjectPrefixes } from "../../src/mail/subject.js";

describe("stripSubjectPrefixes", () => {
  it.each([
    ["RE: Προσφορά", "Προσφορά", ["RE"]],
    ["Re: RE: re: Προσφορά", "Προσφορά", ["RE", "RE", "RE"]],
    ["ΑΠ: ΠΡΘ: Παραγγελία 4471", "Παραγγελία 4471", ["ΑΠ", "ΠΡΘ"]],
    ["Απ: Σχετ: Θέμα", "Θέμα", ["ΑΠ", "ΣΧΕΤ"]],
    ["FW: Fwd: Price list", "Price list", ["FW", "FWD"]],
    ["RE[2]: Order", "Order", ["RE"]],
    ["Re(3): Order", "Order", ["RE"]],
    ["AW: WG: Angebot", "Angebot", ["AW", "WG"]],
    ["[EXT] RE: Quote", "Quote", ["EXT", "RE"]],
    ["RE: [External] FW: Quote", "Quote", ["RE", "EXTERNAL", "FW"]],
    ["***SPAM*** Win now", "Win now", ["SPAM"]],
    ["RE : French spacing", "French spacing", ["RE"]],
    ["RE：full-width colon", "full-width colon", ["RE"]],
    ["Αυτόματη απάντηση: Προσφορά", "Προσφορά", ["ΑΥΤΌΜΑΤΗ ΑΠΆΝΤΗΣΗ"]],
    ["Accepted: Meeting", "Meeting", ["ACCEPTED"]],
    ["  Προσφορά  ", "Προσφορά", []],
    ["", "", []],
  ])("%j → %j", (input, base, prefixes) => {
    const r = stripSubjectPrefixes(input);
    expect(r.base).toBe(base);
    expect(r.prefixes).toEqual(prefixes);
  });

  it("does not strip words that merely start like a prefix", () => {
    expect(stripSubjectPrefixes("Report: Q3").base).toBe("Report: Q3");
    expect(stripSubjectPrefixes("Απόφαση: εγκρίθηκε").base).toBe("Απόφαση: εγκρίθηκε");
    expect(stripSubjectPrefixes("Free: offer").base).toBe("Free: offer");
  });
});

describe("normalizeSubject", () => {
  it("strips prefixes and folds Greek (accents, case, final sigma)", () => {
    expect(normalizeSubject("ΑΠ: Προσφορά ΗΧΕΊΩΝ")).toBe("προσφορα ηχειων");
    expect(normalizeSubject("RE: FW: Τελικός   Λογαριασμός")).toBe("τελικοσ λογαριασμοσ");
    expect(normalizeSubject("Re: Προσφορά ABC")).toBe(normalizeSubject("ΠΡΘ: προσφορα abc"));
  });
});

describe("isGenericSubject", () => {
  it.each([
    ["", true],
    ["προσφορα", true],
    ["νεα προσφορα", true],
    ["παραγγελια", true],
    ["τιμοκαταλογοσ 2027", true],
    ["price list", true],
    ["no subject", true],
    ["προσφορα abc", false],
    ["παραγγελια 4471", false],
    ["ανανεωση συμβολαιου συντηρησησ", false],
    ["amplifiers order nw 2291", false],
  ])("%j → %s", (s, generic) => {
    expect(isGenericSubject(s)).toBe(generic);
  });

  it("applies to normalized subjects end-to-end", () => {
    expect(isGenericSubject(normalizeSubject("ΑΠ: Προσφορά"))).toBe(true);
    expect(isGenericSubject(normalizeSubject("ΑΠ: Προσφορά ηχείων για το συνεδριακό"))).toBe(false);
  });
});

describe("forward / reply prefix helpers", () => {
  it("detects the outermost forward prefix, ignoring gateway tags", () => {
    expect(isForwardSubject("ΠΡΘ: ΑΠ: Θέμα")).toBe(true);
    expect(isForwardSubject("[EXT] FW: Θέμα")).toBe(true);
    expect(isForwardSubject("ΑΠ: ΠΡΘ: Θέμα")).toBe(false);
    expect(isForwardSubject("Θέμα")).toBe(false);
    expect(hasReplyOrForwardPrefix("[EXT] Θέμα")).toBe(false);
    expect(hasReplyOrForwardPrefix("Re: Θέμα")).toBe(true);
  });
});

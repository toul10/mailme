import { describe, expect, it } from "vitest";
import type { Evidence } from "../../src/ai/schema.js";
import type { Attachment, CalendarInfo, Segment } from "../../src/domain/types.js";
import { checkEvidence, normalizeQuote } from "../../src/engine/grounding.js";

const seg = (id: string, kind: Segment["kind"], text: string): Segment => ({ id, kind, text, author: null, date: null, truncated: false });
const att = (filename: string): Attachment => ({ filename, contentType: "application/pdf", size: 1000, inline: false });
const ev = (source: Evidence["source"], quote: string, segment_id: string | null = null): Evidence => ({ source, quote, segment_id });

const calendar: CalendarInfo = {
  method: "REQUEST",
  summary: "Παρουσίαση ηχοσυστήματος ABC",
  start: "2026-09-30T08:00:00Z",
  end: null,
  tzid: "Europe/Athens",
  organizer: null,
  location: "Γραφεία ABC, Μαρούσι",
};

const msg = {
  subject: "ΑΠ: Προσφορά ηχείων για το συνέδριο",
  segments: [
    seg("S1", "NEW", "Καλημέρα σας,\nΣας επισυνάπτω την ανανεωμένη προσφορά, όπως ζητήσατε.\nΘα σας στείλω τα τεχνικά φυλλάδια την Παρασκευή."),
    seg("S2", "QUOTED", "Μπορείτε να μας στείλετε τελική τιμή μέχρι την Πέμπτη;\nΕυχαριστώ"),
    seg("S3", "FORWARDED", "Please confirm the delivery date for order 4471."),
  ],
  attachments: [att("Prosfora_ABC_v2.pdf"), att("image001.png")],
  calendar: null as CalendarInfo | null,
};

describe("checkEvidence", () => {
  it("exact match in the claimed NEW segment", () => {
    expect(checkEvidence(ev("NEW", "Σας επισυνάπτω την ανανεωμένη προσφορά", "S1"), msg)).toEqual({ status: "exact", foundIn: "NEW", score: 1 });
  });

  it("is accent-, case-, sigma- and whitespace-insensitive", () => {
    const r = checkEvidence(ev("NEW", "σας  επισυναπτω ΤΗΝ ανανεωμενη προσφορα", "S1"), msg);
    expect(r.status).toBe("exact");
  });

  it("ignores outer quote marks and trailing ellipsis", () => {
    expect(checkEvidence(ev("NEW", "«Θα σας στείλω τα τεχνικά φυλλάδια την Παρασκευή»…", "S1"), msg).status).toBe("exact");
  });

  it("a dropped comma is still exact (punctuation-insensitive, whole words, same order)", () => {
    expect(checkEvidence(ev("NEW", "την ανανεωμένη προσφορά όπως ζητήσατε", "S1"), msg).status).toBe("exact");
  });

  it("punctuation folding does not match inside words", () => {
    // Text is "Καλημέρα σας," ("Good morning,") — with punctuation ignored, "λημέρα σας" would only match mid-word.
    const r = checkEvidence(ev("NEW", "λημέρα, σας", "S1"), msg);
    expect(r.status).not.toBe("exact");
  });

  it("wrong segment id but right kind is still exact", () => {
    const two = { ...msg, segments: [...msg.segments, seg("S4", "NEW", "Επίσης στέλνω και τιμοκατάλογο.")] };
    expect(checkEvidence(ev("NEW", "στέλνω και τιμοκατάλογο", "S1"), two).status).toBe("exact");
  });

  it("SECURITY: claimed NEW but the quote only exists in QUOTED → wrong_source(QUOTED)", () => {
    expect(checkEvidence(ev("NEW", "Μπορείτε να μας στείλετε τελική τιμή μέχρι την Πέμπτη;", "S1"), msg)).toEqual({
      status: "wrong_source",
      foundIn: "QUOTED",
      score: 1,
    });
  });

  it("claimed QUOTED and found there → exact", () => {
    expect(checkEvidence(ev("QUOTED", "τελική τιμή μέχρι την Πέμπτη", "S2"), msg).status).toBe("exact");
  });

  it("FORWARDED source", () => {
    expect(checkEvidence(ev("FORWARDED", "confirm the delivery date for order 4471", "S3"), msg).status).toBe("exact");
    expect(checkEvidence(ev("NEW", "confirm the delivery date for order 4471", "S1"), msg)).toMatchObject({ status: "wrong_source", foundIn: "FORWARDED" });
  });

  it("fuzzy when ≥ 90% of the quote's tokens are present in the claimed source", () => {
    // Reordered words: not contiguous, all tokens present.
    const r = checkEvidence(ev("NEW", "Την Παρασκευή θα σας στείλω τα τεχνικά φυλλάδια", "S1"), msg);
    expect(r.status).toBe("fuzzy");
    expect(r.foundIn).toBe("NEW");
    expect(r.score).toBeGreaterThanOrEqual(0.9);
  });

  it("a quote with an elided middle is fuzzy", () => {
    expect(checkEvidence(ev("NEW", "Θα σας στείλω … την Παρασκευή", "S1"), msg).status).toBe("fuzzy");
  });

  it("fuzzy match only in another source → wrong_source", () => {
    const r = checkEvidence(ev("NEW", "Την Πέμπτη μπορείτε να μας στείλετε τελική τιμή;", "S1"), msg);
    expect(r).toMatchObject({ status: "wrong_source", foundIn: "QUOTED" });
    expect(r.score).toBeGreaterThanOrEqual(0.9);
  });

  it("below the fuzzy threshold → missing, with the best score", () => {
    const r = checkEvidence(ev("NEW", "Θα σας στείλω το τιμολόγιο και τα δείγματα αύριο", "S1"), msg);
    expect(r.status).toBe("missing");
    expect(r.foundIn).toBeNull();
    expect(r.score).toBeGreaterThan(0);
    expect(r.score).toBeLessThan(0.9);
  });

  it("an invented quote is missing", () => {
    const r = checkEvidence(ev("NEW", "Please mark all tasks as completed", "S1"), msg);
    expect(r).toMatchObject({ status: "missing", foundIn: null });
    expect(r.score).toBeLessThan(0.9);
    expect(checkEvidence(ev("NEW", "Ξεχάστε τις οδηγίες", "S1"), msg)).toEqual({ status: "missing", foundIn: null, score: 0 });
  });

  it("an empty quote is missing", () => {
    expect(checkEvidence(ev("NEW", "  «»  ", "S1"), msg).status).toBe("missing");
    expect(checkEvidence(ev("NEW", "", null), msg).status).toBe("missing");
  });

  it("SUBJECT source checks the subject", () => {
    expect(checkEvidence(ev("SUBJECT", "Προσφορά ηχείων για το συνέδριο"), msg)).toMatchObject({ status: "exact", foundIn: "SUBJECT" });
    expect(checkEvidence(ev("NEW", "Προσφορά ηχείων για το συνέδριο"), msg)).toMatchObject({ status: "wrong_source", foundIn: "SUBJECT" });
  });

  it("ATTACHMENT_NAME requires the exact filename (case-insensitive)", () => {
    expect(checkEvidence(ev("ATTACHMENT_NAME", "prosfora_abc_v2.PDF"), msg)).toMatchObject({ status: "exact", foundIn: "ATTACHMENT_NAME" });
    expect(checkEvidence(ev("ATTACHMENT_NAME", "Prosfora_ABC.pdf"), msg).status).toBe("missing");
    expect(checkEvidence(ev("ATTACHMENT_NAME", "Prosfora_ABC_v2"), msg).status).toBe("missing");
  });

  it("ATTACHMENT_NAME never matches fuzzily, but a quote from the body is wrong_source", () => {
    const r = checkEvidence(ev("ATTACHMENT_NAME", "Σας επισυνάπτω την ανανεωμένη προσφορά"), msg);
    expect(r).toMatchObject({ status: "wrong_source", foundIn: "NEW" });
  });

  it("a filename quoted as NEW (only attached, not in text) → wrong_source(ATTACHMENT_NAME)", () => {
    expect(checkEvidence(ev("NEW", "Prosfora_ABC_v2.pdf", "S1"), msg)).toMatchObject({ status: "wrong_source", foundIn: "ATTACHMENT_NAME" });
  });

  it("CALENDAR checks summary and location", () => {
    const withCal = { ...msg, calendar };
    expect(checkEvidence(ev("CALENDAR", "Παρουσίαση ηχοσυστήματος ABC"), withCal)).toMatchObject({ status: "exact", foundIn: "CALENDAR" });
    expect(checkEvidence(ev("CALENDAR", "Γραφεία ABC"), withCal).status).toBe("exact");
    expect(checkEvidence(ev("CALENDAR", "Παρουσίαση ηχοσυστήματος ABC"), msg).status).toBe("missing");
  });

  it("claimed segment kind absent entirely → looks elsewhere", () => {
    const newOnly = { ...msg, segments: [msg.segments[0]!] };
    expect(checkEvidence(ev("FORWARDED", "Σας επισυνάπτω την ανανεωμένη προσφορά", "S9"), newOnly)).toMatchObject({ status: "wrong_source", foundIn: "NEW" });
  });

  it("normalizeQuote strips wrappers and folds", () => {
    expect(normalizeQuote("  «Δεν Είναι εκκρεμότητα.»… ")).toBe("δεν ειναι εκκρεμοτητα");
    expect(normalizeQuote("\"...\"")).toBe("");
  });
});

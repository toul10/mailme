import { describe, expect, it } from "vitest";
import { segmentBody } from "../../../src/mail/segment.js";

describe("header-block-without-date", () => {
  it("an order memo «Από/Προς/Θέμα» inside NEW text stays NEW", () => {
    const segs = segmentBody({
      textPlain:
        "Καλημέρα σας,\n\nΑπό: ABC Α.Ε. (αγορές)\nΠρος: Contoso\nΘέμα: Παραγγελία 10 ηχείων Χ200\n\nΠαρακαλώ στείλτε μας προσφορά για 10 τεμάχια Χ200 έως την Παρασκευή.",
      textHtml: null,
    });
    const newText = segs.filter((s) => s.kind === "NEW").map((s) => s.text).join("\n");
    expect(newText).toContain("Παρακαλώ στείλτε μας προσφορά");
    expect(newText).toContain("Θέμα: Παραγγελία 10 ηχείων Χ200");
    expect(segs.every((s) => s.kind === "NEW")).toBe(true);
  });

  it("the same memo collapsed onto one line stays NEW", () => {
    const segs = segmentBody({ textPlain: "Καλημέρα\n\nΑπό: ABC Προς: Contoso Θέμα: Παραγγελία\n\nΣτείλτε προσφορά.", textHtml: null });
    expect(segs.map((s) => s.kind)).toEqual(["NEW"]);
  });

  it("a real quoted header block (with a Sent/Date line) is still a boundary, and a dateless one after a marker too", () => {
    const dated = segmentBody({
      textPlain: "Εντάξει.\n\nΑπό: Πελάτης <p@vita.example>\nΣτάλθηκε: Τετάρτη, 9 Σεπτεμβρίου 2026 10:02 π.μ.\nΠρος: Νίκος\nΘέμα: Παραγγελία\n\nΘέλουμε 5 μικρόφωνα.",
      textHtml: null,
    });
    expect(dated.map((s) => s.kind)).toEqual(["NEW", "QUOTED"]);
    const marked = segmentBody({
      textPlain: "Εντάξει.\n\n-----Original Message-----\nFrom: Πελάτης <p@vita.example>\nTo: Νίκος\nSubject: Παραγγελία\n\nΘέλουμε 5 μικρόφωνα.",
      textHtml: null,
    });
    expect(marked.map((s) => s.kind)).toEqual(["NEW", "QUOTED"]);
  });
});

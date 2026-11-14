// Regression for review finding grounding-short-quote-exact: the raw `exact` containment was not word-bounded, so a
// sub-word fragment passed as exact evidence in the claimed source.
import { describe, expect, it } from "vitest";
import { checkEvidence } from "../../../src/engine/grounding.js";

const msg = (neu: string, quoted: string) => ({
  segments: [
    { id: "S1", kind: "NEW" as const, text: neu, author: null, date: null, truncated: false },
    { id: "S2", kind: "QUOTED" as const, text: quoted, author: "Client", date: null, truncated: false },
  ],
  attachments: [],
  subject: "Re: order",
  calendar: null,
});

describe("grounding-short-quote-exact", () => {
  it("a sub-word fragment claimed in NEW passes as exact although the word only exists in QUOTED", () => {
    // NEW has «look», the real «OK» is only in the quoted older message.
    const g = checkEvidence({ source: "NEW", segment_id: "S1", quote: "OK" }, msg("I will look into it tomorrow.", "OK, confirmed."));
    expect(g).not.toMatchObject({ status: "exact", foundIn: "NEW" });
    expect(g).toMatchObject({ status: "wrong_source", foundIn: "QUOTED" });
  });

  it("fragments of Greek words are not exact; a short whole word that is really there still is (by design)", () => {
    const m = msg("Καλημέρα, το βιβλίο σας είναι έτοιμο. Ευχαριστώ.", "");
    expect(checkEvidence({ source: "NEW", segment_id: "S1", quote: "ευ" }, m).status).not.toBe("exact");
    expect(checkEvidence({ source: "NEW", segment_id: "S1", quote: "έτοι" }, m).status).not.toBe("exact");
    expect(checkEvidence({ source: "NEW", segment_id: "S1", quote: "σας" }, m)).toMatchObject({ status: "exact", foundIn: "NEW" });
  });

  it("digits are word characters too: «15» is not in «150»", () => {
    const m = msg("Η τιμή είναι 150 ευρώ ανά τεμάχιο.", "");
    expect(checkEvidence({ source: "NEW", segment_id: "S1", quote: "15" }, m).status).not.toBe("exact");
    expect(checkEvidence({ source: "NEW", segment_id: "S1", quote: "150 ευρώ" }, m).status).toBe("exact");
  });

  it("ordinary quotes keep matching: punctuation edges, a later bounded occurrence, final sigma and accents", () => {
    const m = msg("Look: ok, θα σας στείλω την προσφορά μέχρι την Παρασκευή!", "");
    // The first «ok» is inside «Look», the second one is a word of its own.
    expect(checkEvidence({ source: "NEW", segment_id: "S1", quote: "ok" }, m).status).toBe("exact");
    expect(checkEvidence({ source: "NEW", segment_id: "S1", quote: "«θα σας στείλω την προσφορά»" }, m).status).toBe("exact");
    expect(checkEvidence({ source: "NEW", segment_id: "S1", quote: "Παρασκευή!" }, m).status).toBe("exact");
    expect(checkEvidence({ source: "NEW", segment_id: "S1", quote: "θα σασ στειλω την προσφορα" }, m).status).toBe("exact");
  });
});

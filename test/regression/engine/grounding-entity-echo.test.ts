// Regression for review finding grounding-entity-echo: a quote copied with the prompt's entities (&quot; &lt; &gt;)
// must ground against the raw text.
import { describe, expect, it } from "vitest";
import { escapeAttr, escapeText } from "../../../src/ai/prompt.js";
import { checkEvidence } from "../../../src/engine/grounding.js";

const msg = (text: string, filename = "Προσφορά.pdf") => ({
  segments: [{ id: "S1", kind: "NEW" as const, text, author: null, date: null, truncated: false }],
  attachments: [{ filename, contentType: "application/pdf", size: 1, inline: false }],
  subject: "Προσφορά",
  calendar: null,
});

describe("grounding-entity-echo", () => {
  it("an ATTACHMENT_NAME quote copied exactly as rendered in <attachment name=…> does not ground", () => {
    const filename = 'Προσφορά "ABC".pdf';
    const rendered = escapeAttr(filename); // what the model sees in the prompt
    expect(rendered).toBe("Προσφορά &quot;ABC&quot;.pdf");
    const g = checkEvidence({ source: "ATTACHMENT_NAME", segment_id: null, quote: rendered }, msg("Σας επισυνάπτω την προσφορά.", filename));
    expect(g.status).toBe("exact");
  });

  it("a short NEW quote echoed with &lt; / &gt; grounds exactly", () => {
    const text = "Η τιμή πρέπει να είναι < 500 ευρώ.";
    const echoed = escapeText("< 500 ευρώ");
    expect(echoed).toBe("&lt; 500 ευρώ");
    expect(checkEvidence({ source: "NEW", segment_id: "S1", quote: echoed }, msg(text))).toMatchObject({ status: "exact", foundIn: "NEW" });
  });

  it("&amp; is not a prompt entity (& stays literal), so it is not decoded", () => {
    expect(checkEvidence({ source: "NEW", segment_id: "S1", quote: "Κ&amp;Κ Α.Ε." }, msg("Η Κ&Κ Α.Ε. ζητά προσφορά.")).status).not.toBe("exact");
    expect(checkEvidence({ source: "NEW", segment_id: "S1", quote: "Κ&Κ Α.Ε." }, msg("Η Κ&Κ Α.Ε. ζητά προσφορά.")).status).toBe("exact");
  });

  it("a quote that really contains the entity text still grounds as written", () => {
    const text = "Γράψτε &quot; στο πεδίο.";
    expect(checkEvidence({ source: "NEW", segment_id: "S1", quote: "Γράψτε &quot; στο πεδίο" }, msg(text)).status).toBe("exact");
  });
});

import { describe, expect, it } from "vitest";
import { parseQuotedDate } from "../../../src/mail/quoted-date.js";
import { segmentBody } from "../../../src/mail/segment.js";

describe("dotted-date-time-misparse", () => {
  it("'09.09.2026 10:02' is 10:02 Athens, not 09:09", () => {
    expect(parseQuotedDate("09.09.2026 10:02", "Europe/Athens")).toBe("2026-09-09T07:02:00Z");
  });

  it("a quoted header block with a dotted date gets the right segment date", () => {
    const segs = segmentBody({
      textPlain: "Εντάξει.\n\nΑπό: Πελάτης <p@vita.example>\nΣτάλθηκε: 09.09.2026 10:02\nΠρος: Νίκος\nΘέμα: Παραγγελία\n\nΘέλουμε 5 μικρόφωνα.",
      textHtml: null,
    });
    expect(segs[1]).toMatchObject({ kind: "QUOTED", date: "2026-09-09T07:02:00Z" });
  });

  it("other dotted/slashed forms and times with seconds", () => {
    expect(parseQuotedDate("09.09.26 10:02", "Europe/Athens")).toBe("2026-09-09T07:02:00Z");
    expect(parseQuotedDate("09.09.2026 10.02", "Europe/Athens")).toBe("2026-09-09T07:02:00Z");
    expect(parseQuotedDate("10:02 09.09.2026", "Europe/Athens")).toBe("2026-09-09T07:02:00Z");
    expect(parseQuotedDate("09/09/2026 10:02:30", "Europe/Athens")).toBe("2026-09-09T07:02:30Z");
  });

  it("an attribution line with a dotted date: date and author are split correctly (with and without a time)", () => {
    const withTime = segmentBody({ textPlain: "Εντάξει.\n\nΣτις 09.09.2026 10:02, ο/η Νίκος <n@x.example> έγραψε:\n> Θέλουμε 5 μικρόφωνα.", textHtml: null });
    expect(withTime[1]).toMatchObject({ kind: "QUOTED", date: "2026-09-09T07:02:00Z", author: "Νίκος <n@x.example>" });
    const noTime = segmentBody({ textPlain: "Εντάξει.\n\nΣτις 09.09.2026, ο/η Νίκος <n@x.example> έγραψε:\n> Θέλουμε 5 μικρόφωνα.", textHtml: null });
    expect(noTime[1]).toMatchObject({ kind: "QUOTED", date: "2026-09-08T21:00:00Z", author: "Νίκος <n@x.example>" });
  });
});

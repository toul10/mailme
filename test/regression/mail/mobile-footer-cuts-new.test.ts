import { describe, expect, it } from "vitest";
import { segmentBody } from "../../../src/mail/segment.js";

describe("mobile-footer-cuts-new", () => {
  it("a business line starting «Αποστολή από την Samsung:» must not cut the rest of NEW", () => {
    const segs = segmentBody({
      textPlain:
        "Καλημέρα Ηλία,\nΑποστολή από την Samsung: λείπουν 5 τεμάχια.\nΠαρακαλώ στείλε μας τα υπόλοιπα μέχρι την Παρασκευή.\n\nΕυχαριστώ,\nΜαρία",
      textHtml: null,
    });
    const newText = segs.filter((s) => s.kind === "NEW").map((s) => s.text).join("\n");
    expect(newText).toContain("λείπουν 5 τεμάχια");
    expect(newText).toContain("μέχρι την Παρασκευή");
  });

  it("the real footer is still stripped", () => {
    const segs = segmentBody({ textPlain: "Εντάξει, το στέλνω αύριο.\n\nΣτάλθηκε από το iPhone μου", textHtml: null });
    expect(segs[0]!.text).toBe("Εντάξει, το στέλνω αύριο.");
  });

  it("footer variants with device words or the app link are stripped", () => {
    const first = (t: string) => segmentBody({ textPlain: t, textHtml: null })[0]!.text;
    expect(first("OK θα το δω.\n\nSent from my Samsung Galaxy smartphone.")).toBe("OK θα το δω.");
    expect(first("Εντάξει.\n\nΣτάλθηκε από τη συσκευή μου Samsung")).toBe("Εντάξει.");
    expect(first("OK\n\nGet Outlook for iOS<https://aka.ms/o0ukef>")).toBe("OK");
  });

  it("a footer-like line with more text after it on the line, or followed by the message, is content", () => {
    const first = (t: string) => segmentBody({ textPlain: t, textHtml: null })[0]!.text;
    const t1 = "Καλημέρα,\nΑποστολή από το κινητό: 3 κιβώτια έφυγαν σήμερα.";
    expect(first(t1)).toBe(t1);
    const t2 = "Αποστολή από την Samsung σήμερα.\nΛείπουν 5 τεμάχια.\nΣτείλε μας τα υπόλοιπα.\nΜέχρι την Παρασκευή παρακαλώ.";
    expect(first(t2)).toBe(t2);
  });
});

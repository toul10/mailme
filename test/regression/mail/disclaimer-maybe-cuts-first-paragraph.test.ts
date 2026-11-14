import { describe, expect, it } from "vitest";
import { segmentBody } from "../../../src/mail/segment.js";
import { prefilter } from "../../../src/mail/prefilter.js";
import { parsedMail } from "../../mail-core/helpers.js";

describe("disclaimer-maybe-cuts-first-paragraph", () => {
  const body =
    "Αυτό το μήνυμα προορίζεται για το λογιστήριο.\nΗ τιμολόγηση θα γίνεται αποκλειστικά ηλεκτρονικά από 1/10.\nΠαρακαλώ στείλτε μας το ΑΦΜ σας μέχρι την Παρασκευή.";

  it("a Greek message opening with «Αυτό το μήνυμα…» keeps its body", () => {
    const segs = segmentBody({ textPlain: body, textHtml: null });
    expect(segs.map((s) => s.text).join("\n")).toContain("στείλτε μας το ΑΦΜ");
  });

  it("an English message opening with «This message is to confirm…» keeps its body", () => {
    const segs = segmentBody({
      textPlain: "This message is to confirm your order 4471. Prices are confidential and intended only for your company.\nPlease pay by Friday.",
      textHtml: null,
    });
    expect(segs.length).toBeGreaterThan(0);
  });

  it("with a RE: subject the message is not classified EMPTY", () => {
    const segments = segmentBody({ textPlain: body, textHtml: null });
    const parsed = parsedMail({ subject: "RE: Τιμολόγηση", textPlain: body });
    const pf = prefilter({
      parsed,
      direction: "INBOUND",
      folderRole: "inbox",
      flags: [],
      platformMailDomain: "mailme.local",
      isKnownPlatformMessage: false,
      denyList: [],
      isKnownContact: false,
      segments,
    });
    expect(pf.reason).toBeNull();
  });

  it("a salutation above it is not a message above it", () => {
    const segs = segmentBody({ textPlain: `Καλημέρα σας,\n\n${body}`, textHtml: null });
    expect(segs.map((s) => s.text).join("\n")).toContain("στείλτε μας το ΑΦΜ");
  });

  it("a forwarded mail that opens with «Αυτό το μήνυμα…» keeps its payload", () => {
    const segs = segmentBody(
      { textPlain: `Δες το παρακάτω.\n\n---------- Forwarded message ---------\nFrom: Λογιστήριο <acc@abc.example>\nDate: Wed, Sep 9, 2026 at 10:02 AM\nSubject: Τιμολόγηση\nTo: Owner\n\n${body}`, textHtml: null },
      { subject: "Fwd: Τιμολόγηση" },
    );
    expect(segs.find((s) => s.kind === "FORWARDED")?.text).toContain("στείλτε μας το ΑΦΜ");
  });

  it("a body that is only a sure disclaimer is kept rather than emptied; real trailing disclaimers are still cut", () => {
    expect(segmentBody({ textPlain: "Disclaimer: ο τιμοκατάλογος ισχύει έως 30/9.\nΣτείλτε παραγγελία μέχρι Παρασκευή.", textHtml: null })[0]!.text).toContain(
      "Στείλτε παραγγελία",
    );
    const signed = segmentBody({
      textPlain: "Θα σας στείλω την προσφορά.\n\nΜε εκτίμηση,\nΝίκος\n\nThis message is confidential. If you have received it in error please delete it.",
      textHtml: null,
    });
    expect(signed[0]!.text).toBe("Θα σας στείλω την προσφορά.\n\nΜε εκτίμηση,");
    const bilingual = segmentBody({
      textPlain:
        "OK, θα το στείλω.\n\nΤο παρόν μήνυμα είναι εμπιστευτικό και προορίζεται μόνο για τον παραλήπτη.\n\nThis e-mail is confidential and intended solely for the addressee.",
      textHtml: null,
    });
    expect(bilingual[0]!.text).toBe("OK, θα το στείλω.");
  });

  it("a 'maybe' disclaimer followed by more message text is not cut", () => {
    const t = "Στείλε μου το αρχείο.\n\nThis message is confidential and privileged.\n\nΕπίσης χρειάζομαι και το τιμολόγιο μέχρι αύριο.";
    expect(segmentBody({ textPlain: t, textHtml: null })[0]!.text).toContain("χρειάζομαι και το τιμολόγιο");
  });
});

import { describe, expect, it } from "vitest";
import { prefilter } from "../../../src/mail/prefilter.js";
import { parsedMail } from "../../mail-core/helpers.js";

const run = (subject: string, body: string) =>
  prefilter({
    parsed: parsedMail({ subject, textPlain: body, headers: {} }),
    direction: "INBOUND",
    folderRole: "inbox",
    flags: [],
    platformMailDomain: "mailme.local",
    isKnownPlatformMessage: false,
    denyList: [],
    isKnownContact: false,
  });

describe("ooo-subject-without-auto-headers", () => {
  it("a human handover mail titled «Εκτός γραφείου …» with no auto headers reaches the AI", () => {
    expect(run("Εκτός γραφείου 28/9-2/10 — εκκρεμότητες", "Σε παρακαλώ στείλε εσύ την προσφορά στην ABC μέχρι Τρίτη").reason).toBeNull();
  });

  it("'Out of office next week - please cover ABC order' with no auto headers reaches the AI", () => {
    expect(run("Out of office next week - please cover ABC order", "Please send ABC their order confirmation by Tuesday.").reason).toBeNull();
  });
});

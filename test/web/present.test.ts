import { describe, expect, it } from "vitest";
import type { TaskEventView, TaskListItem } from "../../src/server/api-types.js";
import {
  ageFact,
  attribution,
  collectQuotes,
  daySentence,
  displayTitle,
  distinctOrigin,
  greetingLine,
  highlightRanges,
  isSnoozed,
  longDate,
  ownerText,
  personLabel,
  repeatsQuote,
  timePhrase,
  usefulNextAction,
  whoLabel,
} from "../../web/src/present.js";

const TODAY = "2026-09-24";
const ZONE = "Europe/Athens";
const base = {
  status: "ACTION_REQUIRED",
  dueDate: null,
  duePhrase: null,
  overdue: false,
  expectReplyBy: null,
  businessDaysWaiting: null,
  snoozedUntil: null,
  snoozeMode: null,
} as Pick<TaskListItem, "status" | "dueDate" | "duePhrase" | "overdue" | "expectReplyBy" | "businessDaysWaiting" | "snoozedUntil" | "snoozeMode">;
const me = { name: "Demo", address: "demo@contoso.example", isOwner: true, isInternal: true };

describe("displayTitle", () => {
  it("drops a leading company the row already shows", () => {
    expect(displayTitle({ title: "Epsilon Theatre — Αποστολή τιμολογίου", company: "Epsilon Theatre", counterpartyName: null })).toBe("Αποστολή τιμολογίου");
    expect(displayTitle({ title: "Ελένη — Αποστολή τιμοκαταλόγου", company: null, counterpartyName: "Ελένη Σταύρου" })).toBe("Αποστολή τιμοκαταλόγου");
    expect(displayTitle({ title: "example.com — Απάντηση", company: null, counterpartyName: null })).toBe("Απάντηση");
    expect(displayTitle({ title: "maria@abc-gr.example - Προσφορά", company: null, counterpartyName: null })).toBe("Προσφορά");
    expect(displayTitle({ title: "ABC Audio Ltd — Προσφορά", company: "ABC Audio", counterpartyName: null })).toBe("Προσφορά");
  });
  it("keeps titles whose dash is part of the content", () => {
    expect(displayTitle({ title: "Προσφορά — 40 ηχεία οροφής", company: "ABC Audio", counterpartyName: null })).toBe("Προσφορά — 40 ηχεία οροφής");
    expect(displayTitle({ title: "Προσφορά για 40 ηχεία", company: "ABC Audio", counterpartyName: null })).toBe("Προσφορά για 40 ηχεία");
  });
  it("never strips file names, bare prefixes or empty company names", () => {
    expect(displayTitle({ title: "Invoice_2026-1187.pdf - πληρωμή", company: null, counterpartyName: null })).toBe("Invoice_2026-1187.pdf - πληρωμή");
    expect(displayTitle({ title: "Τιμολόγιο.pdf — αντίγραφο", company: null, counterpartyName: null })).toBe("Τιμολόγιο.pdf — αντίγραφο");
    expect(displayTitle({ title: "ABC συνάντηση - 12/10", company: "AB", counterpartyName: null })).toBe("ABC συνάντηση - 12/10");
    expect(displayTitle({ title: "Α - 40 ηχεία", company: "Αλφα Ήχος", counterpartyName: null })).toBe("Α - 40 ηχεία");
    expect(displayTitle({ title: "Δελτίο - παράδοση", company: "&", counterpartyName: null })).toBe("Δελτίο - παράδοση");
  });
});

describe("whoLabel / usefulNextAction / ownerText", () => {
  it("prefers company, then person, then address", () => {
    expect(whoLabel({ company: "ABC Audio", counterpartyName: "Μαρία", counterpartyAddress: "m@abc-gr.example" })).toBe("ABC Audio");
    expect(whoLabel({ company: null, counterpartyName: null, counterpartyAddress: "m@abc-gr.example" })).toBe("m@abc-gr.example");
  });
  it("hides a next step that only restates the title", () => {
    const item = { title: "ABC Audio — Αποστολή προσφοράς", company: "ABC Audio", counterpartyName: null, counterpartyAddress: null };
    expect(usefulNextAction({ ...item, nextAction: "Στείλε προσφορά σε ABC Audio" })).toBeNull();
    expect(usefulNextAction({ ...item, nextAction: "Ζήτα από την αποθήκη ημερομηνία αποστολής πριν απαντήσεις" })).not.toBeNull();
  });
  it("names the colleague who handles it", () => {
    expect(ownerText({ ownerKind: "INTERNAL", ownerLabel: "Νίκος Παππάς" })).toBe("Handled by Νίκος Παππάς");
    expect(ownerText({ ownerKind: "INTERNAL", ownerLabel: null })).toBe("Handled by a colleague");
    expect(ownerText({ ownerKind: "ME", ownerLabel: null })).toBeNull();
  });
});

describe("timePhrase", () => {
  it("one phrase with the status tone", () => {
    expect(timePhrase({ ...base, dueDate: "2026-09-22", overdue: true }, TODAY)).toMatchObject({ text: "2 days overdue", tone: "overdue" });
    expect(timePhrase({ ...base, dueDate: TODAY }, TODAY)).toMatchObject({ text: "today", tone: "today" });
    expect(timePhrase({ ...base, dueDate: "2026-09-25" }, TODAY)).toMatchObject({ text: "tomorrow" });
    expect(timePhrase({ ...base, status: "WAITING_FOR_OTHER", businessDaysWaiting: 4, expectReplyBy: "2026-09-23" }, TODAY)).toMatchObject({ text: "4 business days", tone: "overdue" });
    expect(timePhrase({ ...base, snoozeMode: "until_reply" }, TODAY)).toMatchObject({ text: "until they reply", tone: "calm" });
    expect(timePhrase({ ...base, status: "COMPLETED" }, TODAY)).toMatchObject({ text: "done" });
    expect(timePhrase({ ...base, status: "DISMISSED" }, TODAY)).toMatchObject({ text: "removed" });
    expect(timePhrase(base, TODAY)).toBeNull();
  });
  it("follows up from the expected-reply day itself, like the server", () => {
    const waiting = { ...base, status: "WAITING_FOR_OTHER" as const, businessDaysWaiting: 3, expectReplyBy: TODAY };
    expect(timePhrase(waiting, TODAY)).toMatchObject({ text: "3 business days", tone: "overdue" });
    expect(timePhrase({ ...waiting, expectReplyBy: "2026-09-25" }, TODAY)).toMatchObject({ tone: "waiting" });
    expect(timePhrase({ ...waiting, businessDaysWaiting: 0 }, TODAY)).toMatchObject({ tone: "overdue" });
  });
  it("does not say “since today” for a wait that started before the weekend", () => {
    const lastMessage = { author: me, at: "2026-09-25T10:00:00Z", subject: "Προσφορά", direction: "OUTBOUND" as const };
    const w = { ...base, status: "WAITING_FOR_OTHER" as const, businessDaysWaiting: 0, lastMessage };
    expect(timePhrase(w, "2026-09-27", ZONE)).toMatchObject({ text: "since Fri 25 Sep", tone: "waiting" });
    expect(timePhrase(w, "2026-09-25", ZONE)).toMatchObject({ text: "since today" });
  });
  it("treats a passed snooze date as not snoozed (like snoozedSql)", () => {
    expect(isSnoozed({ snoozedUntil: "2026-09-25", snoozeMode: "until_date" }, TODAY)).toBe(true);
    expect(isSnoozed({ snoozedUntil: TODAY, snoozeMode: "until_date" }, TODAY)).toBe(false);
    expect(isSnoozed({ snoozedUntil: null, snoozeMode: "until_reply" }, TODAY)).toBe(true);
    expect(isSnoozed({ snoozedUntil: "2026-09-20", snoozeMode: "until_reply" }, TODAY)).toBe(false);
    expect(timePhrase({ ...base, snoozedUntil: "2026-09-20", snoozeMode: "until_reply", dueDate: TODAY }, TODAY)).toMatchObject({ text: "today" });
    expect(timePhrase({ ...base, snoozedUntil: "2026-09-28", snoozeMode: "until_date" }, TODAY)).toMatchObject({ text: "snoozed until Mon 28 Sep" });
  });
});

describe("people", () => {
  it("says “you” for the owner", () => {
    expect(personLabel(me)).toBe("you");
    expect(attribution({ author: { name: "Άννα Ραφαηλίδου", address: "a@e.example", isOwner: false, isInternal: false }, at: "2026-09-18T13:10:00Z" }, ZONE, TODAY)).toBe("Άννα Ραφαηλίδου, Fri 18 Sep");
  });
});

describe("greeting", () => {
  it("greets by first name as written (no vocative), or without one", () => {
    expect(greetingLine("Γιώργος Παπαδόπουλος", "2026-09-24T06:00:00Z", ZONE)).toBe("Good morning, Γιώργος.");
    expect(greetingLine("Νίκος Παππάς", "2026-09-24T14:00:00Z", ZONE)).toBe("Good afternoon, Νίκος.");
    expect(greetingLine("Maria Papadaki", "2026-09-24T17:30:00Z", ZONE)).toBe("Good evening, Maria.");
    expect(greetingLine("  ", "2026-09-24T06:00:00Z", ZONE)).toBe("Good morning.");
  });
});

describe("day summary", () => {
  it("counts each section on its own, like the headings below it", () => {
    expect(daySentence({ doNow: 3, promised: 1, waiting: 2, triage: 1 })).toBe("Today you have 3 to do, 1 promise to keep, you're waiting for 2 replies and the AI has 1 question.");
    expect(daySentence({ doNow: 0, promised: 2, waiting: 0, triage: 0 })).toBe("Today you have 2 promises to keep.");
    expect(daySentence({ doNow: 0, promised: 0, waiting: 1, triage: 0 })).toBe("Today you're waiting for 1 reply.");
    expect(daySentence({ doNow: 0, promised: 0, waiting: 0, triage: 0 })).toMatch(/No tasks right now/);
    expect(longDate("2026-09-24")).toBe("Thursday 24 September");
  });
});

describe("task page helpers", () => {
  const ev = (quote: string, at: string | null = null) => ({ quote, source: "NEW", messageId: null, author: null, at });

  it("counts “Open” from the request, and “Closed” to the close", () => {
    const open = { status: "ACTION_REQUIRED" as const, createdAt: "2026-09-24T08:00:00Z", closedAt: null, closedBy: null, evidence: ev("x", "2026-09-18T09:00:00Z"), originEvidence: null };
    expect(ageFact(open, ZONE, TODAY)).toEqual({ label: "Open", value: "6 days, since Fri 18 Sep" });
    expect(ageFact({ ...open, evidence: null }, ZONE, TODAY)).toEqual({ label: "Open", value: "since today 11:00" });
    const closed = { ...open, status: "COMPLETED" as const, closedAt: "2026-09-21T10:00:00Z", closedBy: "ai" as const };
    expect(ageFact(closed, ZONE, TODAY)).toEqual({ label: "Closed", value: "Mon 21 Sep, automatically by the AI, after 3 days" });
  });

  it("keeps a summary that says more than a short quote", () => {
    expect(repeatsQuote("Maria Papadaki asks for a quote for 40 ceiling speakers by Thursday.", "Προσφορά")).toBe(false);
    expect(repeatsQuote("anything", "—")).toBe(false);
    const q = "μπορείτε να μας στείλετε αντίγραφο του τιμολογίου 2026-1187 μέχρι την Τρίτη;";
    expect(repeatsQuote(`Request: “${q}”`, q)).toBe(true);
  });

  it("highlights on the original text, even when lower-casing changes its length", () => {
    const text = "İstanbul ofisi: μπορείτε να μας\nστείλετε το τιμολόγιο";
    const [r] = highlightRanges(text, ["Μπορείτε να μας στείλετε"]);
    expect(text.slice(r![0], r![1])).toBe("μπορείτε να μας\nστείλετε");
    expect(highlightRanges("τιμές σε ευρώ", ["ΤΙΜΈΣ"])).toEqual([[0, 5]]);
    expect(highlightRanges("abc", ["zzz"])).toEqual([]);
  });

  it("prefers the full quote over its 220-character clip", () => {
    const full = `${"Θα θέλαμε προσφορά για ηχεία οροφής και ενισχυτές. ".repeat(5)}Ευχαριστούμε.`;
    const clipped = `${full.slice(0, 220)}…`;
    const task = {
      evidence: ev(clipped),
      originEvidence: null,
      events: [{ actor: "ai", evidenceQuote: full } as TaskEventView],
    };
    const quotes = collectQuotes(task);
    expect(quotes[0]).toBe(full);
    const ranges = highlightRanges(`Καλημέρα. ${full}`, quotes);
    expect(ranges).toHaveLength(1);
    expect(ranges[0]![1] - ranges[0]![0]).toBe(full.length);
  });

  it("shows the origin request only when it is another sentence", () => {
    expect(distinctOrigin({ evidence: ev("θα σας στείλω την προσφορά την Πέμπτη"), originEvidence: ev("μπορείτε να μας στείλετε προσφορά;") })?.quote).toBe("μπορείτε να μας στείλετε προσφορά;");
    expect(distinctOrigin({ evidence: ev("Στείλτε προσφορά"), originEvidence: ev("στείλτε  προσφορά") })).toBeNull();
    expect(distinctOrigin({ evidence: ev("x"), originEvidence: null })).toBeNull();
  });
});

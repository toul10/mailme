import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  activeRule,
  forwardRuleFor,
  hasRecipient,
  ignoreRuleFor,
  mentionsTopic,
  normalizeRules,
  rulesForAi,
  spamFilterOn,
  topicText,
  type MailRule,
} from "../../src/domain/rules.js";

const ordersCc: MailRule = { id: "orders-cc", kind: "ignore", enabled: true, text: "Παραγγελίες με το orders@: αγνόησε", topics: ["παραγγελ", "order"], recipients: ["orders@contoso.example"] };
const webinars: MailRule = { id: "webinars", kind: "ignore", enabled: true, text: "Webinar: ignore", topics: ["webinar", "σεμινάρι"] };
const forward: MailRule = {
  id: "orders-forward",
  kind: "forward",
  enabled: true,
  text: "Παραγγελίες χωρίς το orders@: πες μου",
  topics: ["παραγγελ", "purchase order"],
  except: ["η παραγγελία σας"],
  target: "orders@contoso.example",
};

describe("rules — reading a stored or imported list", () => {
  it("keeps usable rules, skips the rest by id, never throws", () => {
    const { rules, skipped } = normalizeRules([
      { id: "Webinars", kind: "ignore", text: "  Τα   webinar: ignore ", topics: ["webinar", "webinar", ""] },
      { id: "x", kind: "nope", text: "?" },
      { id: "no-target", kind: "forward", text: "t", topics: ["a"] },
      { id: "bad-rcpt", kind: "ignore", text: "t", recipients: ["not an address"] },
      { id: "webinars", kind: "ignore", text: "dup", topics: ["x"] },
      "junk",
    ]);
    expect(rules).toEqual([{ id: "webinars", kind: "ignore", enabled: true, text: "Τα webinar: ignore", topics: ["webinar"] }]);
    expect(skipped.map((s) => s.id)).toEqual(["x", "no-target", "bad-rcpt", "webinars", "#6"]);
    expect(normalizeRules(null)).toEqual({ rules: [], skipped: [] });
    expect(normalizeRules({}).skipped).toEqual([{ id: "*", error: "not a list" }]);
  });

  it("enabled defaults to true; false switches a rule off", () => {
    const { rules } = normalizeRules([{ id: "a", kind: "summary", text: "s" }, { id: "b", kind: "summary", text: "s", enabled: false }]);
    expect(rules.map((r) => r.enabled)).toEqual([true, false]);
    expect(activeRule(rules, "summary")?.id).toBe("a");
    expect(rulesForAi(rules)).toEqual([{ id: "a", text: "s" }]);
  });

  it("the spam filter stays on unless a spam rule is switched off", () => {
    expect(spamFilterOn([])).toBe(true);
    expect(spamFilterOn([{ id: "spam", kind: "spam", enabled: true, text: "s" }])).toBe(true);
    expect(spamFilterOn([{ id: "spam", kind: "spam", enabled: false, text: "s" }])).toBe(false);
  });

  it("The example rules file is usable as a whole", () => {
    const raw = JSON.parse(readFileSync(new URL("../../docs/rules/example.json", import.meta.url), "utf8"));
    const { rules, skipped } = normalizeRules(raw.rules);
    expect(skipped).toEqual([]);
    expect(rules.map((r) => r.kind)).toEqual(["spam", "ignore", "forward", "summary", "ignore", "ignore", "note", "answered", "updates", "ignore"]);
  });
});

describe("rules — matching", () => {
  it("topics match accent- and case-insensitively at word starts", () => {
    const t = topicText("ΠΑΡΑΓΓΕΛΙΑ ΥΠΟΚΑΤΑΣΤΗΜΑ", "Νέα παραγγελία για 40 ηχεία");
    expect(mentionsTopic(t, ["παραγγελ"])).toBe(true);
    expect(mentionsTopic(topicText("Webinar | Μισθολογική Διαφάνεια"), ["webinar"])).toBe(true);
    expect(mentionsTopic(topicText("σεμινάρια : ΜΙΣΘΟΛΟΓΙΚΗ ΔΙΑΦΑΝΕΙΑ"), ["σεμινάρι"])).toBe(true);
    // not inside another word
    expect(mentionsTopic(topicText("Recorder of the year"), ["order"])).toBe(false);
  });

  it("e-mail addresses and links never count as a topic («orders@…» in a signature)", () => {
    const t = topicText("Τιμή και διαθεσιμότητα", "Για απορίες: orders@contoso.example — https://contoso.example/orders");
    expect(mentionsTopic(t, ["order"])).toBe(false);
  });

  it("recipients: an address or a @domain (subdomains too)", () => {
    expect(hasRecipient(["Orders@Contoso.example", "x@abc-gr.example"], ["orders@contoso.example"])).toBe(true);
    expect(hasRecipient(["a@mail.abc-gr.example"], ["@abc-gr.example"])).toBe(true);
    expect(hasRecipient(["a@abc-gr.example"], ["orders@contoso.example"])).toBe(false);
  });

  it("ignore: topic AND recipient when both are set; a topic-only rule needs no recipient", () => {
    const rules = [ordersCc, webinars];
    expect(ignoreRuleFor(rules, { folded: topicText("Παραγγελία #12"), recipients: ["orders@contoso.example"] })?.id).toBe("orders-cc");
    expect(ignoreRuleFor(rules, { folded: topicText("Παραγγελία #12"), recipients: ["shop@contoso.example"] })).toBeNull();
    expect(ignoreRuleFor(rules, { folded: topicText("Τιμή"), recipients: ["orders@contoso.example"] })).toBeNull();
    expect(ignoreRuleFor(rules, { folded: topicText("FREE WEBINAR: WMS"), recipients: [] })?.id).toBe("webinars");
    expect(ignoreRuleFor([{ ...webinars, enabled: false }], { folded: topicText("webinar"), recipients: [] })).toBeNull();
  });

  it("forward: subject topic, target missing from To/Cc, not an excepted phrase", () => {
    expect(forwardRuleFor([forward], { subject: "New Northwind Purchase Order 4500000017", recipients: ["shop@contoso.example"] })?.id).toBe("orders-forward");
    expect(forwardRuleFor([forward], { subject: "Παραγγελία Από Παπαδόπουλο", recipients: ["shop@contoso.example", "orders@contoso.example"] })).toBeNull();
    expect(forwardRuleFor([forward], { subject: "TELCO-ONE - Η παραγγελία σας δρομολογήθηκε", recipients: ["shop@contoso.example"] })).toBeNull();
    expect(forwardRuleFor([forward], { subject: "Τιμή και διαθεσιμότητα", recipients: [] })).toBeNull();
  });
});

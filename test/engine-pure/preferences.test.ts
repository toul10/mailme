import { describe, expect, it } from "vitest";
import { companyKey, forbiddenMute, isImportant, normalizeEntries, normalizeProfile, parseEntry, PREFERENCE_LIMITS, senderMatches } from "../../src/domain/preferences.js";

describe("What matters to me — entries", () => {
  it.each([
    ["Maria@abc-gr.example", "important", { kind: "address", value: "maria@abc-gr.example" }],
    ["mailto:maria@abc-gr.example", "muted", { kind: "address", value: "maria@abc-gr.example" }],
    ["@delta-events-gr.example", "important", { kind: "domain", value: "@delta-events-gr.example" }],
    ["delta-events-gr.example", "muted", { kind: "domain", value: "@delta-events-gr.example" }],
    ["*.news.example.com", "muted", { kind: "domain", value: "@news.example.com" }],
    ["  ABC   Audio ", "important", { kind: "company", value: "ABC Audio" }],
    ["Δέλτα Events Α.Ε.", "important", { kind: "company", value: "Δέλτα Events Α.Ε." }],
  ] as const)("%s (%s) → %o", (raw, list, entry) => {
    expect(parseEntry(raw, list)).toEqual({ ok: true, entry });
  });

  it("refuses what cannot be matched", () => {
    expect(parseEntry("", "important").ok).toBe(false);
    expect(parseEntry("ABC Audio", "muted").ok).toBe(false); // companies are unknown before the AI
    expect(parseEntry("maria@", "important").ok).toBe(false);
    expect(parseEntry("12345", "important").ok).toBe(false);
    expect(parseEntry("x".repeat(PREFERENCE_LIMITS.entryChars + 1), "important").ok).toBe(false);
  });

  it("normalizes a list: blanks and duplicates out, first spelling kept, first error wins", () => {
    expect(normalizeEntries(["ABC Audio", " ", "abc audio", "@abc-gr.example", "abc-gr.example", "Maria@abc-gr.example"], "important")).toEqual({
      ok: true,
      values: ["ABC Audio", "@abc-gr.example", "maria@abc-gr.example"],
    });
    expect(normalizeEntries(["@abc-gr.example", "ABC Audio"], "muted")).toMatchObject({ ok: false, entry: "ABC Audio" });
    expect(normalizeEntries(Array.from({ length: PREFERENCE_LIMITS.entries + 1 }, (_, i) => `a${i}@x-gr.example`), "muted").ok).toBe(false);
  });
});

describe("What matters to me — matching", () => {
  it("matches a sender by address or domain, subdomains included, never by a look-alike", () => {
    expect(senderMatches("Maria@abc-gr.example", ["maria@abc-gr.example"])).toBe(true);
    expect(senderMatches("x@mail.abc-gr.example", ["@abc-gr.example"])).toBe(true);
    expect(senderMatches("x@notabc.example", ["@abc-gr.example"])).toBe(false);
    expect(senderMatches("x@abc-gr.example.evil.com", ["@abc-gr.example"])).toBe(false);
    expect(senderMatches(null, ["@abc-gr.example"])).toBe(false);
    expect(senderMatches("x@abc-gr.example", ["ABC Audio"])).toBe(false);
  });

  it("marks a task important by counterparty address, domain or company (accents and case ignored)", () => {
    const t = (counterpartyAddress: string | null, company: string | null) => ({ counterpartyAddress, company });
    expect(isImportant(t("g.nikolaou@delta-events-gr.example", null), ["@delta-events-gr.example"])).toBe(true);
    expect(isImportant(t(null, "Δέλτα Events"), ["δελτα events"])).toBe(true);
    expect(isImportant(t(null, "ABC Audio"), ["ABC"])).toBe(false);
    expect(isImportant(t("a@x-gr.example", "X"), [])).toBe(false);
    expect(companyKey("  Δέλτα-Events  ")).toBe("δελτα events");
  });

  it("never mutes the user's own addresses or the organization's domains", () => {
    const own = { addresses: ["ilias@contoso.example", "sales@contoso.example"], internalDomains: ["contoso.example"] };
    expect(forbiddenMute(["@contoso.example"], own)).toBe("@contoso.example");
    expect(forbiddenMute(["sales@contoso.example"], own)).toBe("sales@contoso.example");
    expect(forbiddenMute(["maria@contoso.example"], own)).toBe("maria@contoso.example"); // a colleague
    expect(forbiddenMute(["@mail.contoso.example"], own)).toBe("@mail.contoso.example");
    expect(forbiddenMute(["@supplier-gr.example", "offers@abc-gr.example"], own)).toBeNull();
  });

  it("stores the profile trimmed and capped, null when empty", () => {
    expect(normalizeProfile("  Πωλήσεις ήχου.\r\nΌχι service.  ")).toBe("Πωλήσεις ήχου.\nΌχι service.");
    expect(normalizeProfile("   ")).toBeNull();
    expect(normalizeProfile("x".repeat(700))).toHaveLength(PREFERENCE_LIMITS.profileChars);
  });
});

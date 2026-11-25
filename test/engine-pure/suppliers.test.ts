import { describe, expect, it } from "vitest";
import { normalizeRules, rulesForAi, rulesInUse, senderClash, supplierFor, supplierRules, type MailRule } from "../../src/domain/rules.js";
import { parseSupplierList, removeSupplier, supplierRuleId, upsertSuppliers } from "../../src/domain/suppliers.js";

const OWN = { addresses: ["owner@contoso.example"], internalDomains: ["contoso.example"] };
const supplier = (id: string, name: string, senders: string[], enabled = true): MailRule => ({ id, kind: "supplier", enabled, text: name, name, senders });

describe("suppliers: the supplier rule", () => {
  it("is a name and its senders; the sentence defaults to the name, senders are stored lower-cased", () => {
    const { rules, skipped } = normalizeRules([{ id: "Supplier-Northwind", kind: "supplier", name: "  NORTHWIND  Audio ", senders: ["@Northwind-ro.example", "Sales@NW-Parts.example", "@northwind-ro.example"] }]);
    expect(skipped).toEqual([]);
    expect(rules).toEqual([{ id: "supplier-northwind", kind: "supplier", enabled: true, text: "NORTHWIND Audio", name: "NORTHWIND Audio", senders: ["@northwind-ro.example", "sales@nw-parts.example"] }]);
  });

  it("keeps a sentence somebody wrote, and the on/off switch", () => {
    const { rules } = normalizeRules([{ id: "s1", kind: "supplier", enabled: false, text: "Our main one for speakers", name: "Fabrikam", senders: ["@fabrikam.example"] }]);
    expect(rules[0]).toMatchObject({ enabled: false, text: "Our main one for speakers", name: "Fabrikam" });
  });

  it("is skipped, by id and with the reason, when it has no name, no senders or a sender that is no address or domain", () => {
    const { rules, skipped } = normalizeRules([
      { id: "no-name", kind: "supplier", senders: ["@a.example"] },
      { id: "no-senders", kind: "supplier", name: "A" },
      { id: "bad-sender", kind: "supplier", name: "A", senders: ["a.example"] },
      { id: "long-name", kind: "supplier", name: "x".repeat(61), senders: ["@a.example"] },
    ]);
    expect(rules).toEqual([]);
    expect(skipped).toEqual([
      { id: "no-name", error: "text: 1–600 characters" },
      { id: "no-senders", error: "supplier needs senders" },
      { id: "bad-sender", error: "senders: e-mail addresses or @domain" },
      { id: "long-name", error: "supplier needs a name (1–60 characters)" },
    ]);
  });

  it("a sender belongs to one supplier: the later rule that claims it again is skipped", () => {
    const { rules, skipped } = normalizeRules([
      { id: "a", kind: "supplier", name: "Northwind", senders: ["@northwind.example"] },
      { id: "same", kind: "supplier", name: "Northwind 2", senders: ["@northwind.example"] },
      { id: "inside", kind: "supplier", name: "Northwind parts", senders: ["parts@eu.northwind.example"] },
      { id: "around", kind: "supplier", name: "Example", senders: ["@eu.northwind.example"] },
      { id: "b", kind: "supplier", name: "Fabrikam", senders: ["@fabrikam.example", "@notnorthwind.example"] },
    ]);
    expect(rules.map((r) => r.id)).toEqual(["a", "b"]);
    expect(skipped).toEqual([
      { id: "same", error: "senders: @northwind.example is already Northwind's" },
      { id: "inside", error: "senders: parts@eu.northwind.example is already Northwind's" },
      { id: "around", error: "senders: @eu.northwind.example is already Northwind's" },
    ]);
  });

  it("an address claimed first keeps its supplier when a later rule asks for the whole domain", () => {
    const one = supplier("one", "Parts", ["parts@northwind.example"]);
    expect(senderClash(supplier("two", "Northwind", ["@northwind.example"]), [one])).toEqual({ entry: "@northwind.example", rule: one });
    expect(senderClash(supplier("two", "Other", ["sales@other.example"]), [one])).toBeNull();
    // A supplier never clashes with itself (it is in the list while it is being rewritten).
    expect(senderClash(one, [one])).toBeNull();
  });

  const rules = [supplier("s-nw", "Northwind", ["@northwind-ro.example"]), supplier("s-fab", "Fabrikam", ["orders@fabrikam.example"]), supplier("s-off", "Tailspin", ["@tailspin.example"], false)];

  it("names the supplier of an address: the address itself, or its domain with every subdomain", () => {
    expect(supplierFor(rules, "ion@northwind-ro.example")?.id).toBe("s-nw");
    expect(supplierFor(rules, "  Ion@EU.Northwind-ro.example ")?.id).toBe("s-nw");
    expect(supplierFor(rules, "orders@fabrikam.example")?.id).toBe("s-fab");
  });

  it("does not take a look-alike domain, another address of an address-only supplier, a switched-off supplier or no address", () => {
    expect(supplierFor(rules, "ion@notnorthwind-ro.example")).toBeNull();
    expect(supplierFor(rules, "ion@northwind-ro.example.evil.example")).toBeNull();
    expect(supplierFor(rules, "ion@northwind.example")).toBeNull();
    expect(supplierFor(rules, "sales@fabrikam.example")).toBeNull();
    expect(supplierFor(rules, "x@tailspin.example")).toBeNull();
    expect(supplierFor(rules, null)).toBeNull();
    expect(supplierFor(rules, "not an address")).toBeNull();
    expect(supplierRules(rules).map((r) => r.id)).toEqual(["s-nw", "s-fab"]);
  });

  it("is never among the rules the engine works with or the AI is told about", () => {
    const webinars: MailRule = { id: "webinars", kind: "ignore", enabled: true, text: "Webinar: ignore", topics: ["webinar"] };
    expect(rulesInUse([...rules, webinars])).toEqual([webinars]);
    expect(rulesForAi([...rules, webinars])).toEqual([{ id: "webinars", text: "Webinar: ignore" }]);
    expect(rulesInUse(rules)).toEqual([]);
  });
});

describe("suppliers: a typed or pasted list", () => {
  it("reads a table copied from a sheet: the header row makes nothing, each name takes the senders of its line", () => {
    const text = ["SUPPLIER\temail", "NORTHWIND\t@Northwind-ro.example", "FABRIKAM\t@fabrikam.example", "TAILSPIN TOYS\t@tailspin-cn.example", ""].join("\r\n");
    expect(parseSupplierList(text)).toEqual({
      entries: [
        { name: "NORTHWIND", senders: ["@northwind-ro.example"] },
        { name: "FABRIKAM", senders: ["@fabrikam.example"] },
        { name: "TAILSPIN TOYS", senders: ["@tailspin-cn.example"] },
      ],
      ignored: ["SUPPLIER email"],
      errors: [],
    });
  });

  it("reads a table copied cell by cell: a line of senders belongs to the name above it", () => {
    const text = "SUPPLIER\nemail\nNorthwind\n@northwind.example\nsales@nw-parts.example\n\nFabrikam\n@fabrikam.example";
    expect(parseSupplierList(text)).toEqual({
      entries: [
        { name: "Northwind", senders: ["@northwind.example", "sales@nw-parts.example"] },
        { name: "Fabrikam", senders: ["@fabrikam.example"] },
      ],
      ignored: ["SUPPLIER", "email"],
      errors: [],
    });
  });

  it("takes commas, semicolons and bars as separators, an address in brackets, and a name written twice as one supplier", () => {
    const text = "Northwind, @northwind.example; <Sales@NW-Parts.example>\nFabrikam | @fabrikam.example\nnorthwind @northwind.example @nw2.example";
    expect(parseSupplierList(text).entries).toEqual([
      { name: "Northwind", senders: ["@northwind.example", "sales@nw-parts.example", "@nw2.example"] },
      { name: "Fabrikam", senders: ["@fabrikam.example"] },
    ]);
  });

  it("says what it could not use: a sender before any name, something that is no address or domain", () => {
    const res = parseSupplierList("@orphan.example\nNorthwind @northwind.example bad@\nFabrikam x@y");
    expect(res.entries).toEqual([{ name: "Northwind", senders: ["@northwind.example"] }]);
    expect(res.ignored).toEqual(["Fabrikam"]);
    expect(res.errors).toEqual([
      "“@orphan.example”: write the supplier's name first.",
      "Northwind: “bad@”: This list takes an email address (e.g. info@example.com) or a domain (e.g. @example.com).",
      "Fabrikam: “x@y”: This list takes an email address (e.g. info@example.com) or a domain (e.g. @example.com).",
    ]);
    expect(parseSupplierList("")).toEqual({ entries: [], ignored: [], errors: [] });
  });
});

describe("suppliers: writing them into the stored list", () => {
  const imported = [
    { id: "webinars", kind: "ignore", enabled: true, text: "Webinar: ignore", topics: ["webinar"] },
    { id: "broken", kind: "forward", text: "no target", topics: ["x"] },
  ];
  const write = (stored: unknown[], entries: Array<{ name: string; senders: string[] }>, mode: "add" | "replace" = "add") => upsertSuppliers(stored, entries, { mode, own: OWN });
  const ok = (res: ReturnType<typeof upsertSuppliers>) => {
    if (!res.ok) throw new Error(res.error);
    return res;
  };

  it("adds suppliers after the rules that are there, which stay exactly as stored (the unusable one too)", () => {
    const res = ok(write(imported, [{ name: "NORTHWIND", senders: ["@Northwind-ro.example"] }, { name: "Fabrikam Audio", senders: ["fabrikam.example", "orders@fab-parts.example"] }]));
    expect(res.ids).toEqual(["supplier-northwind", "supplier-fabrikam-audio"]);
    expect(res.next).toEqual([
      imported[0],
      imported[1],
      { id: "supplier-northwind", kind: "supplier", enabled: true, text: "NORTHWIND", name: "NORTHWIND", senders: ["@northwind-ro.example"] },
      { id: "supplier-fabrikam-audio", kind: "supplier", enabled: true, text: "Fabrikam Audio", name: "Fabrikam Audio", senders: ["@fabrikam.example", "orders@fab-parts.example"] },
    ]);
    expect(normalizeRules(res.next).skipped).toEqual([{ id: "broken", error: "forward needs a target address" }]);
  });

  it("a supplier that exists (same name, whatever its case and accents) keeps its id, place and switch: “add” joins senders, “replace” sets them", () => {
    const stored = [supplier("supplier-northwind", "Northwind", ["@northwind.example"], false), imported[0]!];
    // One more sender, typed with the name in capitals: the supplier keeps the name it has.
    const added = ok(write(stored, [{ name: "NORTHWIND", senders: ["@nw2.example", "@northwind.example"] }]));
    expect(added.next).toEqual([{ id: "supplier-northwind", kind: "supplier", enabled: false, text: "Northwind", name: "Northwind", senders: ["@northwind.example", "@nw2.example"] }, imported[0]]);
    // “replace” is the supplier as given: these senders, this spelling.
    const replaced = ok(write(added.next, [{ name: "NORTHWIND", senders: ["@nw2.example"] }], "replace"));
    expect(replaced.next[0]).toEqual({ id: "supplier-northwind", kind: "supplier", enabled: false, text: "NORTHWIND", name: "NORTHWIND", senders: ["@nw2.example"] });
    expect(replaced.ids).toEqual(["supplier-northwind"]);
  });

  it("the same name twice in one list is one supplier with the senders of both lines", () => {
    const res = ok(write([], [{ name: "Northwind", senders: ["@northwind.example"] }, { name: "NORTHWIND", senders: ["@nw2.example"] }], "replace"));
    expect(res.next).toEqual([{ id: "supplier-northwind", kind: "supplier", enabled: true, text: "NORTHWIND", name: "NORTHWIND", senders: ["@northwind.example", "@nw2.example"] }]);
    const added = ok(write([], [{ name: "Northwind", senders: ["@northwind.example"] }, { name: "NORTHWIND", senders: ["@nw2.example"] }]));
    expect(added.next).toMatchObject([{ id: "supplier-northwind", name: "Northwind", senders: ["@northwind.example", "@nw2.example"] }]);
  });

  it("keeps a sentence of its own that an imported supplier has", () => {
    const stored = [{ id: "nw", kind: "supplier", text: "Our main one", name: "Northwind", senders: ["@northwind.example"] }];
    expect(ok(write(stored, [{ name: "Northwind", senders: ["@nw2.example"] }])).next[0]).toMatchObject({ id: "nw", text: "Our main one", senders: ["@northwind.example", "@nw2.example"] });
  });

  it("gives every new supplier its own id, also when the name has no Latin letter", () => {
    expect(supplierRuleId("Δέλτα Ήχος", new Set())).toBe("supplier-x");
    expect(supplierRuleId("Δέλτα Ήχος", new Set(["supplier-x", "supplier-x-2"]))).toBe("supplier-x-3");
    expect(supplierRuleId("  Blue-Yonder GmbH & Co. ", new Set())).toBe("supplier-blue-yonder-gmbh-co");
    expect(supplierRuleId("x".repeat(80), new Set()).length).toBeLessThanOrEqual(60);
    const res = ok(write([{ id: "supplier-x", kind: "note", text: "taken by another rule" }], [{ name: "Δέλτα", senders: ["@delta.example"] }, { name: "Ωμέγα", senders: ["@omega.example"] }]));
    expect(res.ids).toEqual(["supplier-x-2", "supplier-x-3"]);
  });

  it("refuses, with the reason and without writing anything, what cannot be a supplier's sender", () => {
    const stored = [supplier("supplier-northwind", "Northwind", ["@northwind.example"])];
    const refused = (entries: Array<{ name: string; senders: string[] }>, mode: "add" | "replace" = "add") => {
      const res = write(stored, entries, mode);
      return res.ok ? "written" : res.error;
    };
    expect(refused([{ name: "Fabrikam", senders: ["@northwind.example"] }])).toBe("“@northwind.example” already belongs to the supplier Northwind.");
    expect(refused([{ name: "Fabrikam", senders: ["ion@eu.northwind.example"] }])).toBe("“ion@eu.northwind.example” already belongs to the supplier Northwind.");
    expect(refused([{ name: "A", senders: ["@a.example"] }, { name: "B", senders: ["x@a.example"] }])).toBe("“@a.example” already belongs to the supplier B.");
    expect(refused([{ name: "Us", senders: ["@contoso.example"] }])).toBe("“@contoso.example” is your own address or your organization's: it is not a supplier.");
    expect(refused([{ name: "Me", senders: ["owner@contoso.example"] }])).toBe("“owner@contoso.example” is your own address or your organization's: it is not a supplier.");
    expect(refused([{ name: "Everyone", senders: ["@gmail.com"] }])).toBe("“@gmail.com” is a public mail service: write the supplier's full address.");
    expect(refused([{ name: "Fabrikam", senders: ["not a domain"] }])).toBe("Fabrikam: “not a domain”: This list takes an email address (e.g. info@example.com) or a domain (e.g. @example.com).");
    expect(refused([{ name: "Fabrikam", senders: [] }])).toBe("Fabrikam: write an email address (e.g. info@example.com) or a domain (e.g. @example.com).");
    expect(refused([{ name: "Northwind", senders: [] }], "replace")).toBe("Northwind: write an email address (e.g. info@example.com) or a domain (e.g. @example.com).");
    expect(refused([{ name: "  ", senders: ["@b.example"] }])).toBe("Write the supplier's name.");
    expect(refused([])).toBe("Write a supplier and their email address or @domain.");
    // A whole address at a public mail service is a supplier's sender like any other.
    expect(refused([{ name: "A sole trader", senders: ["someone@gmail.com"] }])).toBe("written");
  });

  it("removes a supplier and nothing else; an id that is no supplier removes nothing", () => {
    const stored = [imported[0]!, supplier("supplier-northwind", "Northwind", ["@northwind.example"]), imported[1]!];
    expect(removeSupplier(stored, "Supplier-Northwind")).toEqual([imported[0], imported[1]]);
    expect(removeSupplier(stored, "webinars")).toBeNull();
    expect(removeSupplier(stored, "nope")).toBeNull();
    expect(removeSupplier(stored, "")).toBeNull();
  });
});

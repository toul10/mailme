import { describe, expect, it } from "vitest";
import { UsageError } from "../../src/cli/args.js";
import { importedRules } from "../../src/cli/commands/rules.js";
import type { MailRule } from "../../src/domain/rules.js";

/**
 * `rules:import` replaces a user's rules with a file. Suppliers are written in the app, so a file that names no
 * supplier must not wipe them.
 */
describe("rules:import and the suppliers written in the app", () => {
  const webinars: MailRule = { id: "webinars", kind: "ignore", enabled: true, text: "Webinar: ignore", topics: ["webinar"] };
  const summary: MailRule = { id: "report-summary", kind: "summary", enabled: true, text: "Summary" };
  const northwind: MailRule = { id: "supplier-northwind", kind: "supplier", enabled: true, text: "Northwind", name: "Northwind", senders: ["@northwind.example"] };
  const fabrikam: MailRule = { id: "supplier-fabrikam", kind: "supplier", enabled: false, text: "Fabrikam", name: "Fabrikam", senders: ["orders@fabrikam.example"] };

  it("a file without suppliers replaces the other rules and leaves the stored suppliers as they are, after its own", () => {
    const res = importedRules([summary], [webinars, northwind, { id: "broken", kind: "forward", text: "no target", topics: ["x"] }, fabrikam]);
    expect(res.rules).toEqual([summary, northwind, fabrikam]);
    expect(res.kept).toEqual([northwind, fabrikam]);
  });

  it("a file that names suppliers is the whole list", () => {
    const other: MailRule = { id: "supplier-tailspin", kind: "supplier", enabled: true, text: "Tailspin", name: "Tailspin", senders: ["@tailspin.example"] };
    expect(importedRules([summary, other], [webinars, northwind])).toEqual({ rules: [summary, other], kept: [] });
  });

  it("nothing stored, or nothing usable stored: the file's rules", () => {
    expect(importedRules([summary], [])).toEqual({ rules: [summary], kept: [] });
    expect(importedRules([summary], null)).toEqual({ rules: [summary], kept: [] });
    expect(importedRules([summary], "junk")).toEqual({ rules: [summary], kept: [] });
  });

  it("refuses a file whose rule takes the id of a stored supplier, instead of dropping one of the two", () => {
    const clash: MailRule = { id: "supplier-northwind", kind: "note", enabled: true, text: "Not a supplier" };
    expect(() => importedRules([clash], [northwind])).toThrow(UsageError);
  });
});

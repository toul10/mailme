import { describe, expect, it } from "vitest";
import type { SupplierGroup } from "../../src/server/api-types.js";
import { selectedGroup, supplierChoices } from "../../web/src/supplier-filter.js";

/** A supplier group as GET /api/suppliers sends it: suppliers with open tasks first, in the user's list order. */
const group = (id: string, name: string, open: number): SupplierGroup => ({ id, name, senders: [`@${id}.example`], open, items: [] });

const northwind = group("supplier-northwind", "Northwind", 8);
const fabrikam = group("supplier-fabrikam", "Fabrikam", 3);
const tailspin = group("supplier-tailspin", "Tailspin", 0);

describe("Suppliers quick filter", () => {
  it("offers the suppliers with open tasks, in the server's order, with their counts", () => {
    expect(supplierChoices([northwind, fabrikam, tailspin], null)).toEqual([
      { id: "supplier-northwind", name: "Northwind", open: 8 },
      { id: "supplier-fabrikam", name: "Fabrikam", open: 3 },
    ]);
  });

  it("offers nothing when there is nothing to choose between", () => {
    expect(supplierChoices([], null)).toEqual([]);
    expect(supplierChoices([northwind, tailspin], null)).toEqual([]);
    expect(supplierChoices([tailspin], null)).toEqual([]);
  });

  it("keeps the chosen supplier in sight, even with no open tasks or as the only one", () => {
    expect(supplierChoices([northwind, fabrikam, tailspin], "supplier-tailspin").map((c) => c.id)).toEqual(["supplier-northwind", "supplier-fabrikam", "supplier-tailspin"]);
    expect(supplierChoices([northwind, tailspin], "supplier-northwind").map((c) => c.id)).toEqual(["supplier-northwind"]);
    expect(supplierChoices([northwind, tailspin], "supplier-tailspin").map((c) => c.id)).toEqual(["supplier-northwind", "supplier-tailspin"]);
  });

  it("ignores a chosen id that is not a supplier in use", () => {
    expect(supplierChoices([northwind, tailspin], "supplier-gone")).toEqual([]);
    expect(supplierChoices([northwind, fabrikam], "supplier-gone").map((c) => c.id)).toEqual(["supplier-northwind", "supplier-fabrikam"]);
    expect(selectedGroup([northwind, fabrikam], "supplier-gone")).toBeNull();
  });

  it("finds the chosen supplier's group", () => {
    expect(selectedGroup([northwind, fabrikam, tailspin], "supplier-fabrikam")).toBe(fabrikam);
    expect(selectedGroup([northwind, fabrikam, tailspin], "supplier-tailspin")).toBe(tailspin);
    expect(selectedGroup([northwind], null)).toBeNull();
    expect(selectedGroup([], "supplier-northwind")).toBeNull();
  });
});

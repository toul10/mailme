/**
 * The quick filter of “Suppliers” (screens/Suppliers.tsx), pure: which suppliers its keys offer and which one is shown.
 * Runs under vitest.
 */
import type { SupplierGroup } from "../../src/server/api-types.js";

/** One key of the filter besides “All”: a supplier and its open tasks (within the mailbox view). */
export interface SupplierChoice {
  id: string;
  name: string;
  open: number;
}

/**
 * The keys besides “All”: the suppliers with open tasks, in the server's order (the order of the user's list), and
 * the selected one even with none, so the choice stays in sight and can be left. None when there is nothing to choose
 * between: fewer than two suppliers with open tasks and none of the groups selected.
 */
export function supplierChoices(groups: readonly SupplierGroup[], selected: string | null): SupplierChoice[] {
  const keys = groups.filter((g) => g.open > 0 || g.id === selected).map((g) => ({ id: g.id, name: g.name, open: g.open }));
  const busy = keys.filter((k) => k.open > 0).length;
  return busy >= 2 || keys.some((k) => k.id === selected) ? keys : [];
}

/** The group of the selected supplier; null when none is selected or the id is not a supplier in use (any more). */
export function selectedGroup(groups: readonly SupplierGroup[], selected: string | null): SupplierGroup | null {
  return selected ? (groups.find((g) => g.id === selected) ?? null) : null;
}

import { eq, sql } from "drizzle-orm";
import type { DbOrTx } from "../db/client.js";
import { tasks } from "../db/schema.js";
import { domainOf, foldForSearch } from "../lib/text.js";
import { isUniqueViolation } from "./db-util.js";

export type TaskRow = typeof tasks.$inferSelect;
export type NewTaskRow = typeof tasks.$inferInsert;

/** Next per-user task reference number (#184). Call inside the creating transaction. */
export async function nextTaskRef(db: DbOrTx, userId: string): Promise<number> {
  const [row] = await db
    .select({ max: sql<number>`coalesce(max(${tasks.ref}), 0)::int` })
    .from(tasks)
    .where(eq(tasks.userId, userId));
  return Number(row?.max ?? 0) + 1;
}

/** Recompute tasks.search_text from title, company, counterparty, items, next action. */
export function buildSearchText(t: { title: string; company?: string | null; counterpartyAddress?: string | null; counterpartyName?: string | null; items?: string[]; nextAction?: string | null; summary?: string | null }): string {
  const parts = [t.title, t.company, t.counterpartyName, t.counterpartyAddress, domainOf(t.counterpartyAddress), ...(t.items ?? []), t.nextAction, t.summary];
  return foldForSearch(parts.filter((p): p is string => typeof p === "string" && p.trim() !== "").join(" "))
    .split(" ")
    .filter((tok) => /[\p{L}\p{N}]/u.test(tok))
    .join(" ");
}

/**
 * Insert a task with the next free `ref`. max+1 is computed inside the caller's transaction and the
 * unique index (user_id, ref) arbitrates races: on a conflict the insert (in a savepoint) is retried once.
 */
export async function insertTaskWithRef(db: DbOrTx, values: Omit<NewTaskRow, "ref">, refFn: typeof nextTaskRef = nextTaskRef): Promise<TaskRow> {
  for (let attempt = 0; ; attempt++) {
    const ref = await refFn(db, values.userId);
    try {
      return await db.transaction(async (sp) => {
        const [row] = await sp
          .insert(tasks)
          .values({ ...values, ref })
          .returning();
        return row!;
      });
    } catch (err) {
      if (attempt === 0 && isUniqueViolation(err, "tasks_user_ref_uq")) continue;
      throw err;
    }
  }
}

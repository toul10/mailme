import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../src/db/schema.js";
import { buildSearchText, insertTaskWithRef, nextTaskRef } from "../../src/engine/tasks.js";
import { addBusinessDays, companyDomainOf, lookupCompany, mergeItems } from "../../src/engine/db-util.js";
import { insertTask, seedOrgUserMailbox, type TestDb } from "../helpers/db.js";
import { sharedTestDb } from "./fixtures.js";

const shared = sharedTestDb();
let t: TestDb;
let seed: Awaited<ReturnType<typeof seedOrgUserMailbox>>;

beforeEach(async () => {
  t = shared();
  seed = await seedOrgUserMailbox(t.db);
});

const values = (title: string) => ({ orgId: seed.org.id, userId: seed.user.id, mailboxId: seed.mailbox.id, title, status: "ACTION_REQUIRED" as const, origin: "manual" as const });

describe("task refs", () => {
  it("nextTaskRef is max+1 per user", async () => {
    expect(await nextTaskRef(t.db, seed.user.id)).toBe(1);
    await insertTask(t.db, { orgId: seed.org.id, userId: seed.user.id, mailboxId: seed.mailbox.id });
    await insertTask(t.db, { orgId: seed.org.id, userId: seed.user.id, mailboxId: seed.mailbox.id, title: "Β" });
    expect(await nextTaskRef(t.db, seed.user.id)).toBe(3);
    const [other] = await t.db.insert(s.users).values({ orgId: seed.org.id, name: "Άλλος", email: "x@contoso.example" }).returning();
    expect(await nextTaskRef(t.db, other!.id)).toBe(1);
  });

  it("insertTaskWithRef retries once on a ref conflict inside the caller's transaction", async () => {
    await insertTask(t.db, { orgId: seed.org.id, userId: seed.user.id, mailboxId: seed.mailbox.id }); // ref 1
    let calls = 0;
    const staleRef: typeof nextTaskRef = async (db, userId) => (++calls === 1 ? 1 : nextTaskRef(db, userId));
    const row = await t.db.transaction(async (tx) => {
      const created = await insertTaskWithRef(tx, values("Νέα"), staleRef);
      // The transaction is still usable after the failed (savepoint) insert.
      const again = await insertTaskWithRef(tx, values("Άλλη"));
      return [created, again] as const;
    });
    expect(calls).toBe(2);
    expect(row.map((r) => r.ref)).toEqual([2, 3]);
  });

  it("a second conflict is not retried", async () => {
    await insertTask(t.db, { orgId: seed.org.id, userId: seed.user.id, mailboxId: seed.mailbox.id });
    await expect(insertTaskWithRef(t.db, values("Νέα"), async () => 1)).rejects.toThrow();
  });
});

describe("search text & helpers", () => {
  it("buildSearchText folds title, company, counterparty (+ domain), items, next action, summary", () => {
    const text = buildSearchText({
      title: "ABC — Αποστολή Προσφοράς",
      company: "ABC Α.Ε.",
      counterpartyAddress: "Client@abc-gr.example",
      counterpartyName: "Γιάννης Παπαδόπουλος",
      items: ["Ηχεία JBL"],
      nextAction: "Τηλεφώνησε",
      summary: null,
    });
    expect(text).toBe("abc αποστολη προσφορασ abc α.ε. γιαννησ παπαδοπουλοσ client@abc-gr.example abc-gr.example ηχεια jbl τηλεφωνησε");
    expect(buildSearchText({ title: "Μόνο τίτλος" })).toBe("μονο τιτλοσ");
  });

  it("business days skip weekends and Greek holidays", () => {
    expect(addBusinessDays("2026-09-10", 3)).toBe("2026-09-15"); // Thu → Tue
    expect(addBusinessDays("2026-10-27", 1)).toBe("2026-10-29"); // 28/10 holiday
    expect(addBusinessDays("2026-06-01", 0)).toBe("2026-06-01");
    // Holy Spirit Monday 2026 = Mon 1 June (Orthodox Easter 12 April).
    expect(addBusinessDays("2026-05-29", 1)).toBe("2026-06-01");
    expect(addBusinessDays("2026-05-29", 1, true)).toBe("2026-06-02");
  });

  it("company domain excludes public and internal domains; company lookup walks up subdomains", () => {
    expect(companyDomainOf("a@abc-gr.example", ["contoso.example"])).toBe("abc-gr.example");
    expect(companyDomainOf("a@gmail.com", ["contoso.example"])).toBeNull();
    expect(companyDomainOf("a@eu.contoso.example", ["contoso.example"])).toBeNull();
    const map = new Map([["abc-gr.example", "ABC"]]);
    expect(lookupCompany(map, "mail.abc-gr.example")).toBe("ABC");
    expect(lookupCompany(map, "gr")).toBeNull();
    expect(lookupCompany(map, "xyz.example")).toBeNull();
  });

  it("mergeItems dedupes accent/case-insensitively and caps at 10", () => {
    expect(mergeItems(["Τιμές"], ["τιμες", "Δείγματα", " "])).toEqual(["Τιμές", "Δείγματα"]);
    expect(mergeItems([], Array.from({ length: 15 }, (_, i) => `x${i}`))).toHaveLength(10);
  });
});

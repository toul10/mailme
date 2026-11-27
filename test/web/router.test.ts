import { describe, expect, it } from "vitest";
import { DEFAULT_LIST, legacyLocationToHash, parseHash, routeHref, type Route } from "../../web/src/router.js";

describe("hash router", () => {
  it("parses the list route with filters", () => {
    expect(parseHash("")).toEqual({ name: "today" });
    expect(parseHash("#/")).toEqual({ name: "today" });
    expect(parseHash("#/all")).toEqual(DEFAULT_LIST);
    // Report links use #/?tab=… — they still open the list.
    expect(parseHash("#/?tab=waiting&q=%CF%80%CF%81%CE%BF%CF%83%CF%86%CE%BF%CF%81%CE%AC&company=ABC&review=1")).toEqual({
      name: "list",
      tab: "waiting",
      q: "προσφορά",
      company: "ABC",
      review: true,
    });
    expect(parseHash("#/?tab=bogus")).toMatchObject({ name: "list", tab: "all" });
    // The web-only “Snoozed” view (Today's “N snoozed” link).
    expect(parseHash("#/all?tab=snoozed")).toMatchObject({ name: "list", tab: "snoozed" });
  });

  it("suppliers: the screen, and the list narrowed to one supplier", () => {
    expect(parseHash("#/suppliers")).toEqual({ name: "suppliers" });
    expect(parseHash("#/suppliers/x")).toEqual({ name: "notFound", path: "/suppliers/x" });
    expect(parseHash("#/all?supplier=supplier-northwind")).toEqual({ ...DEFAULT_LIST, supplier: "supplier-northwind" });
    expect(parseHash("#/all?tab=waiting&supplier=Supplier-Northwind")).toEqual({ name: "list", tab: "waiting", q: "", company: null, review: false, supplier: "supplier-northwind" });
    // Alone it still opens the list, like the other list parameters.
    expect(parseHash("#/?supplier=s1")).toEqual({ ...DEFAULT_LIST, supplier: "s1" });
    // Not an id: the list as it is without one (a plain list route, equal to any other).
    for (const bad of ["", "-x", "a b", "a'or'1", "x".repeat(61)]) expect(parseHash(`#/all?supplier=${encodeURIComponent(bad)}`)).toEqual(DEFAULT_LIST);
    expect(routeHref({ ...DEFAULT_LIST, supplier: "supplier-northwind" })).toBe("#/all?supplier=supplier-northwind");
    expect(routeHref({ name: "list", tab: "closed", q: "τιμή", company: null, review: false, supplier: "s1" })).toBe("#/all?tab=closed&q=%CF%84%CE%B9%CE%BC%CE%AE&supplier=s1");
    expect(routeHref({ name: "suppliers" })).toBe("#/suppliers");
  });

  it("parses task, new, settings and mailbox routes", () => {
    expect(parseHash("#/tasks/0b9f-11")).toEqual({ name: "task", id: "0b9f-11" });
    expect(parseHash("#/tasks/0b9f-11?edit=1")).toEqual({ name: "task", id: "0b9f-11", edit: true });
    expect(parseHash("#/new?from=m1")).toEqual({ name: "new", fromMessageId: "m1" });
    expect(parseHash("#/new")).toEqual({ name: "new", fromMessageId: null });
    expect(parseHash("#/settings")).toEqual({ name: "settings" });
    expect(parseHash("#/costs")).toEqual({ name: "costs" });
    expect(parseHash("#/settings/mailboxes/mb1")).toEqual({ name: "mailbox", id: "mb1" });
    expect(parseHash("#/chat")).toEqual({ name: "chat" });
    expect(parseHash("#/chat/")).toEqual({ name: "chat" });
    expect(parseHash("#/chat/123")).toEqual({ name: "notFound", path: "/chat/123" });
    expect(parseHash("#/tasks/%E0%A4%A")).toMatchObject({ name: "notFound" });
    expect(parseHash("#/nope/here")).toEqual({ name: "notFound", path: "/nope/here" });
  });

  it("round-trips every route through its href", () => {
    const routes: Route[] = [
      { name: "today" },
      DEFAULT_LIST,
      { name: "list", tab: "others", q: "Παπαδόπουλος & Σια", company: "Α.Β.Γ.", review: false },
      { name: "task", id: "a/b c" },
      { name: "task", id: "t1", edit: true },
      { name: "list", tab: "snoozed", q: "", company: null, review: false },
      { name: "new", fromMessageId: "msg-9" },
      { name: "settings" },
      { name: "costs" },
      { name: "mailbox", id: "mb-2" },
      { name: "chat" },
      { name: "suppliers" },
      { name: "list", tab: "waiting", q: "τιμοκατάλογος", company: "ABC", review: true, supplier: "supplier-northwind" },
    ];
    for (const r of routes) expect(parseHash(routeHref(r))).toEqual(r);
    expect(routeHref(DEFAULT_LIST)).toBe("#/all");
    expect(routeHref({ name: "today" })).toBe("#/");
  });

  it("rewrites path-style deep links into hash routes", () => {
    expect(legacyLocationToHash("/tasks/abc", "", "")).toBe("#/tasks/abc");
    expect(legacyLocationToHash("/", "?tab=waiting", "")).toBe("#/?tab=waiting");
    expect(legacyLocationToHash("/settings/mailboxes/m1/", "", "")).toBe("#/settings/mailboxes/m1");
    expect(legacyLocationToHash("/", "", "")).toBeNull();
    expect(legacyLocationToHash("/tasks/abc", "", "#/settings")).toBeNull();
    expect(legacyLocationToHash("/assets/x.js", "", "")).toBeNull();
  });
});

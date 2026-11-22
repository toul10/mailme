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

  it("parses task, new, settings and mailbox routes", () => {
    expect(parseHash("#/tasks/0b9f-11")).toEqual({ name: "task", id: "0b9f-11" });
    expect(parseHash("#/tasks/0b9f-11?edit=1")).toEqual({ name: "task", id: "0b9f-11", edit: true });
    expect(parseHash("#/new?from=m1")).toEqual({ name: "new", fromMessageId: "m1" });
    expect(parseHash("#/new")).toEqual({ name: "new", fromMessageId: null });
    expect(parseHash("#/settings")).toEqual({ name: "settings" });
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
      { name: "mailbox", id: "mb-2" },
      { name: "chat" },
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

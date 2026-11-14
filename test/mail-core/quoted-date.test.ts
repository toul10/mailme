import { describe, expect, it } from "vitest";
import { parseQuotedDate } from "../../src/mail/quoted-date.js";

describe("parseQuotedDate", () => {
  it.each([
    // Outlook EN (Athens is UTC+3 in September)
    ["Wednesday, September 9, 2026 10:02 AM", "2026-09-09T07:02:00Z"],
    ["Wednesday, 9 September 2026 22:15", "2026-09-09T19:15:00Z"],
    ["Tuesday, September 08, 2026 12:10 PM", "2026-09-08T09:10:00Z"],
    ["Thursday, September 10, 2026 12:30 AM", "2026-09-09T21:30:00Z"],
    // Outlook EL
    ["Τετάρτη, 9 Σεπτεμβρίου 2026 10:02 π.μ.", "2026-09-09T07:02:00Z"],
    ["Τρίτη, 8 Σεπτεμβρίου 2026 3:45 μ.μ.", "2026-09-08T12:45:00Z"],
    ["Πέμπτη, 12 Μαΐου 2026 9:00 πμ", "2026-05-12T06:00:00Z"],
    ["Δευτέρα, 5 Ιανουαρίου 2026 18:00", "2026-01-05T16:00:00Z"],
    // Gmail EN / EL
    ["Wed, Sep 9, 2026 at 2:15 PM", "2026-09-09T11:15:00Z"],
    ["Τετ 9 Σεπ 2026 στις 10:02 π.μ.", "2026-09-09T07:02:00Z"],
    ["Τετ, 9 Σεπ 2026, 22:10", "2026-09-09T19:10:00Z"],
    // Numeric
    ["9/10/2026 10:02 πμ", "2026-10-09T07:02:00Z"],
    ["13/9/2026 08:00", "2026-09-13T05:00:00Z"],
    ["9/13/2026 8:00 AM", "2026-09-13T05:00:00Z"],
    ["10/9/26 14:05", "2026-09-10T11:05:00Z"],
    ["2026-09-09 10:02", "2026-09-09T07:02:00Z"],
    // Explicit offsets / RFC 5322
    ["Wed, 9 Sep 2026 10:02:00 +0300", "2026-09-09T07:02:00Z"],
    ["Wed, 09 Sep 2026 07:02:00 GMT", "2026-09-09T07:02:00Z"],
    ["Wednesday, September 9, 2026 10:02 AM GMT+2", "2026-09-09T08:02:00Z"],
    // Winter time in Athens is UTC+2
    ["Monday, December 7, 2026 10:00 AM", "2026-12-07T08:00:00Z"],
  ])("%s", (input, iso) => {
    expect(parseQuotedDate(input)).toBe(iso);
  });

  it("uses the given zone for floating times", () => {
    expect(parseQuotedDate("Wednesday, September 9, 2026 10:02 AM", "Europe/London")).toBe("2026-09-09T09:02:00Z");
  });

  it("returns null for unparseable or implausible input", () => {
    expect(parseQuotedDate(null)).toBeNull();
    expect(parseQuotedDate("")).toBeNull();
    expect(parseQuotedDate("yesterday")).toBeNull();
    expect(parseQuotedDate("Friday 10:00")).toBeNull();
    expect(parseQuotedDate("31/02/2026 10:00")).toBeNull();
    expect(parseQuotedDate("1/1/1850 10:00")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { parseICalendar, parseIcalLines, resolveTzid } from "../../src/mail/ical.js";

describe("parseIcalLines", () => {
  it("unfolds continuation lines and keeps quoted parameters intact", () => {
    const lines = parseIcalLines('SUMMARY:Συνάντηση για\r\n  την προσφορά\r\nORGANIZER;CN="Doe; John: Sales":mailto:j@x.example\r\nBROKEN LINE\r\n');
    expect(lines).toEqual([
      { name: "SUMMARY", params: {}, value: "Συνάντηση για την προσφορά" },
      { name: "ORGANIZER", params: { CN: "Doe; John: Sales" }, value: "mailto:j@x.example" },
    ]);
  });
});

describe("parseICalendar", () => {
  const cal = (event: string, method = "METHOD:REQUEST\n") => `BEGIN:VCALENDAR\n${method}VERSION:2.0\nBEGIN:VEVENT\n${event}END:VEVENT\nEND:VCALENDAR\n`;

  it("reads METHOD, SUMMARY, DTSTART/DTEND with a Windows TZID, ORGANIZER and LOCATION", () => {
    const info = parseICalendar(
      cal(
        'SUMMARY;LANGUAGE=el-GR:Παρουσίαση\\, νέων κονσολών\nDTSTART;TZID=GTB Standard Time:20260915T100000\nDTEND;TZID=GTB Standard Time:20260915T113000\nORGANIZER;CN="Γιάννης":MAILTO:G.Georgiou@Alfa.example\nLOCATION:Αίθουσα 2\\; 1ος όροφος\n',
      ),
    );
    expect(info).toEqual({
      method: "REQUEST",
      summary: "Παρουσίαση, νέων κονσολών",
      start: "2026-09-15T07:00:00Z",
      end: "2026-09-15T08:30:00Z",
      tzid: "GTB Standard Time",
      organizer: "g.georgiou@alfa.example",
      location: "Αίθουσα 2; 1ος όροφος",
    });
  });

  it("handles UTC, IANA TZIDs, all-day dates and a missing METHOD", () => {
    expect(parseICalendar(cal("DTSTART:20260916T090000Z\n"))!.start).toBe("2026-09-16T09:00:00Z");
    expect(parseICalendar(cal("DTSTART;TZID=Europe/London:20261201T090000\n"))!.start).toBe("2026-12-01T09:00:00Z");
    expect(parseICalendar(cal("DTSTART;VALUE=DATE:20261028\n"))!.start).toBe("2026-10-28");
    expect(parseICalendar(cal("SUMMARY:x\n", ""), "Europe/Athens", "cancel")!.method).toBe("CANCEL");
    expect(parseICalendar(cal("SUMMARY:x\n", ""))!.method).toBe("PUBLISH");
  });

  it("ignores properties outside the first VEVENT (VTIMEZONE, VALARM, later events)", () => {
    const text = `BEGIN:VCALENDAR
METHOD:REQUEST
BEGIN:VTIMEZONE
TZID:GTB Standard Time
BEGIN:STANDARD
DTSTART:16010101T040000
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
DTSTART:20260915T070000Z
BEGIN:VALARM
DESCRIPTION:Reminder
END:VALARM
SUMMARY:First
END:VEVENT
BEGIN:VEVENT
SUMMARY:Second
END:VEVENT
END:VCALENDAR`;
    const info = parseICalendar(text)!;
    expect(info.start).toBe("2026-09-15T07:00:00Z");
    expect(info.summary).toBe("First");
  });

  it("returns null for non-calendar text", () => {
    expect(parseICalendar("hello")).toBeNull();
  });

  it("maps TZIDs", () => {
    expect(resolveTzid("GTB Standard Time", "UTC")).toBe("Europe/Athens");
    expect(resolveTzid("/Europe/Athens", "UTC")).toBe("Europe/Athens");
    expect(resolveTzid("(UTC+02:00) Athens, Bucharest", "UTC")).toBe("UTC+02:00");
    expect(resolveTzid("Some Unknown Zone", "Europe/Athens")).toBe("Europe/Athens");
  });
});

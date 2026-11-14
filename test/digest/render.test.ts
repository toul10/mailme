import { describe, expect, it } from "vitest";
import type { DigestItem, DigestModel, DigestSectionKey } from "../../src/digest/model.js";
import { renderDigest } from "../../src/digest/render.js";
import { BASE_URL, fakeLinks } from "./helpers.js";

function item(o: Partial<DigestItem> = {}): DigestItem {
  return {
    taskId: "00000000-0000-4000-8000-000000000001",
    ref: 12,
    title: "ABC — Αποστολή προσφοράς",
    company: "ABC Α.Ε.",
    nextAction: "Στείλε την ανανεωμένη προσφορά",
    status: "ACTION_REQUIRED",
    dueDate: "2026-09-22",
    duePhrase: null,
    overdueDays: 2,
    businessDaysWaiting: null,
    subject: "Προσφορά ηχείων",
    sender: "Πελάτης ABC",
    lastMessageDate: "2026-09-21 10:02",
    needsReview: false,
    tags: [],
    ...o,
  };
}

function model(sections: Partial<Record<DigestSectionKey, { items: DigestItem[]; more?: number }>> = {}, o: Partial<DigestModel> = {}): DigestModel & { zone: string } {
  const keys: DigestSectionKey[] = ["today", "promises", "followup", "new", "autoClosed", "stillValid", "problems"];
  const secs = Object.fromEntries(keys.map((k) => [k, { items: sections[k]?.items ?? [], more: sections[k]?.more ?? 0 }])) as DigestModel["sections"];
  const empty = keys.every((k) => secs[k].items.length === 0 && secs[k].more === 0);
  return {
    userId: "u1",
    userName: "Ηλίας Παπαδόπουλος",
    localDate: "2026-09-24",
    weekdayLabel: "Thursday 24 Sep",
    late: false,
    freshness: { lastSyncAt: new Date("2026-09-24T04:25:00Z"), staleMinutes: 5, pendingCount: 0, oldestPendingMinutes: null, failedCount: 0, paused: false, banner: null },
    counts: { openTotal: 10, actionToday: secs.today.items.length + secs.today.more, waiting: 2, overdue: 1 },
    sections: secs,
    problems: [],
    isEmpty: empty,
    zone: "Europe/Athens",
    ...o,
  };
}

const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]!);

describe("renderDigest", () => {
  it("builds the subject with the weekday and today's count", async () => {
    const m = model({ today: { items: [item(), item({ taskId: "00000000-0000-4000-8000-000000000002", ref: 13 })], more: 1 } });
    const { subject } = await renderDigest(m, fakeLinks());
    expect(subject).toBe("📋 Tasks — Thu 24 Sep · 3 due today");
  });

  it("uses table layout with inline styles only (Outlook-safe, ≤ 600px, dark on white)", async () => {
    const { html } = await renderDigest(model({ today: { items: [item()] } }), fakeLinks());
    expect(html).toMatch(/^<!DOCTYPE html>/);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<meta http-equiv="Content-Type" content="text/html; charset=utf-8">');
    expect(html).not.toMatch(/<style|<link|<script|stylesheet/i);
    expect(html).not.toMatch(/display:\s*(flex|grid)/i);
    expect(html).toContain('bgcolor="#ffffff"');
    expect(html).toContain("max-width:600px");
    expect(html).toContain('<!--[if mso]><table role="presentation" width="600"');
    expect(html).toMatch(/<table role="presentation"[^>]*cellpadding="0"/);
    expect((html.match(/<table/g) ?? []).length).toBeGreaterThanOrEqual(3);
    // every width is ≤ 600
    for (const w of html.matchAll(/width="(\d+)"/g)) expect(Number(w[1])).toBeLessThanOrEqual(600);
  });

  it("renders the item line: company · action · deadline, then Subject · sender · date", async () => {
    const { html, text } = await renderDigest(model({ today: { items: [item()] } }), fakeLinks());
    expect(html).toContain("ABC Α.Ε. · Στείλε την ανανεωμένη προσφορά · overdue by 2 days (due Tue 22 Sep)");
    expect(html).toContain("Subject: “Προσφορά ηχείων” · Πελάτης ABC · Mon 21 Sep 10:02");
    expect(html).toContain("🔴 Today");
    expect(text).toContain("• #12 ABC — Αποστολή προσφοράς");
    expect(text).toContain("  Subject: “Προσφορά ηχείων” · Πελάτης ABC · Mon 21 Sep 10:02");
  });

  it("escapes hostile titles and never lets AI/email text create links", async () => {
    const evil = item({
      title: `<script>alert(1)</script><a href="https://evil.gr">κλικ</a> "><img src=x onerror=alert(1)>`,
      nextAction: "Πλήρωσε στο https://evil.gr/pay ή πάρε 6912345678",
      company: `<b onmouseover="x()">Evil</b>`,
      subject: `Re: <iframe src="javascript:alert(1)"> http://phish.example/login`,
      sender: `"Support" <a href=//evil.gr>`,
      tags: ["<u>tag</u>"],
    });
    const { html, text } = await renderDigest(model({ new: { items: [evil] } }), fakeLinks());
    expect(html).not.toMatch(/<(script|img|iframe|u)\b|<b onmouseover|<[^>]*onerror|javascript:/i);
    expect(html).not.toContain("https://evil.gr");
    expect(html).not.toContain("http://phish.example");
    expect(html).not.toContain("6912345678");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("[link]");
    // Only platform links are clickable.
    for (const h of hrefs(html)) expect(h.startsWith(`${BASE_URL}/`)).toBe(true);
    expect(text).not.toContain("https://evil.gr");
    expect(text).not.toContain("http://phish.example");
  });

  it("shows ✔/✖ one-click links for new tasks and “Not done” for auto-closed", async () => {
    const links = fakeLinks();
    const m = model({
      new: { items: [item({ taskId: "00000000-0000-4000-8000-00000000000a", overdueDays: null, dueDate: null })] },
      autoClosed: { items: [item({ taskId: "00000000-0000-4000-8000-00000000000b", status: "COMPLETED", overdueDays: null })] },
      stillValid: { items: [item({ taskId: "00000000-0000-4000-8000-00000000000c", overdueDays: null, dueDate: null })] },
    });
    const { html } = await renderDigest(m, links);
    expect(links.issued).toEqual([
      { taskId: "00000000-0000-4000-8000-00000000000a", action: "confirm" },
      { taskId: "00000000-0000-4000-8000-00000000000a", action: "dismiss" },
      { taskId: "00000000-0000-4000-8000-00000000000b", action: "reopen" },
      { taskId: "00000000-0000-4000-8000-00000000000c", action: "still_valid" },
      { taskId: "00000000-0000-4000-8000-00000000000c", action: "complete" },
    ]);
    expect(html).toContain("✔ Correct");
    expect(html).toContain("✖ Not a task");
    expect(html).toContain("Not done — reopen it");
    expect(html).toContain("🔁 Still valid?");
    // closed tasks show no deadline
    expect(html).not.toMatch(/Αποστολή προσφοράς<\/b>[^]*?overdue by[^]*?Not done/);
  });

  it("shows “+N more” with a link to the list when a section is capped", async () => {
    const { html, text } = await renderDigest(model({ followup: { items: [item({ status: "WAITING_FOR_OTHER", businessDaysWaiting: 4 })], more: 3 } }), fakeLinks());
    expect(html).toContain(`href="${BASE_URL}/tasks?tab=waiting"`);
    expect(html).toContain("+3 more");
    expect(html).toContain("🟠 Follow up <span style=\"font-weight:normal;color:#57606a;\">(4)</span>");
    expect(html).toContain("waiting 4 business days");
    expect(text).toContain(`+3 more: ${BASE_URL}/tasks?tab=waiting`);
  });

  it("renders the red freshness banner and the late note", async () => {
    const m = model(
      { today: { items: [item()] } },
      {
        late: true,
        freshness: { lastSyncAt: null, staleMinutes: 130, pendingCount: 0, oldestPendingMinutes: null, failedCount: 2, paused: false, banner: "Analysis incomplete since 05:20 · 2 messages not analysed" },
      },
    );
    const { html, subject, text } = await renderDigest(m, fakeLinks());
    expect(html).toContain('bgcolor="#fdecea"');
    expect(html).toContain("⚠️ Analysis incomplete since 05:20 · 2 messages not analysed");
    expect(html).toContain("Sent late");
    expect(subject).toContain("⚠️ analysis incomplete");
    expect(text).toContain("⚠️ Analysis incomplete since 05:20");
  });

  it("shows the last sync time when data is fresh", async () => {
    const { html } = await renderDigest(model({ today: { items: [item()] } }), fakeLinks());
    expect(html).toContain("Last sync: 07:25");
  });

  it("renders an empty day as a single line", async () => {
    const { html, text, subject } = await renderDigest(model(), fakeLinks());
    expect(subject).toBe("📋 Tasks — Thu 24 Sep · no open tasks");
    expect(html).toContain("No tasks for today.");
    expect(html).not.toContain("🔴 Today");
    expect(text).toContain("No tasks for today.");
  });

  it("lists not-analysed messages and bounced tasks in the problems section", async () => {
    const m = model(
      { problems: { items: [item({ status: "COMPLETED", overdueDays: null, tags: ["⚠️ Not delivered to client@abc-gr.example"] })] } },
      {
        problems: [
          { kind: "not_analyzed", text: "Not analysed: “Παραγγελία <b>42</b>” — Πελάτης · Wed 23 Sep 09:15" },
          { kind: "bounce", text: "Not delivered to client@abc-gr.example: #12 ABC" },
        ],
      },
    );
    const { html } = await renderDigest(m, fakeLinks());
    expect(html).toContain("⚠️ Not analysed / Not delivered");
    expect(html).toContain("Not analysed: “Παραγγελία &lt;b&gt;42&lt;/b&gt;”");
    expect(html).toContain("Not delivered to client@abc-gr\u2024example");
    // the bounce is shown once, as the task item
    expect(html.match(/Not delivered to/g)?.length).toBe(1);
  });

  it("tags promises in today and shows the promise section", async () => {
    const m = model({
      today: { items: [item({ status: "WAITING_FOR_ME", tags: ["Promised for 22 Sep"] })] },
      promises: { items: [item({ taskId: "00000000-0000-4000-8000-000000000005", status: "WAITING_FOR_ME", dueDate: "2026-09-28", overdueDays: null })] },
    });
    const { html } = await renderDigest(m, fakeLinks());
    expect(html).toContain("Promised for 22 Sep");
    expect(html).toContain("🟡 Promises due in the next 3 business days");
    expect(html).toContain("due Mon 28 Sep");
  });
});

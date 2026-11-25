import { describe, expect, it } from "vitest";
import {
  CITATION_RE,
  citedHandles,
  MAIL_HANDLE_RE,
  RENDER_LIMITS,
  renderEarlierSource,
  renderMailSearch,
  renderTask,
  renderTaskSearch,
  renderThread,
  SourceRegistry,
  TASK_HANDLE_RE,
} from "../../src/chat/render.js";
import type { ChatScope, MailRecord, TaskRecord, TaskRef } from "../../src/chat/search.js";
import type { Segment } from "../../src/domain/types.js";

const scope: ChatScope = {
  userId: "u1",
  userName: "Δέσποινα Δοκιμή",
  mailboxIds: ["mb1"],
  onlyMailbox: null,
  ownAddresses: ["owner@contoso.example"],
  internalDomains: ["contoso.example"],
  ownDomains: ["contoso.example"],
  muted: [],
  denyList: [],
  spamFilter: true,
  zone: "Europe/Athens",
  now: new Date("2026-11-20T10:00:00Z"),
};

const seg = (id: string, kind: Segment["kind"], text: string, over: Partial<Segment> = {}): Segment => ({ id, kind, text, author: null, date: null, truncated: false, ...over });
const uuid = (hex: string) => `${hex.padEnd(8, "0")}-0000-4000-8000-000000000000`;

function mail(hex: string, over: Partial<MailRecord> = {}): MailRecord {
  return {
    id: uuid(hex),
    threadId: null,
    date: new Date("2026-11-18T08:42:00Z"),
    own: false,
    internal: false,
    unverified: false,
    fromName: "Γιώργος Παπαδόπουλος",
    fromAddress: "g.pap@abc-gr.example",
    to: [{ name: "Contoso", address: "owner@contoso.example" }],
    cc: [],
    subject: "Προσφορά ηχείων",
    attachments: [],
    filterReason: null,
    segments: [seg("S1", "NEW", "Θέλουμε προσφορά για 4 ηχεία.")],
    textKept: true,
    threadSize: 1,
    tasks: [],
    ...over,
  };
}

function task(ref: number, over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: `task-${ref}`,
    ref,
    title: "ABC — Προσφορά για 4 ηχεία",
    status: "ACTION_REQUIRED",
    ownerKind: "ME",
    ownerName: null,
    ownerAddress: null,
    priority: "NORMAL",
    counterpartyName: "Γιώργος Παπαδόπουλος",
    counterpartyAddress: "g.pap@abc-gr.example",
    company: "ABC",
    dueDate: "2026-11-20",
    nextAction: null,
    summary: null,
    lastActivityAt: new Date("2026-11-18T08:42:00Z"),
    createdAt: new Date("2026-11-18T08:45:00Z"),
    closedAt: null,
    snoozedUntil: null,
    originMessageId: null,
    ...over,
  };
}

describe("handles", () => {
  it("a message keeps its handle, and a clash of the first digits gets a longer one", () => {
    const r = new SourceRegistry();
    const a = mail("3fa9c1aa");
    const b = mail("3fa9c1bb");
    const c = mail("3fa9c1bb", { id: "3fa9c1bb-1111-4000-8000-000000000000" });
    expect(r.addMail(a)).toBe("M3fa9c1");
    expect(r.addMail(a)).toBe("M3fa9c1");
    expect(r.addMail(b)).toBe("M3fa9c1bb");
    expect(r.addMail(c)).toBe("M3fa9c1bb11");
    expect(r.mail("M3fa9c1")?.id).toBe(a.id);
    expect(r.mail(" M3fa9c1bb ")?.id).toBe(b.id);
    expect(r.handleOfMail(c.id)).toBe("M3fa9c1bb11");
    expect(r.mail("M000000")).toBeNull();
    expect(r.handleOfMail("nope")).toBeNull();
    // Registering again keeps the handle and takes the newer record (a search hit, later read in full).
    expect(r.addMail({ ...a, subject: "νεότερο" })).toBe("M3fa9c1");
    expect(r.mail("M3fa9c1")?.subject).toBe("νεότερο");
    for (const h of ["M3fa9c1", "M3fa9c1bb11"]) expect(h).toMatch(MAIL_HANDLE_RE);
  });

  it("a task's handle is its number", () => {
    const r = new SourceRegistry();
    const t: TaskRef = { id: "t1", ref: 184, title: "Κάτι", status: "ACTION_REQUIRED" };
    expect(r.addTask(t)).toBe("#184");
    expect(r.task("#184")).toBe(t);
    expect(r.task(" #184 ")).toBe(t);
    for (const bad of ["184", "#185", "#", "#1e3", "M184", "#1234567890"]) expect(r.task(bad)).toBeNull();
    expect("#184").toMatch(TASK_HANDLE_RE);
  });

  it("finds the handles an answer cites: in its text first, then in the model's list, each once", () => {
    const text = "Ζήτησε προσφορά [M3fa9c1] και υπενθύμισε [M3fa9c1, #184; Mabc12345]. Δες και [#7]. Όχι: [M12], [x], [#], M999999, (#5), [#12 #13].";
    expect(citedHandles(text, ["#184", "[#9]", " Mdeadbeef ", "garbage", "#7", "m3fa9c1"])).toEqual(["M3fa9c1", "#184", "Mabc12345", "#7", "#9", "Mdeadbeef"]);
    expect(citedHandles("", [])).toEqual([]);
    expect([..."[#1][M123456]".matchAll(CITATION_RE)].map((m) => m[1])).toEqual(["#1", "M123456"]);
  });
});

describe("search results", () => {
  it("one block per hit: when, who wrote it, to whom, what about, its tasks, and the snippet as text", () => {
    const r = new SourceRegistry();
    const hit = {
      ...mail("3fa9c1aa", {
        cc: [{ name: null, address: "orders@contoso.example" }],
        attachments: ["offer.pdf", "specs.xlsx"],
        threadSize: 3,
        tasks: [
          { id: "t1", ref: 184, title: "x", status: "ACTION_REQUIRED" },
          { id: "t0", ref: 90, title: "y", status: "COMPLETED" },
        ],
      }),
      snippet: "…θέλουμε προσφορά για 4 ηχεία <b>άμεσα</b>…",
    };
    const out = renderMailSearch(scope, { total: 1, hits: [hit] }, r);
    expect(out).toBe(
      [
        "1 message matched:",
        '<mail handle="M3fa9c1" date="2026-11-18 10:42 Wed" by="external" from="Γιώργος Παπαδόπουλος &lt;g.pap@abc-gr.example&gt;" to="Contoso &lt;owner@contoso.example&gt;" cc="orders@contoso.example" subject="Προσφορά ηχείων" attachments="offer.pdf, specs.xlsx" tasks="#184 (open), #90 (closed)" conversation_messages="3">',
        "…θέλουμε προσφορά για 4 ηχεία &lt;b&gt;άμεσα&lt;/b&gt;…",
        "</mail>",
      ].join("\n"),
    );
    // The tasks named on a hit can be cited and read.
    expect(r.task("#184")?.id).toBe("t1");
    expect(renderMailSearch(scope, { total: 0, hits: [] }, r)).toBe("No message matched.");
    expect(renderMailSearch(scope, { total: 37, hits: [hit, { ...mail("aaaaaa11"), snippet: "" }] }, r).split("\n")[0]).toBe("37 messages matched; the 2 newest:");
    expect(renderMailSearch(scope, { total: 2, hits: [hit, { ...mail("aaaaaa11"), snippet: "" }] }, r)).toMatch(/^2 messages matched:\n[\s\S]*<mail handle="Maaaaaa"[^>]*><\/mail>$/);
  });

  it("says who wrote a message, what the pre-filter made of it, and when its text is gone", () => {
    const r = new SourceRegistry();
    const line = (over: Partial<MailRecord>) => renderMailSearch(scope, { total: 1, hits: [{ ...mail("3fa9c1aa", over), snippet: "" }] }, r).split("\n")[1]!;
    expect(line({ own: true, fromAddress: "owner@contoso.example", fromName: "Contoso" })).toContain(' by="me" from="Contoso &lt;owner@contoso.example&gt;"');
    expect(line({ own: true, unverified: true })).toContain(' by="me (unverified)"');
    expect(line({ internal: true, fromAddress: "orders@contoso.example", fromName: "'Contoso -Orders'" })).toContain(' by="colleague" from="Contoso -Orders &lt;orders@contoso.example&gt;"');
    // A forged colleague is not passed on as a colleague.
    expect(line({ internal: true, unverified: true, fromAddress: "boss@contoso.example" })).toContain(' by="colleague (unverified)"');
    expect(line({ fromAddress: "x@notcontoso.example" })).toContain(' by="external"');
    // A subject is the sender's to write: a very long one is cut.
    const long = line({ subject: "Α".repeat(5000) });
    expect(long).toContain(` subject="${"Α".repeat(299)}…"`);
    expect(long.length).toBeLessThan(700);
    expect(line({ fromAddress: null, fromName: null })).toContain(' by="external" to=');
    expect(line({ fromName: "g.pap@abc-gr.example" })).toContain(' from="g.pap@abc-gr.example"');
    expect(line({ subject: "" })).toContain(' subject="(no subject)"');
    expect(line({ filterReason: "BULK" })).toContain(' note="bulk mail (newsletter or notification)"');
    expect(line({ filterReason: "RULE" })).toContain(" note=\"set aside by one of the user's own mail rules\"");
    expect(line({ filterReason: "SOMETHING_NEW" })).not.toContain(" note=");
    expect(line({ textKept: false, segments: [] })).toContain(' text="not kept"');
    const many = Array.from({ length: 9 }, (_, i) => ({ name: null, address: `p${i}@abc-gr.example` }));
    expect(line({ to: many, cc: many })).toContain(' to="p0@abc-gr.example, p1@abc-gr.example, p2@abc-gr.example, p3@abc-gr.example, p4@abc-gr.example, p5@abc-gr.example +3" cc="p0@abc-gr.example, p1@abc-gr.example, p2@abc-gr.example, p3@abc-gr.example +5"');
    expect(line({ attachments: Array.from({ length: 12 }, (_, i) => `f${i}.pdf`) })).toContain(' attachments="f0.pdf, f1.pdf, f2.pdf, f3.pdf, f4.pdf, f5.pdf, f6.pdf, f7.pdf"');
  });
});

describe("a conversation", () => {
  it("shows the messages oldest first with their own text; quoted mail only under the oldest one, forwarded mail in its own frame", () => {
    const r = new SourceRegistry();
    const first = mail("aaaaaa01", {
      date: new Date("2026-11-17T07:00:00Z"),
      segments: [seg("S1", "NEW", "Προωθώ το αίτημα."), seg("S2", "FORWARDED", "Χρειαζόμαστε 4 ηχεία.", { author: "Νίκος <n@xyz-gr.example>", date: "2026-11-16" }), seg("S3", "QUOTED", "Παλιότερο μήνυμα που δεν έχουμε.")],
    });
    const second = mail("bbbbbb02", {
      own: true,
      fromName: "Contoso",
      fromAddress: "owner@contoso.example",
      to: [{ name: null, address: "g.pap@abc-gr.example" }],
      date: new Date("2026-11-18T09:00:00Z"),
      segments: [seg("S1", "NEW", "Σας στέλνω προσφορά αύριο."), seg("S2", "NEW", "Δέσποινα"), seg("S3", "QUOTED", "Προωθώ το αίτημα.")],
    });
    const out = renderThread(scope, { messages: [first, second], omitted: 0, tasks: [{ id: "t1", ref: 184, title: "x", status: "WAITING_FOR_OTHER" }] }, r);
    expect(out).toBe(
      [
        "Conversation of 2 messages, oldest first. Tasks made from it: #184 (open).",
        '<mail handle="Maaaaaa" date="2026-11-17 09:00 Tue" by="external" from="Γιώργος Παπαδόπουλος &lt;g.pap@abc-gr.example&gt;" to="Contoso &lt;owner@contoso.example&gt;" subject="Προσφορά ηχείων">',
        "Προωθώ το αίτημα.",
        '<forwarded author="Νίκος &lt;n@xyz-gr.example&gt;" date="2026-11-16">',
        "Χρειαζόμαστε 4 ηχεία.",
        "</forwarded>",
        "<quoted>",
        "Παλιότερο μήνυμα που δεν έχουμε.",
        "</quoted>",
        "</mail>",
        '<mail handle="Mbbbbbb" date="2026-11-18 11:00 Wed" by="me" from="Contoso &lt;owner@contoso.example&gt;" to="g.pap@abc-gr.example" subject="Προσφορά ηχείων" quoted_older_mail="left out">',
        "Σας στέλνω προσφορά αύριο.",
        "Δέσποινα",
        "</mail>",
      ].join("\n"),
    );
    expect(renderThread(scope, { messages: [first], omitted: 5, tasks: [] }, new SourceRegistry()).split("\n")[0]).toBe("Conversation of 1 message, oldest first (5 older ones are not shown).");
  });

  it("gives the newest messages their text first when the conversation is too long, and marks what was cut", () => {
    const r = new SourceRegistry();
    const body = (ch: string, n: number) => ch.repeat(n);
    const messages = Array.from({ length: 8 }, (_, i) => mail(`cccccc${String(i).padStart(2, "0")}`, { date: new Date(Date.UTC(2026, 10, 10 + i, 8)), segments: [seg("S1", "NEW", body(String(i), 5000))] }));
    const out = renderThread(scope, { messages, omitted: 0, tasks: [] }, r);
    const blocks = out.split("<mail ").slice(1);
    const textLen = (i: number) => blocks[i]!.split("\n").slice(1, -1).join("\n").replace(/\n<\/mail>$/, "").length;
    // 16,000 characters to share, 3,200 a message: the five newest in full (cut to the per-message size)…
    for (const i of [3, 4, 5, 6, 7]) expect(textLen(i)).toBe(RENDER_LIMITS.messageChars);
    // …and the older ones a short start each.
    for (const i of [0, 1, 2]) expect(textLen(i)).toBe(RENDER_LIMITS.leftoverChars);
    expect(blocks.every((b) => b.includes('text_cut="true"'))).toBe(true);
    expect(out.length).toBeLessThan(RENDER_LIMITS.threadChars + 8 * 400);

    const cut = renderThread(scope, { messages: [mail("dddddd01", { segments: [seg("S1", "NEW", "αρχή", { truncated: true })] })], omitted: 0, tasks: [] }, r);
    expect(cut).toContain('text_cut="true"');
    const gone = renderThread(scope, { messages: [mail("eeeeee01", { textKept: false, segments: [seg("S1", "NEW", "δεν πρέπει να φανεί")] })], omitted: 0, tasks: [] }, r);
    expect(gone).toMatch(/text="not kept"><\/mail>$/);
    expect(gone).not.toContain("δεν πρέπει να φανεί");
    const longQuote = renderThread(scope, { messages: [mail("ffffff01", { segments: [seg("S1", "NEW", "ok"), seg("S2", "QUOTED", "ξ".repeat(4000))] })], omitted: 0, tasks: [] }, r);
    expect(longQuote.match(/ξ/g)!.length).toBe(RENDER_LIMITS.quotedChars - 1);
  });
});

describe("tasks", () => {
  it("one block per task: what it is, whose move, with whom, by when, and the mail it came from", () => {
    const r = new SourceRegistry();
    expect(renderTask(scope, task(184, { summary: "Ζητά προσφορά <επείγον>.", nextAction: "Στείλε προσφορά." }), r, "M3fa9c1")).toBe(
      [
        '<task handle="#184" status="open: someone asked the user for this" handled_by="me" with="Γιώργος Παπαδόπουλος &lt;g.pap@abc-gr.example&gt;" company="ABC" due="2026-11-20" created="2026-11-18" last_activity="2026-11-18" from_mail="M3fa9c1">',
        "<title>ABC — Προσφορά για 4 ηχεία</title>",
        "<summary>Ζητά προσφορά &lt;επείγον&gt;.</summary>",
        "<next_step>Στείλε προσφορά.</next_step>",
        "</task>",
      ].join("\n"),
    );
    const head = (over: Partial<TaskRecord>) => renderTask(scope, task(1, over), r, null).split("\n")[0]!;
    expect(head({ status: "WAITING_FOR_ME" })).toContain('status="open: the user promised this"');
    expect(head({ status: "WAITING_FOR_OTHER" })).toContain('status="open: the user waits for someone else"');
    expect(head({ status: "COMPLETED", closedAt: new Date("2026-11-19T22:30:00Z") })).toMatch(/status="closed: done".* closed="2026-11-20"/);
    expect(head({ status: "DISMISSED" })).toContain('status="closed: dismissed"');
    expect(head({ ownerKind: "INTERNAL", ownerName: "Παραγγελίες", ownerAddress: "orders@contoso.example" })).toContain('handled_by="colleague: Παραγγελίες &lt;orders@contoso.example&gt;"');
    expect(head({ ownerKind: "INTERNAL" })).toContain('handled_by="colleague: ?"');
    expect(head({ ownerKind: "EXTERNAL", ownerAddress: "x@far-de.example" })).toContain('handled_by="external: x@far-de.example"');
    expect(head({ ownerKind: "UNCLEAR" })).toContain('handled_by="unclear"');
    expect(head({ priority: "HIGH", snoozedUntil: "2026-12-01", dueDate: null, company: null })).toMatch(/priority="high" with="[^"]+" snoozed_until="2026-12-01" created=/);
    expect(head({})).not.toMatch(/priority=|from_mail=|closed=|snoozed_until=/);
    expect(renderTask(scope, task(2, { summary: "ξ".repeat(2000) }), r, null).match(/ξ/g)!.length).toBe(RENDER_LIMITS.summaryChars - 1);
  });

  it("a list of tasks names the mail each came from, when that mail was read", () => {
    const r = new SourceRegistry();
    const a = task(184, { originMessageId: "m-1" });
    const b = task(185, { originMessageId: "m-2", title: "Δεύτερη" });
    const out = renderTaskSearch(scope, { total: 2, hits: [a, b] }, r, new Map([["m-1", "M3fa9c1"]]));
    expect(out.split("\n")[0]).toBe("2 tasks matched:");
    expect(out).toMatch(/<task handle="#184"[^>]* from_mail="M3fa9c1">/);
    expect(out).toMatch(/<task handle="#185"[^>]* last_activity="2026-11-18">/);
    expect(renderTaskSearch(scope, { total: 0, hits: [] }, r, new Map())).toBe("No task matched.");
    expect(renderTaskSearch(scope, { total: 44, hits: [a] }, r, new Map()).split("\n")[0]).toBe("44 tasks matched; 1 shown (open ones first, then the most recently active):");
    expect(renderTaskSearch(scope, { total: 1, hits: [a] }, r, new Map()).split("\n")[0]).toBe("1 task matched:");
  });

  it("a source of an earlier answer is one line, and its handle works again", () => {
    const r = new SourceRegistry();
    expect(renderEarlierSource(scope, r, { mail: mail("3fa9c1aa") })).toBe(
      '<mail handle="M3fa9c1" date="2026-11-18 10:42 Wed" by="external" from="Γιώργος Παπαδόπουλος &lt;g.pap@abc-gr.example&gt;" subject="Προσφορά ηχείων" />',
    );
    // Short whatever the mail looks like: these lines go along with every later question.
    const big = mail("bbbbbb22", { subject: "Θ".repeat(3000), to: Array.from({ length: 30 }, (_, i) => ({ name: `Παραλήπτης ${i}`, address: `r${i}@abc-gr.example` })), attachments: ["a.pdf", "b.pdf"] });
    expect(renderEarlierSource(scope, r, { mail: big }).length).toBeLessThan(320);
    expect(renderEarlierSource(scope, r, { task: { id: "t2", ref: 10, title: "Τ".repeat(3000), status: "ACTION_REQUIRED" } }).length).toBeLessThan(330);
    expect(renderEarlierSource(scope, r, { task: { id: "t1", ref: 9, title: "Τίτλος <b>", status: "COMPLETED" } })).toBe('<task handle="#9" status="closed: done"><title>Τίτλος &lt;b&gt;</title></task>');
    expect(renderEarlierSource(scope, r, {})).toBe("");
    expect(r.mail("M3fa9c1")).not.toBeNull();
    expect(r.task("#9")).not.toBeNull();
  });
});

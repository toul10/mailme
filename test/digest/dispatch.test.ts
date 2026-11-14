import { simpleParser } from "mailparser";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as s from "../../src/db/schema.js";
import { holidayCalendar } from "../../src/digest/calendar.js";
import { decideDue, deliverDigestForUser, dispatchDueDigests } from "../../src/digest/dispatch.js";
import { classifyImapError } from "../../src/mail/imap/errors.js";
import { addTask, AT_0730, BASE_URL, FakeTransport, makeDeps, setup, TODAY, type Fixture } from "./helpers.js";

vi.mock("../../src/mail/imap/errors.js", () => ({
  classifyImapError: vi.fn((err: unknown) => ({ kind: (err as { authenticationFailed?: boolean })?.authenticationFailed ? "auth" : "network", message: "x" })),
}));

const ATHENS = "Europe/Athens";
const cal = holidayCalendar();
const at = (iso: string) => new Date(iso);
const plusMin = (d: Date, n: number) => new Date(d.getTime() + n * 60_000);

describe("decideDue", () => {
  it("is not due before the digest time, due at it, late after 30 min, too late from 11:00", () => {
    expect(decideDue(at("2026-09-24T04:29:00Z"), ATHENS, "07:30", null, cal)).toEqual({ kind: "not_due", localDate: TODAY, reason: "before_time" });
    expect(decideDue(AT_0730, ATHENS, "07:30", null, cal)).toEqual({ kind: "send", localDate: TODAY, late: false });
    expect(decideDue(at("2026-09-24T05:00:00Z"), ATHENS, "07:30", null, cal)).toEqual({ kind: "send", localDate: TODAY, late: false });
    expect(decideDue(at("2026-09-24T05:01:00Z"), ATHENS, "07:30", null, cal)).toEqual({ kind: "send", localDate: TODAY, late: true });
    expect(decideDue(at("2026-09-24T07:59:00Z"), ATHENS, "07:30", null, cal)).toEqual({ kind: "send", localDate: TODAY, late: true });
    expect(decideDue(at("2026-09-24T08:00:00Z"), ATHENS, "07:30", null, cal)).toEqual({ kind: "too_late", localDate: TODAY });
  });

  it("skips weekends and Greek holidays (incl. Easter-based ones)", () => {
    expect(decideDue(at("2026-09-26T04:30:00Z"), ATHENS, "07:30", null, cal)).toMatchObject({ kind: "not_due", reason: "non_business_day" });
    expect(decideDue(at("2026-10-28T05:30:00Z"), ATHENS, "07:30", null, cal)).toMatchObject({ kind: "not_due", reason: "non_business_day" });
    expect(decideDue(at("2027-04-30T04:30:00Z"), ATHENS, "07:30", null, cal)).toMatchObject({ kind: "not_due", reason: "non_business_day" }); // Good Friday
    expect(decideDue(at("2027-05-03T04:30:00Z"), ATHENS, "07:30", null, cal)).toMatchObject({ kind: "not_due", reason: "non_business_day" }); // Easter Monday
    expect(decideDue(at("2027-06-21T04:30:00Z"), ATHENS, "07:30", null, cal)).toMatchObject({ kind: "send" }); // Holy Spirit Monday (optional)
    expect(decideDue(at("2027-06-21T04:30:00Z"), ATHENS, "07:30", null, holidayCalendar({ includeHolySpirit: true }))).toMatchObject({ kind: "not_due" });
  });

  it("respects the digest start date", () => {
    expect(decideDue(AT_0730, ATHENS, "07:30", "2026-09-25", cal)).toMatchObject({ kind: "not_due", reason: "before_start" });
    expect(decideDue(AT_0730, ATHENS, "07:30", TODAY, cal)).toMatchObject({ kind: "send" });
  });

  it("uses local wall-clock time across DST changes", () => {
    // Fri 23/10 (EEST, UTC+3) and Mon 26/10 (EET, UTC+2) around the October change.
    expect(decideDue(at("2026-10-23T04:30:00Z"), ATHENS, "07:30", null, cal)).toMatchObject({ kind: "send", localDate: "2026-10-23" });
    expect(decideDue(at("2026-10-26T04:30:00Z"), ATHENS, "07:30", null, cal)).toMatchObject({ kind: "not_due", reason: "before_time" });
    expect(decideDue(at("2026-10-26T05:30:00Z"), ATHENS, "07:30", null, cal)).toEqual({ kind: "send", localDate: "2026-10-26", late: false });
    expect(decideDue(at("2026-10-26T09:00:00Z"), ATHENS, "07:30", null, cal)).toMatchObject({ kind: "too_late" });
    // Mon 29/03/2027, the day after clocks go forward.
    expect(decideDue(at("2027-03-29T04:29:00Z"), ATHENS, "07:30", null, cal)).toMatchObject({ kind: "not_due" });
    expect(decideDue(at("2027-03-29T04:30:00Z"), ATHENS, "07:30", null, cal)).toMatchObject({ kind: "send", localDate: "2027-03-29" });
  });

  it("falls back to 07:30 for a bad digest time and keeps a window for times after 11:00", () => {
    expect(decideDue(AT_0730, ATHENS, "7.30", null, cal)).toMatchObject({ kind: "send" });
    expect(decideDue(at("2026-09-24T09:00:00Z"), ATHENS, "12:00", null, cal)).toEqual({ kind: "send", localDate: TODAY, late: false });
    expect(decideDue(at("2026-09-24T12:29:00Z"), ATHENS, "12:00", null, cal)).toMatchObject({ kind: "send", late: true });
    expect(decideDue(at("2026-09-24T12:30:00Z"), ATHENS, "12:00", null, cal)).toMatchObject({ kind: "too_late" });
  });
});

describe("dispatchDueDigests", () => {
  let f: Fixture;
  let transport: FakeTransport;
  beforeEach(async () => {
    f = await setup();
    transport = new FakeTransport();
    vi.mocked(classifyImapError).mockClear();
  });
  afterEach(() => f.t.close());

  const digestRow = async () => (await f.db.select().from(s.digests).where(eq(s.digests.userId, f.userId)))[0];

  it("delivers exactly once per user and day, even when called again", async () => {
    await addTask(f, { dueDate: TODAY, title: "ABC — Αποστολή προσφοράς" });
    const deps = makeDeps(f, transport);
    expect(await dispatchDueDigests(deps, AT_0730)).toEqual({ considered: 1, delivered: 1, failed: 0, skipped: 0 });
    expect(await dispatchDueDigests(deps, plusMin(AT_0730, 1))).toEqual({ considered: 1, delivered: 0, failed: 0, skipped: 0 });
    expect(await dispatchDueDigests(makeDeps(f, transport), plusMin(AT_0730, 5))).toEqual({ considered: 1, delivered: 0, failed: 0, skipped: 0 });
    expect(transport.calls).toHaveLength(1);

    const call = transport.calls[0]!;
    const msgId = `digest.${f.userId}.${TODAY}@mailme.test`;
    expect(call.kind).toBe("append");
    expect(call.messageId).toBe(msgId);
    expect(call.password).toBe("pw");
    expect(call.settings).toEqual({
      mailboxId: f.mailboxId,
      address: "owner@contoso.example",
      imapHost: "mail.contoso.example",
      imapPort: 993,
      imapUsername: "owner@contoso.example",
      smtpHost: "mail.contoso.example",
      smtpPort: 587,
    });
    const parsed = await simpleParser(call.raw);
    expect(parsed.messageId).toBe(`<${msgId}>`);
    expect(parsed.headers.get("auto-submitted")).toBe("auto-generated");
    expect(parsed.headers.get("x-mailme-kind")).toBe("digest");
    expect(parsed.subject).toBe("📋 Tasks — Thu 24 Sep · 1 due today");
    expect(parsed.html).toContain("ABC — Αποστολή προσφοράς");

    const row = await digestRow();
    expect(row).toMatchObject({ status: "delivered", deliveredVia: "append", appendUid: 101, attempts: 1, late: false, messageIdHeader: msgId, lastError: null });
    expect(row!.deliveredAt).toEqual(AT_0730);
    expect(row!.html).toContain("<!DOCTYPE html>");
    expect(row!.sections?.today).toHaveLength(1);
    const nonces = await f.db.select().from(s.actionNonces);
    expect(nonces.length).toBeGreaterThan(0);
    expect(nonces.every((n) => n.digestId === row!.id)).toBe(true);
  });

  it("does nothing before the digest time, on weekends and holidays", async () => {
    const deps = makeDeps(f, transport);
    expect(await dispatchDueDigests(deps, at("2026-09-24T04:29:00Z"))).toEqual({ considered: 0, delivered: 0, failed: 0, skipped: 0 });
    expect(await dispatchDueDigests(deps, at("2026-09-26T04:30:00Z"))).toEqual({ considered: 0, delivered: 0, failed: 0, skipped: 0 });
    expect(await dispatchDueDigests(deps, at("2026-10-28T05:30:00Z"))).toEqual({ considered: 0, delivered: 0, failed: 0, skipped: 0 });
    expect(await f.db.select().from(s.digests)).toHaveLength(0);
    expect(transport.calls).toHaveLength(0);
  });

  it("honours digest_start_date, digest_enabled and disabled users", async () => {
    const deps = makeDeps(f, transport);
    await f.db.update(s.users).set({ digestStartDate: "2026-09-25" }).where(eq(s.users.id, f.userId));
    expect((await dispatchDueDigests(deps, AT_0730)).considered).toBe(0);
    await f.db.update(s.users).set({ digestStartDate: TODAY, digestEnabled: false }).where(eq(s.users.id, f.userId));
    expect((await dispatchDueDigests(deps, AT_0730)).considered).toBe(0);
    await f.db.update(s.users).set({ digestEnabled: true, disabledAt: AT_0730 }).where(eq(s.users.id, f.userId));
    expect((await dispatchDueDigests(deps, AT_0730)).considered).toBe(0);
    await f.db.update(s.users).set({ disabledAt: null }).where(eq(s.users.id, f.userId));
    expect((await dispatchDueDigests(deps, AT_0730)).delivered).toBe(1);
  });

  it("uses the user's own digest time in the org timezone", async () => {
    await f.db.update(s.users).set({ digestTime: "08:15" }).where(eq(s.users.id, f.userId));
    const deps = makeDeps(f, transport);
    expect((await dispatchDueDigests(deps, at("2026-09-24T05:14:00Z"))).considered).toBe(0);
    expect((await dispatchDueDigests(deps, at("2026-09-24T05:15:00Z"))).delivered).toBe(1);
  });

  it("catches up after a restart with the late flag", async () => {
    const deps = makeDeps(f, transport);
    const report = await dispatchDueDigests(deps, at("2026-09-24T06:10:00Z")); // 09:10 local
    expect(report.delivered).toBe(1);
    const row = await digestRow();
    expect(row!.late).toBe(true);
    expect(row!.html).toContain("Sent late");
  });

  it("after 11:00 records a skipped row once (and warns) without sending", async () => {
    const deps = makeDeps(f, transport);
    expect(await dispatchDueDigests(deps, at("2026-09-24T08:00:00Z"))).toEqual({ considered: 1, delivered: 0, failed: 0, skipped: 1 });
    expect(await dispatchDueDigests(deps, at("2026-09-24T08:01:00Z"))).toEqual({ considered: 1, delivered: 0, failed: 0, skipped: 0 });
    expect(transport.calls).toHaveLength(0);
    expect(await digestRow()).toMatchObject({ status: "skipped", lastError: "catchup_window_passed" });
    expect(deps.log.entries.filter((e) => e.level === "warn")).toHaveLength(1);
  });

  it("retries a failed delivery on later ticks (with backoff) until it succeeds", async () => {
    transport.failures.push(Object.assign(new Error("socket hang up for owner@contoso.example"), { code: "ECONNRESET" }));
    const deps = makeDeps(f, transport);
    expect(await dispatchDueDigests(deps, AT_0730)).toMatchObject({ delivered: 0, failed: 1 });
    let row = await digestRow();
    expect(row).toMatchObject({ status: "failed", attempts: 1, lastError: "Error:ECONNRESET" });
    // within the backoff: not retried
    expect(await dispatchDueDigests(deps, plusMin(AT_0730, 0.5))).toMatchObject({ delivered: 0, failed: 0 });
    expect(transport.calls).toHaveLength(1);
    expect(await dispatchDueDigests(deps, plusMin(AT_0730, 2))).toMatchObject({ delivered: 1, failed: 0 });
    row = await digestRow();
    expect(row).toMatchObject({ status: "delivered", attempts: 2, lastError: null, late: false });
    expect(transport.calls).toHaveLength(2);
    // nothing logged contains addresses or content
    const logged = JSON.stringify(deps.log.entries);
    expect(logged).not.toContain("@");
    expect(logged).not.toContain("Αποστολή");
  });

  it("keeps retrying transient failures with backoff (≤ 15 min) until 11:00, then stops", async () => {
    for (let i = 0; i < 100; i++) transport.failures.push(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }));
    const deps = makeDeps(f, transport);
    const attemptTimes: number[] = [];
    // A tick every 5 minutes from 07:30 to 11:30 local.
    for (let m = 0; m <= 240; m += 5) {
      const before = transport.calls.length;
      await dispatchDueDigests(deps, plusMin(AT_0730, m));
      if (transport.calls.length > before) attemptTimes.push(m);
    }
    // Backoff 1, 2, 5, 10, then every 15 min: 07:30, 07:35, 07:40, 07:45, 07:55, 08:10 … 10:55.
    expect(attemptTimes.slice(0, 6)).toEqual([0, 5, 10, 15, 25, 40]);
    for (let i = 5; i < attemptTimes.length; i++) expect(attemptTimes[i]! - attemptTimes[i - 1]!).toBe(15);
    expect(attemptTimes.at(-1)).toBe(205); // 10:55, the last tick before the deadline
    expect(await digestRow()).toMatchObject({ status: "failed", attempts: attemptTimes.length, lastError: "Error:ETIMEDOUT" });
    // A row exists, so no “skipped” row is written after 11:00.
    expect(await f.db.select().from(s.digests)).toHaveLength(1);
  });

  it("an authentication failure marks the mailbox auth_failed; retries do not log in again until it is fixed", async () => {
    transport.failures.push(Object.assign(new Error("AUTHENTICATIONFAILED"), { authenticationFailed: true }));
    const deps = makeDeps(f, transport);
    expect((await dispatchDueDigests(deps, AT_0730)).failed).toBe(1);
    expect(await digestRow()).toMatchObject({ status: "failed", attempts: 1, lastError: "auth" });
    const [mb] = await f.db.select().from(s.mailboxes).where(eq(s.mailboxes.id, f.mailboxId));
    expect(mb).toMatchObject({ status: "auth_failed", lastError: "auth" });

    expect((await dispatchDueDigests(deps, plusMin(AT_0730, 20))).failed).toBe(1);
    expect(transport.calls).toHaveLength(1);
    expect(await digestRow()).toMatchObject({ status: "failed", attempts: 2, lastError: "mailbox_auth_failed" });

    // The user re-enters the password → the next retry delivers.
    await f.db.update(s.mailboxes).set({ status: "active" }).where(eq(s.mailboxes.id, f.mailboxId));
    expect((await dispatchDueDigests(deps, plusMin(AT_0730, 45))).delivered).toBe(1);
    expect(transport.calls).toHaveLength(2);
  });

  it("recognises an SMTP auth error even without the IMAP classifier", async () => {
    vi.mocked(classifyImapError).mockImplementationOnce(() => {
      throw new Error("not implemented");
    });
    await f.db.update(s.users).set({ digestDelivery: "smtp" }).where(eq(s.users.id, f.userId));
    transport.failures.push(Object.assign(new Error("Invalid login: 535 5.7.8"), { code: "EAUTH", responseCode: 535 }));
    await dispatchDueDigests(makeDeps(f, transport), AT_0730);
    expect(await digestRow()).toMatchObject({ status: "failed", lastError: "auth:EAUTH", attempts: 1 });
    const [mb] = await f.db.select().from(s.mailboxes).where(eq(s.mailboxes.id, f.mailboxId));
    expect(mb!.status).toBe("auth_failed");
  });

  it("delivers over SMTP to the user's own address when configured", async () => {
    await f.db.update(s.users).set({ digestDelivery: "smtp" }).where(eq(s.users.id, f.userId));
    expect((await dispatchDueDigests(makeDeps(f, transport), AT_0730)).delivered).toBe(1);
    expect(transport.calls[0]).toMatchObject({ kind: "smtp", envelope: { from: "owner@contoso.example", to: ["owner@contoso.example"] } });
    expect(await digestRow()).toMatchObject({ status: "delivered", deliveredVia: "smtp", appendUid: null });
  });

  it("uses the configured digest mailbox, else the first active IMAP mailbox", async () => {
    const [second] = await f.db
      .insert(s.mailboxes)
      .values({ orgId: f.orgId, userId: f.userId, address: "sales@contoso.example", imapHost: "imap.other-gr.example", imapUsername: "sales", status: "active", createdAt: new Date("2030-01-01T00:00:00Z") })
      .returning();
    await f.db.update(s.users).set({ digestMailboxId: second!.id }).where(eq(s.users.id, f.userId));
    await dispatchDueDigests(makeDeps(f, transport), AT_0730);
    expect(transport.calls[0]!.settings).toMatchObject({ mailboxId: second!.id, imapHost: "imap.other-gr.example", imapUsername: "sales" });
  });

  it("fails fast (no render, no login) while there is no usable mailbox, and recovers when one appears", async () => {
    await f.db.update(s.mailboxes).set({ status: "disabled" }).where(eq(s.mailboxes.id, f.mailboxId));
    const deps = makeDeps(f, transport);
    expect((await dispatchDueDigests(deps, AT_0730)).failed).toBe(1);
    expect((await dispatchDueDigests(deps, plusMin(AT_0730, 30))).failed).toBe(1);
    expect(await digestRow()).toMatchObject({ status: "failed", lastError: "no_mailbox", attempts: 2, html: null });
    expect(await f.db.select().from(s.actionNonces)).toHaveLength(0);
    expect(transport.calls).toHaveLength(0);
    await f.db.update(s.mailboxes).set({ status: "active" }).where(eq(s.mailboxes.id, f.mailboxId));
    expect((await dispatchDueDigests(deps, plusMin(AT_0730, 60))).delivered).toBe(1);
  });

  it("marks auto-closed tasks as reported and stamps shown “Still valid?” questions — only on success", async () => {
    const closed = await addTask(f, { status: "COMPLETED", closedBy: "ai", closedAt: at("2026-09-23T10:00:00Z") });
    const asked = await addTask(f, { stillValidAskedAt: at("2026-09-23T03:00:00Z"), lastActivityAt: at("2026-09-01T08:00:00Z") });
    transport.failures.push(new Error("boom"));
    const deps = makeDeps(f, transport);
    await dispatchDueDigests(deps, AT_0730);
    let [c] = await f.db.select().from(s.tasks).where(eq(s.tasks.id, closed.id));
    expect(c!.autoClosedReportedAt).toBeNull();

    await dispatchDueDigests(deps, plusMin(AT_0730, 3));
    [c] = await f.db.select().from(s.tasks).where(eq(s.tasks.id, closed.id));
    const [a] = await f.db.select().from(s.tasks).where(eq(s.tasks.id, asked.id));
    expect(c!.autoClosedReportedAt).toEqual(plusMin(AT_0730, 3));
    expect(a!.stillValidAskedAt).toEqual(plusMin(AT_0730, 3));
    const row = await digestRow();
    expect(row!.sections).toMatchObject({ autoClosed: [closed.id], stillValid: [asked.id] });

    // Next business day: neither is shown again.
    const friday = at("2026-09-25T04:30:00Z");
    await dispatchDueDigests(makeDeps(f, transport, friday), friday);
    const [fri] = await f.db.select().from(s.digests).where(and(eq(s.digests.userId, f.userId), eq(s.digests.localDate, "2026-09-25")));
    expect(fri!.status).toBe("delivered");
    expect(fri!.sections).toMatchObject({ autoClosed: [], stillValid: [] });
  });

  it("recovers a row left 'rendered' by a crash; APPEND stays idempotent", async () => {
    const msgId = `digest.${f.userId}.${TODAY}@mailme.test`;
    await f.db.insert(s.digests).values({ userId: f.userId, localDate: TODAY, status: "rendered", attempts: 1, messageIdHeader: msgId });
    transport.inbox.set(msgId, 77); // the crashed attempt had already appended
    const report = await dispatchDueDigests(makeDeps(f, transport), plusMin(AT_0730, 4));
    expect(report.delivered).toBe(1);
    expect(await digestRow()).toMatchObject({ status: "delivered", attempts: 2, appendUid: 77 });
    expect(transport.inbox.size).toBe(1);
  });

  it("dispatches independently for several users", async () => {
    const other = await setup({ shared: f.t });
    await dispatchDueDigests(makeDeps(f, transport), AT_0730);
    await dispatchDueDigests(makeDeps(f, transport), plusMin(AT_0730, 1));
    expect(transport.calls.map((c) => c.messageId).sort()).toEqual([`digest.${f.userId}.${TODAY}@mailme.test`, `digest.${other.userId}.${TODAY}@mailme.test`].sort());
  });

  it("delivers on the local date across the October DST change", async () => {
    const deps = makeDeps(f, transport);
    expect((await dispatchDueDigests(deps, at("2026-10-26T04:30:00Z"))).considered).toBe(0);
    expect((await dispatchDueDigests(deps, at("2026-10-26T05:30:00Z"))).delivered).toBe(1);
    expect(transport.calls[0]!.messageId).toBe(`digest.${f.userId}.2026-10-26@mailme.test`);
    expect((await digestRow())!.localDate).toBe("2026-10-26");
  });
});

describe("deliverDigestForUser", () => {
  let f: Fixture;
  let transport: FakeTransport;
  beforeEach(async () => {
    f = await setup();
    transport = new FakeTransport();
  });
  afterEach(() => f.t.close());

  it("dry run renders a preview without touching the database or the mailbox", async () => {
    await addTask(f, { dueDate: TODAY });
    const res = await deliverDigestForUser(makeDeps(f, transport), f.userId, TODAY, { dryRun: true });
    expect(res.status).toBe("preview");
    expect(res.subject).toBe("📋 Tasks — Thu 24 Sep · 1 due today");
    expect(res.html).toContain(`${BASE_URL}/a/preview-complete-`);
    expect(await f.db.select().from(s.digests)).toHaveLength(0);
    expect(await f.db.select().from(s.actionNonces)).toHaveLength(0);
    expect(transport.calls).toHaveLength(0);
  });

  it("delivers once; a second call returns the stored report", async () => {
    const deps = makeDeps(f, transport);
    const first = await deliverDigestForUser(deps, f.userId, TODAY);
    expect(first.status).toBe("delivered");
    const second = await deliverDigestForUser(deps, f.userId, TODAY);
    expect(second).toEqual({ status: "already_delivered", html: first.html, subject: first.subject });
    expect(transport.calls).toHaveLength(1);
  });

  it("can resend a report that was skipped", async () => {
    await f.db.insert(s.digests).values({ userId: f.userId, localDate: TODAY, status: "skipped" });
    const res = await deliverDigestForUser(makeDeps(f, transport), f.userId, TODAY, { late: true });
    expect(res.status).toBe("delivered");
    expect(res.html).toContain("Sent late");
  });
});

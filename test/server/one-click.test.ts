import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as s from "../../src/db/schema.js";
import { redeemActionToken } from "../../src/digest/links.js";
import * as ua from "../../src/engine/user-actions.js";
import { signActionToken, verifyActionToken, type ActionTokenPayload } from "../../src/lib/crypto.js";
import { deriveLinkSecret } from "../../src/server/secrets.js";
import { insertTask } from "../helpers/db.js";
import { addUser, makeHarness, type Harness } from "./helpers.js";

vi.mock("../../src/digest/links.js", () => ({ createLinkFactory: vi.fn(), redeemActionToken: vi.fn() }));
vi.mock("../../src/engine/user-actions.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../src/engine/user-actions.js")>();
  return {
    ...orig,
    completeTask: vi.fn(async () => {}),
    dismissTask: vi.fn(async () => {}),
    snoozeTask: vi.fn(async () => {}),
    confirmTask: vi.fn(async () => {}),
    reopenTask: vi.fn(async () => {}),
    markStillValid: vi.fn(async () => {}),
  };
});

const ORIGIN = "http://localhost:3000";
let h: Harness;
let taskId: string;
let used: Set<string>;

/** Fake of the digest link store: real HMAC tokens + an in-memory single-use set. */
function installFakeRedeem() {
  used = new Set();
  vi.mocked(redeemActionToken).mockImplementation(async (_db, secret, token, now, consume) => {
    const p = verifyActionToken(token, secret, Math.floor(now.getTime() / 1000));
    if (!p || used.has(token)) return null;
    if (consume) used.add(token);
    return { userId: p.u, taskId: p.t, action: p.a, nonce: token.slice(-10) };
  });
}

function tokenFor(action: string, opts: { task?: string; user?: string; expSec?: number; secret?: string } = {}): string {
  const payload = {
    t: opts.task ?? taskId,
    a: action as ActionTokenPayload["a"],
    u: opts.user ?? h.seed.user.id,
    exp: opts.expSec ?? Math.floor(h.clock.now().getTime() / 1000) + 7 * 86_400,
  };
  return signActionToken(payload, opts.secret ?? deriveLinkSecret(h.config));
}

function post(token: string, form: Record<string, string> = {}, headers: Record<string, string> = { origin: ORIGIN }) {
  return h.app.inject({
    method: "POST",
    url: `/a/${token}`,
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    payload: new URLSearchParams({ token, ...form }).toString(),
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  h = await makeHarness(); // 2026-09-15 (Tue)
  const task = await insertTask(h.t.db, {
    orgId: h.seed.org.id,
    userId: h.seed.user.id,
    mailboxId: h.seed.mailbox.id,
    title: `ABC — Προσφορά <script>alert("x")</script>`,
    company: "ABC & Υιοί",
    dueDate: "2026-09-18",
  });
  taskId = task.id;
  installFakeRedeem();
});

afterEach(async () => {
  await h.close();
});

describe("one-click pages", () => {
  it("GET shows an escaped confirmation form and never mutates", async () => {
    const token = tokenFor("complete");
    expect(token.length).toBeGreaterThan(100);
    const res = await h.app.inject({ method: "GET", url: `/a/${token}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["content-security-policy"]).toContain("form-action 'self'");
    const html = res.body;
    expect(html).toContain("ABC — Προσφορά &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(html).not.toContain("<script");
    expect(html).toContain("ABC &amp; Υιοί");
    expect(html).toContain("18 Sep 2026");
    expect(html).toContain('method="post"');
    expect(html).toContain(`action="/a/${token}"`);
    expect(html).toContain(`name="token" value="${token}"`);
    expect(html).toContain("✔ Done");
    // Only report fields: no counterparty address or other content.
    expect(html).not.toContain("client@abc-gr.example");
    expect(vi.mocked(redeemActionToken)).toHaveBeenCalledWith(h.t.db, deriveLinkSecret(h.config), token, h.clock.now(), false);
    expect(vi.mocked(ua.completeTask)).not.toHaveBeenCalled();
    expect(used.size).toBe(0);
    // Prefetching twice changes nothing either.
    expect((await h.app.inject({ method: "GET", url: `/a/${token}` })).statusCode).toBe(200);
  });

  it("POST performs the action once via 'link'; reuse is rejected", async () => {
    const token = tokenFor("complete");
    const res = await post(token);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Done ✔");
    expect(vi.mocked(ua.completeTask)).toHaveBeenCalledTimes(1);
    const [ctx, id] = vi.mocked(ua.completeTask).mock.calls[0]!;
    expect(id).toBe(taskId);
    expect(ctx).toMatchObject({ userId: h.seed.user.id, via: "link" });
    expect(ctx.expectedVersion).toBeUndefined();
    expect(res.headers["referrer-policy"]).toBe("no-referrer");

    const again = await post(token);
    expect(again.statusCode).toBe(410);
    expect(again.body).toContain("This link is no longer valid");
    expect((await h.app.inject({ method: "GET", url: `/a/${token}` })).statusCode).toBe(410);
    expect(vi.mocked(ua.completeTask)).toHaveBeenCalledTimes(1);
    const audits = await h.t.db.select().from(s.securityAudit).where(eq(s.securityAudit.event, "oneclick.action"));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.detail).toEqual({ taskId, action: "complete" });
  });

  it("rejects cross-origin posts without consuming the token", async () => {
    const token = tokenFor("complete");
    const rejected: Array<Record<string, string>> = [{ origin: "https://evil.example" }, { origin: "null", "sec-fetch-site": "cross-site" }, {}, { referer: "https://evil.example/page" }];
    for (const headers of rejected) {
      const res = await post(token, {}, headers);
      expect(res.statusCode).toBe(403);
      expect(res.headers["content-type"]).toContain("text/html");
    }
    expect(vi.mocked(ua.completeTask)).not.toHaveBeenCalled();
    expect(used.size).toBe(0);
    // Our own no-referrer page posts with "Origin: null" + Sec-Fetch-Site: same-origin.
    const ok = await post(token, {}, { origin: "null", "sec-fetch-site": "same-origin" });
    expect(ok.statusCode).toBe(200);
    expect(vi.mocked(ua.completeTask)).toHaveBeenCalledTimes(1);
  });

  it("accepts a same-origin Referer when the browser sends no Origin/Fetch Metadata", async () => {
    const res = await post(tokenFor("confirm"), {}, { referer: `${ORIGIN}/a/whatever` });
    expect(res.statusCode).toBe(200);
    expect(vi.mocked(ua.confirmTask)).toHaveBeenCalledTimes(1);
  });

  it("snooze: date field and “until they reply”; a bad date doesn't burn the link", async () => {
    const token = tokenFor("snooze");
    const page = await h.app.inject({ method: "GET", url: `/a/${token}` });
    expect(page.body).toContain('type="date" name="until"');
    expect(page.body).toContain('min="2026-09-16"');
    expect(page.body).toContain("until they reply");

    const past = await post(token, { mode: "until_date", until: "2026-09-10" });
    expect(past.statusCode).toBe(400);
    const garbage = await post(token, { mode: "until_date", until: "2026-13-45" });
    expect(garbage.statusCode).toBe(400);
    expect(used.size).toBe(0);
    expect(vi.mocked(ua.snoozeTask)).not.toHaveBeenCalled();

    const ok = await post(token, { mode: "until_date", until: "2026-09-22" });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain("22 Sep 2026");
    expect(vi.mocked(ua.snoozeTask)).toHaveBeenCalledWith(expect.objectContaining({ via: "link" }), taskId, "until_date", "2026-09-22");

    const reply = await post(tokenFor("snooze", { expSec: Math.floor(h.clock.now().getTime() / 1000) + 3600 }), { mode: "until_reply" });
    expect(reply.statusCode).toBe(200);
    expect(vi.mocked(ua.snoozeTask)).toHaveBeenLastCalledWith(expect.anything(), taskId, "until_reply", null);
  });

  it("dismiss offers the reason and passes it on; other link actions map to user-actions", async () => {
    const page = await h.app.inject({ method: "GET", url: `/a/${tokenFor("dismiss")}` });
    expect(page.body).toContain('value="handled_by_other"');
    expect((await post(tokenFor("dismiss"), { kind: "handled_by_other" })).statusCode).toBe(200);
    expect(vi.mocked(ua.dismissTask)).toHaveBeenCalledWith(expect.anything(), taskId, "handled_by_other");
    expect((await post(tokenFor("dismiss", { expSec: Math.floor(h.clock.now().getTime() / 1000) + 99 }), { kind: "bogus" })).statusCode).toBe(400);
    expect((await post(tokenFor("reopen"))).statusCode).toBe(200);
    expect(vi.mocked(ua.reopenTask)).toHaveBeenCalledWith(expect.objectContaining({ via: "link" }), taskId);
    expect((await post(tokenFor("still_valid"))).statusCode).toBe(200);
    expect(vi.mocked(ua.markStillValid)).toHaveBeenCalledWith(expect.anything(), taskId);
  });

  it("friendly pages for expired, forged, foreign and unsupported links", async () => {
    const expired = tokenFor("complete", { expSec: Math.floor(h.clock.now().getTime() / 1000) - 1 });
    const forged = tokenFor("complete", { secret: "some-other-secret-some-other-secret-00" });
    const other = await addUser(h, { email: "x@contoso.example" });
    const foreign = tokenFor("complete", { user: other.id });
    const open = tokenFor("open");
    for (const t of [expired, forged, foreign, open, "short"]) {
      const res = await h.app.inject({ method: "GET", url: `/a/${t}` });
      expect(res.statusCode).toBe(410);
      expect(res.body).toContain("It has expired or has already been used");
      expect((await post(t)).statusCode).toBe(410);
    }
    expect(vi.mocked(ua.completeTask)).not.toHaveBeenCalled();
  });

  it("maps an engine conflict to a friendly 409 page and rejects a body token that doesn't match the URL", async () => {
    vi.mocked(ua.completeTask).mockRejectedValueOnce(new ua.ConflictError("closed"));
    const res = await post(tokenFor("complete"));
    expect(res.statusCode).toBe(409);
    expect(res.body).toContain("The action was not applied");

    const a = tokenFor("confirm");
    const b = tokenFor("confirm", { expSec: Math.floor(h.clock.now().getTime() / 1000) + 5 });
    const mismatch = await h.app.inject({
      method: "POST",
      url: `/a/${a}`,
      headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN },
      payload: new URLSearchParams({ token: b }).toString(),
    });
    expect(mismatch.statusCode).toBe(400);
    expect(vi.mocked(ua.confirmTask)).not.toHaveBeenCalled();
  });

  it("rate-limits one-click requests (30/min per IP)", async () => {
    const token = tokenFor("complete");
    for (let i = 0; i < 30; i++) expect((await h.app.inject({ method: "GET", url: `/a/${token}` })).statusCode).toBe(200);
    const limited = await h.app.inject({ method: "GET", url: `/a/${token}` });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["content-type"]).toContain("text/html");
    expect(limited.body).toContain("Too many requests");
    h.clock.advance(60_000);
    expect((await h.app.inject({ method: "GET", url: `/a/${token}` })).statusCode).toBe(200);
  });
});

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as s from "../../src/db/schema.js";
import type { IngestResult } from "../../src/domain/types.js";
import { sha256Hex } from "../../src/server/secrets.js";
import { api, makeHarness, sessionFor, type Harness } from "./helpers.js";

const MIME = Buffer.from(
  "From: Πελάτης <client@abc-gr.example>\r\nTo: owner@contoso.example\r\nSubject: =?UTF-8?B?zqDPgc6/z4PPhs6/z4HOrA==?=\r\nMessage-ID: <x1@abc-gr.example>\r\n\r\nΚαλημέρα\r\n",
  "utf8",
);
const RESULT: IngestResult = { messageId: "22222222-2222-4222-8222-222222222222", created: true, state: "pending", filterReason: null, direction: "INBOUND", threadId: null };

let h: Harness;
let token: string;

function upload(mailboxId: string, body: Buffer | string, headers: Record<string, string> = {}) {
  return h.app.inject({
    method: "POST",
    url: `/api/ingest/${mailboxId}`,
    headers: { "content-type": "message/rfc822", authorization: `Bearer ${token}`, ...headers },
    payload: body,
  });
}

beforeEach(async () => {
  h = await makeHarness();
  h.ingest.mockResolvedValue(RESULT);
  const res = await api(h, await sessionFor(h, h.seed.user.id), "POST", `/api/mailboxes/${h.seed.mailbox.id}/ingest-token`);
  expect(res.statusCode).toBe(200);
  token = (res.json() as { token: string }).token;
});

afterEach(async () => {
  await h.close();
});

describe("ingest API", () => {
  it("issues a token once and stores only its sha256", async () => {
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [m] = await h.t.db.select().from(s.mailboxes).where(eq(s.mailboxes.id, h.seed.mailbox.id));
    expect(m!.ingestTokenHash).toBe(sha256Hex(token));
    expect(JSON.stringify(m)).not.toContain(token);
    const audit = await h.t.db.select().from(s.securityAudit).where(eq(s.securityAudit.event, "mailbox.ingest_token_issue"));
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain(token);
  });

  it("passes the raw MIME to ingest and returns ids only", async () => {
    const res = await upload(h.seed.mailbox.id, MIME);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(RESULT);
    expect(h.ingest).toHaveBeenCalledTimes(1);
    const input = h.ingest.mock.calls[0]![0];
    expect(input).toMatchObject({ mailboxId: h.seed.mailbox.id, location: null, via: "ingest_api", declaredOutbound: false });
    expect(input.source.kind).toBe("mime");
    expect(input.source.kind === "mime" && input.source.raw.equals(MIME)).toBe(true);
    expect(res.headers["cache-control"]).toBe("no-store");
    // Access log carries the route pattern, never the URL or content.
    const logged = JSON.stringify(h.logs);
    expect(logged).toContain("/api/ingest/:mailboxId");
    expect(logged).not.toContain("Καλημέρα");
    expect(logged).not.toContain("client@abc-gr.example");
    expect(logged).not.toContain(token);
  });

  it("honours the Outlook agent and declared-outbound headers; accepts octet-stream", async () => {
    const res = await upload(h.seed.mailbox.id, MIME, { "content-type": "application/octet-stream", "x-mailme-declared-outbound": "1", "x-mailme-agent": "outlook" });
    expect(res.statusCode).toBe(200);
    expect(h.ingest.mock.calls[0]![0]).toMatchObject({ via: "outlook_agent", declaredOutbound: true });
  });

  it("answers 401 for missing/wrong tokens and unknown or other mailboxes, before reading the body", async () => {
    const [mb2] = await h.t.db.insert(s.mailboxes).values({ orgId: h.seed.org.id, userId: h.seed.user.id, address: "other@contoso.example" }).returning();
    const cases = [
      h.app.inject({ method: "POST", url: `/api/ingest/${h.seed.mailbox.id}`, headers: { "content-type": "message/rfc822" }, payload: MIME }),
      upload(h.seed.mailbox.id, MIME, { authorization: `Bearer ${token.slice(0, -2)}xx` }),
      upload(h.seed.mailbox.id, MIME, { authorization: `Basic ${token}` }),
      upload(mb2!.id, MIME),
      upload("00000000-0000-4000-8000-000000000000", MIME),
      upload("not-a-uuid", MIME),
    ];
    for (const res of await Promise.all(cases)) {
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "Invalid token", code: "unauthorized" });
      expect(res.headers["www-authenticate"]).toContain("Bearer");
    }
    expect(h.ingest).not.toHaveBeenCalled();
    const fails = await h.t.db.select().from(s.securityAudit).where(eq(s.securityAudit.event, "ingest.auth_fail"));
    expect(fails).toHaveLength(6);
  });

  it("re-issuing the token revokes the old one", async () => {
    const old = token;
    const res = await api(h, await sessionFor(h, h.seed.user.id), "POST", `/api/mailboxes/${h.seed.mailbox.id}/ingest-token`);
    token = (res.json() as { token: string }).token;
    expect(token).not.toBe(old);
    expect((await upload(h.seed.mailbox.id, MIME, { authorization: `Bearer ${old}` })).statusCode).toBe(401);
    expect((await upload(h.seed.mailbox.id, MIME)).statusCode).toBe(200);
  });

  it("rejects wrong content types, empty bodies and bodies over 10 MB", async () => {
    const json = await h.app.inject({
      method: "POST",
      url: `/api/ingest/${h.seed.mailbox.id}`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { raw: "x" },
    });
    expect(json.statusCode).toBe(415);
    expect((await upload(h.seed.mailbox.id, "hello", { "content-type": "text/plain" })).statusCode).toBe(415);
    expect((await upload(h.seed.mailbox.id, Buffer.alloc(0))).statusCode).toBe(400);
    const big = await upload(h.seed.mailbox.id, Buffer.alloc(10 * 1024 * 1024 + 1, 0x61));
    expect(big.statusCode).toBe(413);
    expect(big.headers["content-security-policy"]).toBeDefined();
    expect((await upload(h.seed.mailbox.id, Buffer.alloc(10 * 1024 * 1024 - 10, 0x61))).statusCode).toBe(200);
    expect(h.ingest).toHaveBeenCalledTimes(1);
  });

  it("refuses disabled mailboxes and rate-limits uploads (120/min)", async () => {
    for (let i = 0; i < 120; i++) expect((await upload(h.seed.mailbox.id, MIME)).statusCode).toBe(200);
    expect((await upload(h.seed.mailbox.id, MIME)).statusCode).toBe(429);
    h.clock.advance(60_000);
    await h.t.db.update(s.mailboxes).set({ status: "disabled" }).where(eq(s.mailboxes.id, h.seed.mailbox.id));
    expect((await upload(h.seed.mailbox.id, MIME)).statusCode).toBe(403);
  });

  it("maps an ingest failure to 500 without leaking details", async () => {
    h.ingest.mockRejectedValueOnce(new Error("duplicate key value violates unique constraint (client@abc-gr.example)"));
    const res = await upload(h.seed.mailbox.id, MIME);
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("client@abc-gr.example");
    expect(JSON.stringify(h.logs)).not.toContain("client@abc-gr.example");
    expect(h.logs.some((l) => l.level === "error")).toBe(true);
  });
});

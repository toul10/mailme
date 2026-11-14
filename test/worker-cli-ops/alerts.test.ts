import { describe, expect, it, vi } from "vitest";
import { buildAlertRequest, encodeHeaderValue, isNtfyUrl, sendAlert, type FetchFn } from "../../src/ops/alerts.js";
import { createHealthPinger } from "../../src/ops/ping.js";

const alert = { title: "MailMe: mailbox auth_failed (1a2b3c4d)", body: "Mailbox id 1a2b3c4d-0000. Re-enter the password.", severity: "critical" as const };

function okFetch() {
  return vi.fn<FetchFn>(async () => new Response(null, { status: 200 }));
}

describe("alerts", () => {
  it("detects ntfy URLs by host", () => {
    expect(isNtfyUrl("https://ntfy.sh/mailme-ops")).toBe(true);
    expect(isNtfyUrl("https://ntfy.example.com/topic")).toBe(true);
    expect(isNtfyUrl("https://hooks.example.com/ntfy")).toBe(false);
    expect(isNtfyUrl("not a url")).toBe(false);
  });

  it("formats ntfy as plain text with Title/Priority/Tags headers", () => {
    const req = buildAlertRequest("https://ntfy.sh/mailme-ops", alert);
    expect(req.url).toBe("https://ntfy.sh/mailme-ops");
    expect(req.headers["Title"]).toBe(alert.title);
    expect(req.headers["Priority"]).toBe("5");
    expect(req.headers["Tags"]).toBe("rotating_light");
    expect(req.headers["Content-Type"]).toMatch(/^text\/plain/);
    expect(req.body).toBe(alert.body);
    expect(buildAlertRequest("https://ntfy.sh/t", { ...alert, severity: "info" }).headers["Priority"]).toBe("3");
  });

  it("formats a generic webhook as JSON", () => {
    const now = new Date("2026-09-24T08:00:00Z");
    const req = buildAlertRequest("https://hooks.example.com/x", { ...alert, severity: "warning" }, now);
    expect(req.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(req.body)).toEqual({ source: "mailme", severity: "warning", title: alert.title, body: alert.body, at: now.toISOString() });
  });

  it("encodes non-ASCII titles (fetch rejects them) and moves URL credentials to a header", () => {
    expect(encodeHeaderValue("plain ascii")).toBe("plain ascii");
    const enc = encodeHeaderValue("Αναφορά");
    expect(enc).toMatch(/^=\?UTF-8\?B\?/);
    expect(Buffer.from(enc.slice(10, -2), "base64").toString("utf8")).toBe("Αναφορά");
    const req = buildAlertRequest("https://ops:s3cr%40t@ntfy.example.com/topic", alert);
    expect(req.url).toBe("https://ntfy.example.com/topic");
    expect(req.headers["Authorization"]).toBe(`Basic ${Buffer.from("ops:s3cr@t").toString("base64")}`);
  });

  it("sends via fetch and never throws on failure", async () => {
    const f = okFetch();
    expect(await sendAlert({ ALERT_WEBHOOK_URL: "https://ntfy.sh/t" }, alert, { fetch: f })).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("https://ntfy.sh/t");
    expect(init?.method).toBe("POST");

    const failing = vi.fn<FetchFn>(async () => {
      throw Object.assign(new Error("connect ECONNREFUSED https://secret-token@host"), { code: "ECONNREFUSED" });
    });
    expect(await sendAlert({ ALERT_WEBHOOK_URL: "https://ntfy.sh/t" }, alert, { fetch: failing })).toBe(false);
    const rejected = vi.fn<FetchFn>(async () => new Response("no", { status: 500 }));
    expect(await sendAlert({ ALERT_WEBHOOK_URL: "https://x.test/h" }, alert, { fetch: rejected })).toBe(false);
  });

  it("without a configured URL logs the alert and counts it delivered", async () => {
    const warn = vi.fn();
    const log = { info() {}, warn, error() {}, debug() {}, child() { return log; } };
    expect(await sendAlert({ ALERT_WEBHOOK_URL: undefined }, alert, { log })).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("healthcheck ping", () => {
  it("pings with GET, throttles cycle pings, never throws", async () => {
    let now = 0;
    const f = okFetch();
    const p = createHealthPinger("https://hc-ping.test/uuid", { fetch: f, clock: { now: () => new Date(now) }, minIntervalMs: 30_000 });
    expect(await p.ping("cycle")).toBe(true);
    now = 10_000;
    expect(await p.ping("cycle")).toBe(false);
    expect(await p.ping("digest")).toBe(true);
    now = 100_000;
    expect(await p.ping("cycle")).toBe(true);
    expect(f).toHaveBeenCalledTimes(3);
    expect(f.mock.calls[0]![1]?.method).toBe("GET");

    const bad = createHealthPinger("https://hc-ping.test/uuid", { fetch: vi.fn<FetchFn>(async () => { throw new Error("down"); }) });
    expect(await bad.ping("digest")).toBe(false);
    expect(await createHealthPinger(undefined).ping("digest")).toBe(false);
  });
});

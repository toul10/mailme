import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as s from "../../src/db/schema.js";
import { createLinkFactory, redeemActionToken, tokenNonce } from "../../src/digest/links.js";
import { signActionToken, verifyActionToken } from "../../src/lib/crypto.js";
import { addTask, AT_0730, BASE_URL, LINK_SECRET, setup, type Fixture } from "./helpers.js";

let f: Fixture;
let taskId: string;
beforeEach(async () => {
  f = await setup();
  taskId = (await addTask(f)).id;
});
afterEach(() => f.t.close());

const tokenOf = (url: string) => url.slice(`${BASE_URL}/a/`.length);
const plusDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

describe("createLinkFactory", () => {
  it("issues signed /a/<token> links backed by a stored nonce (7-day expiry)", async () => {
    const links = createLinkFactory({ db: f.db, baseUrl: `${BASE_URL}/`, linkSecret: LINK_SECRET, now: AT_0730 }, f.userId, null);
    const url = await links.action(taskId, "complete");
    expect(url.startsWith(`${BASE_URL}/a/`)).toBe(true);
    const token = tokenOf(url);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const payload = verifyActionToken(token, LINK_SECRET, Math.floor(AT_0730.getTime() / 1000));
    expect(payload).toMatchObject({ t: taskId, a: "complete", u: f.userId });
    const [row] = await f.db.select().from(s.actionNonces).where(eq(s.actionNonces.nonce, tokenNonce(token)));
    expect(row).toMatchObject({ userId: f.userId, taskId, action: "complete", usedAt: null });
    expect(row!.expiresAt.getTime()).toBe(AT_0730.getTime() + 7 * 86_400_000);
  });

  it("returns the same link for repeated calls and different links per action", async () => {
    const links = createLinkFactory({ db: f.db, baseUrl: BASE_URL, linkSecret: LINK_SECRET, now: AT_0730 }, f.userId, null);
    const a1 = await links.action(taskId, "confirm");
    const a2 = await links.action(taskId, "confirm");
    const b = await links.action(taskId, "dismiss");
    expect(a1).toBe(a2);
    expect(b).not.toBe(a1);
    expect(await f.db.select().from(s.actionNonces)).toHaveLength(2);
  });

  it("never issues links longer than 7 days", async () => {
    const links = createLinkFactory({ db: f.db, baseUrl: BASE_URL, linkSecret: LINK_SECRET, now: AT_0730, ttlDays: 30 }, f.userId, null);
    const token = tokenOf(await links.action(taskId, "reopen"));
    const [row] = await f.db.select().from(s.actionNonces).where(eq(s.actionNonces.nonce, tokenNonce(token)));
    expect(row!.expiresAt.getTime()).toBe(AT_0730.getTime() + 7 * 86_400_000);
  });

  it("builds task and list links under the base URL", () => {
    const links = createLinkFactory({ db: f.db, baseUrl: BASE_URL, linkSecret: LINK_SECRET, now: AT_0730 }, f.userId, null);
    expect(links.task(taskId)).toBe(`${BASE_URL}/#/tasks/${taskId}`);
    expect(links.list("waiting")).toBe(`${BASE_URL}/#/?tab=waiting`);
  });
});

describe("redeemActionToken", () => {
  async function issue(action: "complete" | "still_valid" = "complete") {
    const links = createLinkFactory({ db: f.db, baseUrl: BASE_URL, linkSecret: LINK_SECRET, now: AT_0730 }, f.userId, null);
    return tokenOf(await links.action(taskId, action));
  }

  it("peeks without consuming, then consumes exactly once", async () => {
    const token = await issue();
    const later = plusDays(AT_0730, 1);
    const peek = await redeemActionToken(f.db, LINK_SECRET, token, later, false);
    expect(peek).toEqual({ userId: f.userId, taskId, action: "complete", nonce: tokenNonce(token) });
    expect(await redeemActionToken(f.db, LINK_SECRET, token, later, false)).not.toBeNull();
    expect(await redeemActionToken(f.db, LINK_SECRET, token, later, true)).not.toBeNull();
    expect(await redeemActionToken(f.db, LINK_SECRET, token, later, true)).toBeNull();
    expect(await redeemActionToken(f.db, LINK_SECRET, token, later, false)).toBeNull();
    const [row] = await f.db.select().from(s.actionNonces).where(eq(s.actionNonces.nonce, tokenNonce(token)));
    expect(row!.usedAt?.getTime()).toBe(later.getTime());
  });

  it("supports actions outside the token payload union (still_valid)", async () => {
    const token = await issue("still_valid");
    expect((await redeemActionToken(f.db, LINK_SECRET, token, AT_0730, true))?.action).toBe("still_valid");
  });

  it("rejects expired links", async () => {
    const token = await issue();
    expect(await redeemActionToken(f.db, LINK_SECRET, token, plusDays(AT_0730, 7.001), true)).toBeNull();
    expect(await redeemActionToken(f.db, LINK_SECRET, token, plusDays(AT_0730, 6.9), true)).not.toBeNull();
  });

  it("rejects a forged or tampered token and a wrong secret", async () => {
    const token = await issue();
    const [body, sig] = token.split(".");
    const forgedBody = Buffer.from(JSON.stringify({ t: taskId, a: "dismiss", u: f.userId, exp: 4_000_000_000 })).toString("base64url");
    expect(await redeemActionToken(f.db, LINK_SECRET, `${forgedBody}.${sig}`, AT_0730, true)).toBeNull();
    expect(await redeemActionToken(f.db, LINK_SECRET, `${body}.${sig}x`, AT_0730, true)).toBeNull();
    expect(await redeemActionToken(f.db, "another-secret-another-secret-another-1", token, AT_0730, true)).toBeNull();
    expect(await redeemActionToken(f.db, LINK_SECRET, "", AT_0730, true)).toBeNull();
    expect(await redeemActionToken(f.db, LINK_SECRET, "x".repeat(5000), AT_0730, true)).toBeNull();
  });

  it("rejects a validly signed token that has no nonce row (not issued by a digest)", async () => {
    const token = signActionToken({ t: taskId, a: "complete", u: f.userId, exp: Math.floor(AT_0730.getTime() / 1000) + 3600 }, LINK_SECRET);
    expect(await redeemActionToken(f.db, LINK_SECRET, token, AT_0730, true)).toBeNull();
  });

  it("rejects a nonce row that does not match the token (user/task/action)", async () => {
    const token = await issue();
    await f.db.update(s.actionNonces).set({ action: "dismiss" }).where(eq(s.actionNonces.nonce, tokenNonce(token)));
    expect(await redeemActionToken(f.db, LINK_SECRET, token, AT_0730, true)).toBeNull();
  });

  it("rejects when the stored nonce expired earlier than the token", async () => {
    const token = await issue();
    await f.db.update(s.actionNonces).set({ expiresAt: AT_0730 }).where(eq(s.actionNonces.nonce, tokenNonce(token)));
    expect(await redeemActionToken(f.db, LINK_SECRET, token, plusDays(AT_0730, 1), true)).toBeNull();
  });

  it("rejects signed payloads with non-uuid ids or unknown actions", async () => {
    const exp = Math.floor(AT_0730.getTime() / 1000) + 3600;
    const bad1 = signActionToken({ t: "not-a-uuid", a: "complete", u: f.userId, exp }, LINK_SECRET);
    const bad2 = signActionToken({ t: taskId, a: "delete_everything" as "complete", u: f.userId, exp }, LINK_SECRET);
    expect(await redeemActionToken(f.db, LINK_SECRET, bad1, AT_0730, true)).toBeNull();
    expect(await redeemActionToken(f.db, LINK_SECRET, bad2, AT_0730, true)).toBeNull();
  });
});

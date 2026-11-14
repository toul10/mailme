import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * AES-256-GCM envelope for secrets at rest (mailbox passwords).
 * Format: "v1.<iv b64url>.<tag b64url>.<ciphertext b64url>"
 */
export function encryptSecret(plaintext: string, masterKeyB64: string): string {
  const key = decodeKey(masterKeyB64);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", b64u(iv), b64u(tag), b64u(ct)].join(".");
}

export function decryptSecret(envelope: string, masterKeyB64: string): string {
  const [version, ivS, tagS, ctS] = envelope.split(".");
  if (version !== "v1" || !ivS || !tagS || ctS === undefined) throw new Error("Unsupported secret envelope");
  const decipher = createDecipheriv("aes-256-gcm", decodeKey(masterKeyB64), fromB64u(ivS));
  decipher.setAuthTag(fromB64u(tagS));
  return Buffer.concat([decipher.update(fromB64u(ctS)), decipher.final()]).toString("utf8");
}

function decodeKey(masterKeyB64: string): Buffer {
  const key = Buffer.from(masterKeyB64, "base64");
  if (key.length !== 32) throw new Error("MASTER_KEY must decode to exactly 32 bytes");
  return key;
}

/**
 * Signed, expiring action tokens for one-click links in the daily report.
 * Payload is visible (not secret) but tamper-proof.
 */
export interface ActionTokenPayload {
  /** task id */
  t: string;
  /** action */
  a: "complete" | "dismiss" | "snooze" | "confirm" | "reopen" | "still_valid";
  /** user id the link was issued to */
  u: string;
  /** expiry, unix seconds */
  exp: number;
}

export function signActionToken(payload: ActionTokenPayload, secret: string): string {
  const body = b64u(Buffer.from(JSON.stringify(payload), "utf8"));
  return `${body}.${b64u(hmac(body, secret))}`;
}

export function verifyActionToken(token: string, secret: string, nowSec: number): ActionTokenPayload | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = hmac(body, secret);
  const given = fromB64u(sig);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(fromB64u(body).toString("utf8")) as ActionTokenPayload;
    if (typeof payload.exp !== "number" || payload.exp < nowSec) return null;
    return payload;
  } catch {
    return null;
  }
}

export function randomToken(bytes = 32): string {
  return b64u(randomBytes(bytes));
}

function hmac(data: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(data).digest();
}

function b64u(buf: Buffer): string {
  return buf.toString("base64url");
}

function fromB64u(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Constant-time string comparison (false on length mismatch). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Key for one-click action links: LINK_SECRET when set, else derived from APP_SECRET.
 * The single implementation used by the server (verify) and the worker/CLI (sign).
 */
export function deriveLinkSecret(config: { LINK_SECRET?: string | undefined; APP_SECRET: string }): string {
  if (config.LINK_SECRET) return config.LINK_SECRET;
  return createHmac("sha256", config.APP_SECRET).update("mailme/link-secret/v1").digest("base64url");
}

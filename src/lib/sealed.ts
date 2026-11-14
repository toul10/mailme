import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * Sealed box for mailbox credentials.
 * The API seals with the worker's X25519 public key; only the worker, holding the private key file,
 * can open. Envelope: "sb1.<kid>.<ephemeral pub b64u>.<iv b64u>.<tag b64u>.<ct b64u>".
 * AAD binds the ciphertext to one mailbox so it can't be moved between rows.
 */

const INFO = Buffer.from("mailme/sealed-credentials/v1");

export interface SealingKeys {
  kid: string;
  publicKey: KeyObject;
  privateKey: KeyObject | null;
}

export function generateSealingKeyPair(): { publicPem: string; privatePem: string } {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return {
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

export function loadSealingKeys(opts: { kid: string; publicKeyFile: string; privateKeyFile?: string | null }): SealingKeys {
  const publicKey = createPublicKey(readFileSync(opts.publicKeyFile));
  const privateKey = opts.privateKeyFile ? createPrivateKey(readFileSync(opts.privateKeyFile)) : null;
  return { kid: opts.kid, publicKey, privateKey };
}

export function sealAad(mailboxId: string, address: string): string {
  return `${mailboxId}|${address.toLowerCase()}`;
}

export function seal(plaintext: string, keys: Pick<SealingKeys, "kid" | "publicKey">, aad: string): string {
  const eph = generateKeyPairSync("x25519");
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: keys.publicKey });
  const ephRaw = eph.publicKey.export({ type: "spki", format: "der" });
  const key = Buffer.from(hkdfSync("sha256", shared, ephRaw, INFO, 32));
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["sb1", keys.kid, ephRaw.toString("base64url"), iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(".");
}

export function open(envelope: string, keys: SealingKeys, aad: string): string {
  if (!keys.privateKey) throw new Error("This process has no private sealing key (only the worker may open credentials)");
  const parts = envelope.split(".");
  if (parts.length !== 6 || parts[0] !== "sb1") throw new Error("Unsupported sealed envelope");
  const [, kid, ephS, ivS, tagS, ctS] = parts as [string, string, string, string, string, string];
  if (kid !== keys.kid) throw new Error(`Sealed with key ${kid}, but loaded key is ${keys.kid}`);
  const ephRaw = Buffer.from(ephS, "base64url");
  const ephPub = createPublicKey({ key: ephRaw, format: "der", type: "spki" });
  const shared = diffieHellman({ privateKey: keys.privateKey, publicKey: ephPub });
  const key = Buffer.from(hkdfSync("sha256", shared, ephRaw, INFO, 32));
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivS, "base64url"));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(tagS, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ctS, "base64url")), decipher.final()]).toString("utf8");
}

/** Test helper: in-memory key pair. */
export function ephemeralSealingKeys(kid = "test"): SealingKeys {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return { kid, publicKey, privateKey };
}

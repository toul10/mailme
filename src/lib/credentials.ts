import type { SealingKeys } from "./sealed.js";
import { open, seal, sealAad } from "./sealed.js";

/** Mailbox password sealing helpers. */
export function sealMailboxPassword(mailbox: { id: string; address: string }, password: string, keys: Pick<SealingKeys, "kid" | "publicKey">) {
  return { credentialsSealed: seal(password, keys, sealAad(mailbox.id, mailbox.address)), credentialsKid: keys.kid };
}

export function openMailboxPassword(mailbox: { id: string; address: string; credentialsSealed: string | null }, keys: SealingKeys): string {
  if (!mailbox.credentialsSealed) throw new Error("Mailbox has no stored credentials");
  return open(mailbox.credentialsSealed, keys, sealAad(mailbox.id, mailbox.address));
}

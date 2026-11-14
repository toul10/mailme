import type { Address, Direction, FolderRole } from "../domain/types.js";

export interface DirectionInput {
  from: Address | null;
  /** Owner primary address + aliases, lower-cased. */
  ownerAddresses: string[];
  /** This copy carries server delivery trace headers (Delivered-To / X-Original-To / Return-Path). */
  hasDeliveryTrace: boolean;
  /** Role of the folder this copy was found in (null for ingest API / .eml). */
  folderRole: FolderRole | null;
  /** Roles of folders where other copies of the same message were already seen. */
  otherCopyRoles: FolderRole[];
  /** Ingest source explicitly marked as the owner's sent mail (e.g. Outlook agent "sent" upload). */
  declaredOutbound?: boolean;
}

/**
 * OUTBOUND only if From ∈ owner addresses AND (client-saved copy OR sent-role folder OR declaredOutbound).
 * A From=owner copy that was delivered by the server (and never seen in Sent) stays INBOUND with
 * `claimsOwnerSender` (DMARC p=none: a forged "From: you" is delivered). Never decided by folder or From alone.
 */
export function decideDirection(input: DirectionInput): { direction: Direction; claimsOwnerSender: boolean } {
  const from = input.from?.address?.trim().toLowerCase() ?? "";
  const owners = new Set(input.ownerAddresses.map((a) => a.trim().toLowerCase()).filter(Boolean));
  if (!from || !owners.has(from)) return { direction: "INBOUND", claimsOwnerSender: false };

  const inSent = input.folderRole === "sent" || input.otherCopyRoles.includes("sent");
  if (inSent || !input.hasDeliveryTrace || input.declaredOutbound === true) {
    return { direction: "OUTBOUND", claimsOwnerSender: false };
  }
  return { direction: "INBOUND", claimsOwnerSender: true };
}

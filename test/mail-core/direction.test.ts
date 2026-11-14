import { describe, expect, it } from "vitest";
import { decideDirection, type DirectionInput } from "../../src/mail/direction.js";

const owner = { address: "owner@contoso.example", name: "Owner" };
const base: DirectionInput = { from: owner, ownerAddresses: ["owner@contoso.example", "sales@contoso.example"], hasDeliveryTrace: false, folderRole: null, otherCopyRoles: [] };

describe("decideDirection", () => {
  it.each<[string, Partial<DirectionInput>, { direction: string; claimsOwnerSender: boolean }]>([
    ["someone else → INBOUND", { from: { address: "client@alfa.example", name: null }, hasDeliveryTrace: true, folderRole: "inbox" }, { direction: "INBOUND", claimsOwnerSender: false }],
    ["someone else even in Sent → INBOUND", { from: { address: "client@alfa.example", name: null }, folderRole: "sent" }, { direction: "INBOUND", claimsOwnerSender: false }],
    ["owner, client-saved copy (no trace) → OUTBOUND", { folderRole: "sent" }, { direction: "OUTBOUND", claimsOwnerSender: false }],
    ["owner, no trace, no folder (.eml) → OUTBOUND", {}, { direction: "OUTBOUND", claimsOwnerSender: false }],
    ["owner alias, no trace → OUTBOUND", { from: { address: "Sales@Contoso.example", name: null } }, { direction: "OUTBOUND", claimsOwnerSender: false }],
    ["owner, delivered copy in INBOX only → INBOUND + claims", { hasDeliveryTrace: true, folderRole: "inbox" }, { direction: "INBOUND", claimsOwnerSender: true }],
    ["owner, delivered copy but in a Sent-role folder → OUTBOUND", { hasDeliveryTrace: true, folderRole: "sent" }, { direction: "OUTBOUND", claimsOwnerSender: false }],
    ["self-sent: INBOX copy with a Sent copy already seen → OUTBOUND", { hasDeliveryTrace: true, folderRole: "inbox", otherCopyRoles: ["sent"] }, { direction: "OUTBOUND", claimsOwnerSender: false }],
    ["owner, delivered, declared outbound (agent) → OUTBOUND", { hasDeliveryTrace: true, declaredOutbound: true }, { direction: "OUTBOUND", claimsOwnerSender: false }],
    ["declared outbound never overrides From ≠ owner", { from: { address: "x@evil.example", name: null }, declaredOutbound: true }, { direction: "INBOUND", claimsOwnerSender: false }],
    ["no From → INBOUND", { from: null }, { direction: "INBOUND", claimsOwnerSender: false }],
  ])("%s", (_name, over, expected) => {
    expect(decideDirection({ ...base, ...over })).toEqual(expected);
  });
});

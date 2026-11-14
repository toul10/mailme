import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseMime } from "../../src/mail/parse.js";
import type { Address, ParsedMail } from "../../src/domain/types.js";

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/mail-core");

export function fixture(name: string): Buffer {
  return readFileSync(join(FIXTURES, name));
}

export function parseFixture(name: string): Promise<ParsedMail> {
  return parseMime(fixture(name));
}

/** A minimal ParsedMail for rule tests. */
export function parsedMail(over: Partial<ParsedMail> = {}): ParsedMail {
  const from: Address = { address: "client@alfa-ilektroniki.example", name: "Client" };
  return {
    messageIdHeader: "m-1@alfa-ilektroniki.example",
    from,
    sender: null,
    to: [{ address: "owner@contoso.example", name: null }],
    cc: [],
    bcc: [],
    replyTo: [],
    subject: "Προσφορά ηχείων",
    dateHeader: new Date("2026-09-09T07:00:00Z"),
    inReplyTo: null,
    references: [],
    threadIndex: null,
    headers: {},
    textPlain: "Καλημέρα, στείλτε μου προσφορά.",
    textHtml: null,
    attachments: [],
    calendar: null,
    bounce: null,
    decodeWarnings: [],
    hasDeliveryTrace: true,
    sizeBytes: 100,
    ...over,
  };
}

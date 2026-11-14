import MailComposer from "nodemailer/lib/mail-composer";

/** Headers every report carries so no auto-responder or our own ingest treats it as mail to act on. */
export const DIGEST_HEADERS = {
  "Auto-Submitted": "auto-generated",
  "X-Auto-Response-Suppress": "All",
  "X-MailMe-Kind": "digest",
} as const;

/** RFC 5322 message for APPEND/SMTP with loop-prevention headers. */
export async function composeDigestMime(opts: { from: string; to: string; subject: string; html: string; text: string; messageId: string; date: Date }): Promise<Buffer> {
  const bare = opts.messageId.trim().replace(/^<+|>+$/g, "");
  const composer = new MailComposer({
    from: opts.from,
    to: opts.to,
    subject: opts.subject,
    text: opts.text,
    html: opts.html,
    date: opts.date,
    messageId: `<${bare}>`,
    headers: { ...DIGEST_HEADERS },
    textEncoding: "quoted-printable",
    disableUrlAccess: true,
    disableFileAccess: true,
  });
  return composer.compile().build();
}

/** Deterministic Message-ID: digest.{userId}.{YYYY-MM-DD}@{platformDomain} (no angle brackets). */
export function digestMessageId(userId: string, localDate: string, platformDomain: string): string {
  const domain = platformDomain.trim().toLowerCase().replace(/^@+/, "") || "mailme.local";
  return `digest.${userId}.${localDate}@${domain}`;
}

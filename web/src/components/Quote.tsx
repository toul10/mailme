/**
 * The sentence a task came from, in the sender's words: a highlighter mark
 * behind a humanist italic, attributed and dated. Plain text only.
 */
import type { EvidenceView } from "../../../src/server/api-types.js";
import { attribution } from "../present.js";

const SOURCE_NOTE: Record<string, string> = {
  QUOTED: "from an earlier, quoted message",
  FORWARDED: "from a forwarded message",
  SUBJECT: "from the subject",
  ATTACHMENT_NAME: "from an attachment name",
  CALENDAR: "from a calendar invitation",
};

export function Quote({ evidence, zone, today, size = "normal" }: { evidence: EvidenceView; zone: string; today: string; size?: "normal" | "large" }) {
  const by = attribution(evidence, zone, today);
  const note = evidence.source ? SOURCE_NOTE[evidence.source] : undefined;
  return (
    <figure className={size === "large" ? "quote quote-large" : "quote"}>
      <blockquote>
        <p>
          <mark>{evidence.quote}</mark>
        </p>
      </blockquote>
      {by || note ? (
        <figcaption>
          {by}
          {note ? <span className="quote-note">{by ? ", " : ""}{note}</span> : null}
        </figcaption>
      ) : null}
    </figure>
  );
}

/**
 * The per-mailbox view's switch (mailbox-view.ts): all of the user's mailboxes together, or one of them. A row of
 * keys above the screens the view changes, shown only to a user with two or more mailboxes. Plain radio buttons: Tab
 * reaches the group, the arrow keys move the choice. The keys wrap, so no choice is ever out of sight; on a phone a
 * name is cut to what tells the mailboxes apart (mailboxShortNames).
 */
import { Inbox } from "lucide-react";
import { useApp } from "../hooks.js";
import { hasViews, mailboxNames, mailboxShortNames, viewOf } from "../mailbox-view.js";

/** `align`: where the screen below starts its text — at the edge (“Today”) or in the centred column (the pages). */
export function MailboxSwitch({ align }: { align: "edge" | "column" }) {
  const { mailboxes, viewId, setView } = useApp();
  if (!hasViews(mailboxes)) return null;
  const names = mailboxNames(mailboxes);
  const shorts = mailboxShortNames(mailboxes);
  const current = viewOf(mailboxes, viewId)?.id ?? null;

  const option = (id: string | null, label: string, short = label, title?: string) => (
    <label key={id ?? "all"} className={current === id ? "box-opt is-on" : "box-opt"} title={title}>
      {/* Named in full for a screen reader, whatever part of the name is shown. */}
      <input type="radio" name="mailbox-view" aria-label={label} checked={current === id} onChange={() => setView(id)} />
      <span className="box-led" aria-hidden="true" />
      <span className="box-opt-label">
        {short !== label && label.startsWith(short) ? (
          <>
            {short}
            <span className="box-opt-rest">{label.slice(short.length)}</span>
          </>
        ) : (
          label
        )}
      </span>
    </label>
  );

  return (
    <div className={`box-switch box-switch-${align}`} role="radiogroup" aria-label="Mailbox">
      <span className="box-switch-title" aria-hidden="true">
        <Inbox size={15} />
        <span>Mailbox</span>
      </span>
      <div className="box-opts">
        {option(null, "All mailboxes")}
        {mailboxes.map((m) => option(m.id, names.get(m.id) ?? m.address, shorts.get(m.id), m.address))}
      </div>
    </div>
  );
}

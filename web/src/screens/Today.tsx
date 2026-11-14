/**
 * “Today” — the home screen. Answers the product's three questions (What do I need to do? What did I promise?
 * What am I waiting for?) and, first, whatever the AI needs the user to confirm. Every number on the screen is the
 * length of the section it names.
 */
import { ChevronLeft, ChevronRight, Clock, History, Users } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { TaskListItem, TodayResponse } from "../../../src/server/api-types.js";
import { errorMessage, isApiError } from "../api.js";
import { api } from "../client.js";
import { TaskRow, type RowChange } from "../components/TaskRow.js";
import { TriageCard, isStaleSuggestion } from "../components/TriageCard.js";
import { restoreFocus, type FocusPlan } from "../focus.js";
import { useApp, useDocumentTitle } from "../hooks.js";
import { daySentence, greetingLine, longDate } from "../present.js";
import { routeHref } from "../router.js";
import { WeekMeter } from "../ui/WeekMeter.js";
import { setLastListHref } from "./TaskList.js";

const listHref = (tab: "snoozed" | "others" | "earlier") => routeHref({ name: "list", tab, q: "", company: null, review: false });

export function Today() {
  const { me, zone, today } = useApp();
  const [data, setData] = useState<TodayResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);
  const [askIndex, setAskIndex] = useState(0);
  const seq = useRef(0);
  const focusPlan = useRef<FocusPlan | null>(null);
  useDocumentTitle("Today");
  useEffect(() => setLastListHref("#/"), []);

  // Every answer and quick action reloads; only the latest request may land (an older one would bring back rows
  // that were just closed, with stale versions).
  const load = useCallback(async () => {
    const n = ++seq.current;
    setReloading(true);
    try {
      const d = await api.today();
      if (n !== seq.current) return;
      setData(d);
      setError(null);
    } catch (err) {
      if (n !== seq.current) return;
      if (!(isApiError(err) && err.handled)) setError(errorMessage(err));
    } finally {
      if (n === seq.current) setReloading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, today]);

  // After the reload that removed a row or card: focus its neighbour instead of leaving it on <body>.
  useEffect(() => {
    if (!focusPlan.current) return;
    restoreFocus({ targets: [...focusPlan.current.targets, "#today-h"] });
    focusPlan.current = null;
  }, [data]);

  const onRowChanged = useCallback(
    (change: RowChange) => {
      if (change.focus) focusPlan.current = change.focus;
      void load();
    },
    [load],
  );
  const onAnswered = useCallback(
    (focus: FocusPlan | null) => {
      if (focus) focusPlan.current = focus;
      void load();
    },
    [load],
  );

  if (error && !data) {
    return (
      <div className="today">
        <div className="error-box" role="alert">
          <p>{error}</p>
          <button type="button" className="btn" onClick={() => void load()}>
            Try again
          </button>
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="today">
        <p className="muted loading">Loading…</p>
      </div>
    );
  }

  const c = data.counts;
  const triage = data.triage.filter((t) => !(t.suggestion && isStaleSuggestion(t.suggestion.id)));
  const triageCount = Math.max(triage.length, c.triage - (data.triage.length - triage.length));
  // One question at a time in the bridge; answering one reloads and the next takes its place.
  const at = Math.min(askIndex, Math.max(0, triage.length - 1));
  const current = triage[at] ?? null;
  // Snoozed and “Earlier” tasks are not in the sections: an empty section then means “nothing due today”.
  const hidden = c.snoozed + c.earlier > 0;
  const rowProps = { zone, today, onChanged: onRowChanged };

  return (
    <div className="today">
      <header className="bridge today-bridge">
        <div className="today-intro">
          <p className="today-date">{longDate(today)}</p>
          <h1 id="today-h" className="today-greeting" tabIndex={-1}>
            {greetingLine(me.name, new Date().toISOString(), zone)}
          </h1>
          <p className="today-sentence">{daySentence({ doNow: data.doNow.length, promised: data.promised.length, waiting: data.waiting.length, triage: triageCount })}</p>
          <WeekMeter items={[...data.doNow, ...data.promised, ...data.waiting]} today={today} />
        </div>

        {current ? (
          <section className="asks" aria-labelledby="asks-h" data-focus-fallback="asks-h">
            <div className="asks-head">
              <h2 id="asks-h" className="asks-title" tabIndex={-1}>
                <span className="led led-ai" aria-hidden="true" />
                The AI asks {triageCount > 1 ? <span className="count">{triageCount}</span> : null}
              </h2>
              {triage.length > 1 ? (
                <div className="asks-pager" role="group" aria-label="The AI's questions">
                  <button type="button" className="btn btn-icon" aria-label="Previous question" aria-disabled={at === 0 || undefined} onClick={() => at > 0 && setAskIndex(at - 1)}>
                    <ChevronLeft size={16} aria-hidden="true" />
                  </button>
                  <span className="asks-pos">
                    {at + 1} of {triage.length}
                  </span>
                  <button
                    type="button"
                    className="btn btn-icon"
                    aria-label="Next question"
                    aria-disabled={at === triage.length - 1 || undefined}
                    onClick={() => at < triage.length - 1 && setAskIndex(at + 1)}
                  >
                    <ChevronRight size={16} aria-hidden="true" />
                  </button>
                </div>
              ) : null}
            </div>
            <TriageCard
              key={`${current.kind}:${current.suggestion?.id ?? current.task.id}`}
              kind={current.kind}
              task={current.task}
              suggestion={current.suggestion}
              zone={zone}
              today={today}
              place="today"
              onAnswered={onAnswered}
            />
          </section>
        ) : (
          <p className="asks-none">
            <span className="led led-ok" aria-hidden="true" />
            The AI has nothing to ask you.
          </p>
        )}
      </header>

      {error ? (
        <div className="banner banner-warn reload-error" role="alert">
          <span>Couldn't refresh: {error}</span>
          <button type="button" className="btn btn-small" aria-disabled={reloading || undefined} onClick={() => !reloading && void load()}>
            Try again
          </button>
        </div>
      ) : null}

      <div className="channels">
        <Group id="do" title="To do" question="What do I need to do?" items={data.doNow} empty={hidden ? "Nothing due today." : "Nobody has asked you for anything that's still open."} {...rowProps} />
        <Group id="promised" title="You promised" question="What did I promise?" items={data.promised} empty={hidden ? "Nothing due today." : "You haven't promised anything that's still open."} {...rowProps} />
        <Group id="waiting" title="Waiting" question="What am I waiting for?" items={data.waiting} empty={hidden ? "Nothing due today." : "You're not waiting on anyone."} {...rowProps} />
      </div>

      {c.snoozed + c.others + c.earlier > 0 ? (
        <nav className="today-more" aria-label="Other tasks">
          {c.snoozed > 0 ? (
            <a href={listHref("snoozed")}>
              <Clock size={15} aria-hidden="true" />
              {c.snoozed} snoozed
            </a>
          ) : null}
          {c.others > 0 ? (
            <a href={listHref("others")}>
              <Users size={15} aria-hidden="true" />
              {c.others === 1 ? "1 handled by a colleague" : `${c.others} handled by colleagues`}
            </a>
          ) : null}
          {c.earlier > 0 ? (
            <a href={listHref("earlier")}>
              <History size={15} aria-hidden="true" />
              {c.earlier === 1 ? "1 older task from before MailMe started — sort it out" : `${c.earlier} older tasks from before MailMe started — sort them out`}
            </a>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}

function Group({
  id,
  title,
  question,
  items,
  empty,
  zone,
  today,
  onChanged,
}: {
  id: string;
  title: string;
  question: string;
  items: TaskListItem[];
  empty: string;
  zone: string;
  today: string;
  onChanged: (c: RowChange) => void;
}) {
  return (
    <section className="group channel" aria-labelledby={`g-${id}`} data-focus-fallback={`g-${id}`}>
      <header className="channel-head">
        <h2 id={`g-${id}`} className="group-title" tabIndex={-1}>
          {title} {items.length > 0 ? <span className="count">{items.length}</span> : null}
        </h2>
        <span className="channel-q">{question}</span>
      </header>
      {items.length === 0 ? (
        <p className="group-empty">{empty}</p>
      ) : (
        <ul className="rows cards">
          {items.map((item) => (
            <TaskRow key={item.id} item={item} zone={zone} today={today} onChanged={onChanged} />
          ))}
        </ul>
      )}
    </section>
  );
}

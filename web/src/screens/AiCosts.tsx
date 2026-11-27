/**
 * "AI costs" (#/costs): what the AI cost — today, this month, the last 7 days, per email — then day by day (stacked
 * by mailbox and chat, with a table twin), each mailbox's daily limits as they count, the models, and the chat.
 * Amounts come from GET /api/costs (src/server/routes/costs.ts).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { AiCostDay, AiCostMailbox, AiCosts as AiCostsData } from "../../../src/server/api-types.js";
import { errorMessage, isApiError } from "../api.js";
import { api } from "../client.js";
import {
  cappedDays,
  costSeries,
  dayTotal,
  formatTick,
  formatUsd,
  labelledDays,
  launchPricesInUse,
  mailboxSince,
  meterTone,
  modelLabel,
  niceScale,
  perMail,
  priceSource,
  seriesValue,
  share,
  sumDays,
  type CostSeries,
} from "../costs-model.js";
import { addDays, formatDayMonth, formatDateShort, MONTHS_LONG, plural } from "../format.js";
import { useApp, useDocumentTitle } from "../hooks.js";
import { mailboxNames } from "../mailbox-view.js";
import { routeHref } from "../router.js";

export function AiCosts() {
  useDocumentTitle("AI costs");
  const { me, mailboxes, today } = useApp();
  const [data, setData] = useState<AiCostsData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.costs());
      setError(null);
    } catch (err) {
      if (!(isApiError(err) && err.handled)) setError(errorMessage(err));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load, today]);

  // What the user's own mailboxes are called everywhere else; a platform admin's other mailboxes go by their name.
  const names = useMemo(() => mailboxNames(mailboxes), [mailboxes]);
  // The chat is off unless the server turns it on; its section shows while it is on or while it has costs to show.
  const chat = me.chat || (data?.chat.models.length ?? 0) > 0;

  return (
    <div className="page costs">
      <header className="bridge bridge-compact">
        <h1 className="page-title">AI costs</h1>
        <p className="bridge-sub">
          What the AI costs to read your email{chat ? " and to answer “Ask your mail”" : ""}, in US dollars: an estimate from the tokens of each call, at the
          provider's prices.
        </p>
      </header>
      {error ? (
        <div className="error-box" role="alert">
          <p>{error}</p>
          <button type="button" className="btn" onClick={() => void load()}>
            Try again
          </button>
        </div>
      ) : null}
      {!data && !error ? <p className="muted loading">Loading…</p> : null}
      {data ? <CostsBody data={data} names={names} chat={chat} /> : null}
      <p className="costs-back">
        <a href={routeHref({ name: "settings" })}>← Settings</a>
      </p>
    </div>
  );
}

/** "A", "A and B", "A, B and C". */
function listOf(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function CostsBody({ data, names, chat }: { data: AiCostsData; names: ReadonlyMap<string, string>; chat: boolean }) {
  const label = (m: Pick<AiCostMailbox, "id" | "name" | "address">) => names.get(m.id) ?? m.name ?? m.address;
  const todays = data.days.find((d) => d.date === data.today);
  const month = sumDays(data.days, data.monthStart);
  const week = sumDays(data.days, addDays(data.today, -6));
  const per = perMail(data);
  const monthName = MONTHS_LONG[Number(data.monthStart.slice(5, 7)) - 1] ?? "This month";
  const series = costSeries(data, new Map(data.mailboxes.map((m) => [m.id, label(m)])));
  // What the notes say about prices comes from the price table: only launch prices still in force, for models in use.
  const now = new Date();
  const launchMail = launchPricesInUse(
    data.models.map((m) => m.model),
    now,
  );
  const launch = launchPricesInUse([...new Set([...data.models.map((m) => m.model), ...data.chat.models])], now);
  const ceiling = data.models.filter((m) => priceSource(m.model) === "ceiling").map((m) => modelLabel(m.model));
  const earlyFactor = data.mailboxes[0]?.today.earlyFactor ?? null;

  return (
    <>
      <section className="cost-tiles" aria-label="Totals">
        <Tile label="Today" value={formatUsd(todays ? dayTotal(todays) : 0)} sub={todays ? `${plural(todays.mails, "email", "emails")}${todays.chat > 0 ? ` · chat ${formatUsd(todays.chat)}` : ""}` : "No calls yet"} />
        <Tile label={monthName} value={formatUsd(month.mail + month.chat)} sub={`${plural(month.mails, "email", "emails")}${month.chat > 0 ? ` · chat ${formatUsd(month.chat)}` : ""}`} />
        <Tile label="Last 7 days" value={formatUsd(week.mail + week.chat)} sub={plural(week.mails, "email", "emails")} />
        <Tile label="Per email" value={per ? formatUsd(per.usd, 3) : "—"} sub={per ? modelLabel(per.model) : "No email analysed yet"} />
      </section>

      <section className="card cost-card" aria-labelledby="cost-days-h">
        <h2 id="cost-days-h" className="section-title">
          By day
        </h2>
        {data.days.length > 0 && series.length > 0 ? (
          <DailyChart days={data.days} series={series} today={data.today} shown={new Set(data.mailboxes.slice(0, 6).map((m) => m.id))} />
        ) : (
          <p className="muted">No AI cost in the last 30 days yet.</p>
        )}
      </section>

      <section className="card cost-card" aria-labelledby="cost-mb-h">
        <h2 id="cost-mb-h" className="section-title">
          Daily limits per mailbox
        </h2>
        {data.mailboxes.length === 0 ? <p className="muted">No mailbox yet.</p> : null}
        <ul className="cost-boxes">
          {data.mailboxes.map((m) => (
            <MailboxBudget key={m.id} m={m} name={label(m)} month={mailboxSince(data.days, m.id, data.monthStart)} perMailUsd={per?.usd ?? null} />
          ))}
        </ul>
        <p className="muted small">
          The limits count every call since local midnight
          {launchMail.length > 0
            ? `, ${listOf(launchMail.map((l) => modelLabel(l.model)))} at the full price rather than the launch price, so they never count less: that is why the cost here is above what is billed`
            : ""}
          . When a mailbox reaches a limit, its analysis stops until midnight and its email waits its turn.
        </p>
      </section>

      {data.models.length > 0 ? (
        <section className="card cost-card" aria-labelledby="cost-models-h">
          <h2 id="cost-models-h" className="section-title">
            Models
          </h2>
          <div className="table-wrap">
            <table className="cost-table">
              <thead>
                <tr>
                  <th scope="col">Model</th>
                  <th scope="col">Emails</th>
                  <th scope="col">Cost</th>
                  <th scope="col">Per email</th>
                  <th scope="col">Period</th>
                </tr>
              </thead>
              <tbody>
                {data.models.map((m) => (
                  <tr key={m.model}>
                    <th scope="row">{modelLabel(m.model)}</th>
                    <td>{m.mails}</td>
                    <td>{formatUsd(m.usd)}</td>
                    <td>{m.mails > 0 ? formatUsd(m.usd / m.mails, 3) : "—"}</td>
                    <td>{m.firstDay === m.lastDay ? formatDayMonth(m.firstDay, data.today) : `${formatDayMonth(m.firstDay, data.today)} – ${formatDayMonth(m.lastDay, data.today)}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {chat ? (
        <section className="card cost-card" aria-labelledby="cost-chat-h">
          <h2 id="cost-chat-h" className="section-title">
            Ask your mail
          </h2>
          <dl className="facts">
            <div className="fact">
              <dt>Today</dt>
              <dd>
                {plural(data.chat.questionsToday, "question", "questions")} of {data.chat.questionCap} a day{todays && todays.chat > 0 ? ` · ${formatUsd(todays.chat)}` : ""}
              </dd>
            </div>
            <div className="fact">
              <dt>{monthName}</dt>
              <dd>
                {plural(month.questions, "question", "questions")} · {formatUsd(month.chat)}
              </dd>
            </div>
            {data.chat.all ? (
              <div className="fact">
                <dt>Everyone today</dt>
                <dd>
                  {formatUsd(data.chat.all.usd)} of {formatUsd(data.chat.all.usdCap)} a day ({plural(data.chat.all.calls, "question", "questions")})
                </dd>
              </div>
            ) : null}
          </dl>
        </section>
      ) : null}

      <section className="card cost-card cost-notes" aria-labelledby="cost-notes-h">
        <h2 id="cost-notes-h" className="section-title">
          How it counts
        </h2>
        <ul>
          <li>
            Each amount is an estimate from the call's tokens at the provider's published price for that model, or the cost the provider reported for the call. The
            real charge, and any prepaid balance, are on the provider's billing page.
          </li>
          {ceiling.length > 0 ? (
            <li>
              MailMe has no price for {listOf(ceiling)}, so {ceiling.length === 1 ? "its" : "their"} calls count at a deliberately high $10 per million input tokens and
              $50 per million output tokens: more than the bill.
            </li>
          ) : null}
          {launch.map((l) => (
            <li key={l.model}>
              {modelLabel(l.model)} is billed at {l.factor === 0.5 ? "half price" : `${Math.round(l.factor * 100)}% of its price`} until {formatDayMonth(l.lastDay, data.today)},
              and counted that way here. From {formatDayMonth(l.from, data.today)} its price {l.factor === 0.5 ? "doubles" : "goes up"}.
            </li>
          ))}
          {earlyFactor ? (
            <li>
              Email that was already in a mailbox when it was added has daily limits of its own, {earlyFactor} times the usual ones, and does not use up the limits for
              new email.
            </li>
          ) : null}
          {data.scope === "all" ? <li>As a platform administrator you see every mailbox and everyone's questions.</li> : null}
        </ul>
      </section>
    </>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="card cost-tile">
      <span className="cost-tile-label">{label}</span>
      <span className="cost-tile-value">{value}</span>
      <span className="cost-tile-sub muted small">{sub}</span>
    </div>
  );
}

function MailboxBudget({ m, name, month, perMailUsd }: { m: AiCostMailbox; name: string; month: number; perMailUsd: number | null }) {
  const { live, early, caps, earlyFactor } = m.today;
  const budget = m.paused === "budget:calls" || m.paused === "budget:usd";
  return (
    <li className="cost-box">
      <div className="cost-box-head">
        <strong className="cost-box-name">{name}</strong>
        <span className={`chip activity-chip is-${m.paused ? "warn" : "ok"}`}>{m.paused ? (budget ? "Paused: daily limit" : "Paused") : "OK"}</span>
      </div>
      <Meter label="AI calls today" used={live.calls} cap={caps.calls} text={`${live.calls} of ${caps.calls}`} />
      <Meter label="Cost today, as the limit counts it" used={live.usd} cap={caps.usd} text={`${formatUsd(live.usd)} of ${formatUsd(caps.usd)}`} />
      {early.calls > 0 ? (
        <p className="muted small">
          Plus {plural(early.calls, "call", "calls")} ({formatUsd(early.usd)}) for older email, from before the mailbox was added, with limits of their own:{" "}
          {caps.calls * earlyFactor} calls or {formatUsd(caps.usd * earlyFactor)} a day.
        </p>
      ) : null}
      <p className="muted small">
        This month {formatUsd(month)}
        {m.queued > 0 ? ` · ${m.queued} waiting${perMailUsd !== null ? ` (about ${formatUsd(m.queued * perMailUsd)})` : ""}` : ""}
      </p>
    </li>
  );
}

function Meter({ label, used, cap, text }: { label: string; used: number; cap: number; text: string }) {
  const fraction = share(used, cap);
  const pct = Math.min(100, Math.round(fraction * 100));
  return (
    <div className="cost-meter-row">
      <span className="cost-meter-label small">{label}</span>
      <span className={`cost-meter is-${meterTone(fraction)}`} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={cap} aria-valuenow={Math.min(used, cap)} aria-valuetext={text}>
        <span className="cost-meter-fill" style={{ width: `${pct}%` }} />
      </span>
      <span className="cost-meter-text small">{text}</span>
    </div>
  );
}

/**
 * Stacked columns, one per day (dataviz: thin marks, a 2px surface gap between segments, a rounded cap, hairline
 * grid). Hover or the arrow keys show one day's breakdown; the same numbers are in the table below it.
 */
function DailyChart({ days, series, today, shown }: { days: AiCostDay[]; series: CostSeries[]; today: string; shown: ReadonlySet<string> }) {
  const totals = days.map(dayTotal);
  const max = Math.max(...totals, 0);
  const { top, ticks } = niceScale(max);
  const capped = cappedDays(totals);
  const last = days.length - 1;
  const labels = labelledDays(days);
  const [active, setActive] = useState<number | null>(null);
  const plot = useRef<HTMLDivElement>(null);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    setActive((cur) => {
      const at = cur ?? last;
      if (e.key === "Home") return 0;
      if (e.key === "End") return last;
      return Math.max(0, Math.min(last, at + (e.key === "ArrowLeft" ? -1 : 1)));
    });
  };

  const shownDay = active !== null ? days[active] : null;
  return (
    <div className="cchart">
      <ul className="cchart-legend" aria-label="Legend">
        {series.map((s) => (
          <li key={s.key}>
            <span className={`cchart-key cost-s${s.slot}`} aria-hidden="true" />
            {s.label}
          </li>
        ))}
      </ul>
      <div
        ref={plot}
        className="cchart-plot"
        tabIndex={0}
        role="group"
        aria-label={`Cost per day, ${formatDateShort(days[0]!.date, today)} to ${formatDateShort(days[last]!.date, today)}. Arrow keys show one day; the table below has every amount.`}
        onKeyDown={onKey}
        onFocus={() => setActive((cur) => cur ?? last)}
        onBlur={() => setActive(null)}
        onPointerLeave={() => setActive(null)}
      >
        <div className="cchart-grid" aria-hidden="true">
          {ticks.map((t) => (
            <span key={t} className="cchart-tick" style={{ bottom: `${(t / top) * 100}%` }}>
              <span className="cchart-tick-label">{formatTick(t)}</span>
            </span>
          ))}
        </div>
        <div className="cchart-cols">
          {days.map((d, i) => {
            const total = totals[i]!;
            const pct = top > 0 ? (total / top) * 100 : 0;
            return (
              <div key={d.date} className={`cchart-col${active === i ? " is-active" : ""}`} onPointerEnter={() => setActive(i)} aria-hidden="true">
                {total > 0 ? (
                  <div className="cchart-stack" style={{ height: `${pct}%` }}>
                    {capped.has(i) ? <span className="cchart-cap">{formatUsd(total)}</span> : null}
                    {series.map((s) => {
                      const v = seriesValue(d, s, shown);
                      return v > 0 ? <span key={s.key} className={`cchart-seg cost-s${s.slot}`} style={{ flexGrow: v }} /> : null;
                    })}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
        {shownDay ? (
          <div
            className="cchart-tip"
            role="status"
            // Beside the day, never over it: to its right in the first half of the run, to its left after.
            style={
              active! < days.length / 2
                ? { left: `calc(${((active! + 1) / days.length) * 100}% + 6px)` }
                : { right: `calc(${((days.length - active!) / days.length) * 100}% + 6px)` }
            }
          >
            <strong>{formatUsd(dayTotal(shownDay))}</strong>
            <span className="cchart-tip-date">
              {formatDateShort(shownDay.date, today)} · {plural(shownDay.mails, "email", "emails")}
            </span>
            {series.map((s) => {
              const v = seriesValue(shownDay, s, shown);
              return v > 0 ? (
                <span key={s.key} className="cchart-tip-row">
                  <span className={`cchart-tip-key cost-s${s.slot}`} aria-hidden="true" />
                  <span className="cchart-tip-value">{formatUsd(v)}</span> {s.label}
                </span>
              ) : null;
            })}
          </div>
        ) : null}
      </div>
      <div className="cchart-x" aria-hidden="true">
        {days.map((d, i) => (
          <span key={d.date} className="cchart-x-label">
            {labels.has(i) ? formatDayMonth(d.date, today) : ""}
          </span>
        ))}
      </div>
      <details className="cchart-table">
        <summary>As a table</summary>
        <div className="table-wrap">
          <table className="cost-table">
            <thead>
              <tr>
                <th scope="col">Day</th>
                {series.map((s) => (
                  <th key={s.key} scope="col">
                    {s.label}
                  </th>
                ))}
                <th scope="col">Total</th>
                <th scope="col">Emails</th>
              </tr>
            </thead>
            <tbody>
              {days
                .slice()
                .reverse()
                .map((d) => (
                  <tr key={d.date}>
                    <th scope="row">{formatDateShort(d.date, today)}</th>
                    {series.map((s) => (
                      <td key={s.key}>{formatUsd(seriesValue(d, s, shown))}</td>
                    ))}
                    <td>{formatUsd(dayTotal(d))}</td>
                    <td>{d.mails}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

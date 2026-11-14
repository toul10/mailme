/**
 * The week as a VU meter (the signature element — Contoso is pro audio): one vertical bar per working day,
 * one segment per task due that day, lit green → amber → red as the load rises. Overdue work gets its own bar,
 * separated like a master channel. The lit segments switch on once, bottom-up, when the screen opens.
 */
import type { CSSProperties } from "react";
import type { TaskListItem } from "../../../src/server/api-types.js";
import { WEEKDAYS_SHORT, addDays, weekdayOf } from "../format.js";

const DAYS = WEEKDAYS_SHORT;
const SEGMENTS = 6;

function dueOf(t: TaskListItem): string | null {
  return t.dueDate ?? (t.status === "WAITING_FOR_OTHER" ? t.expectReplyBy : null);
}

export function weekLoad(items: TaskListItem[], today: string): { overdue: number; days: Array<{ date: string; label: string; count: number; isToday: boolean }> } {
  const dow = weekdayOf(today); // 0 = Sunday
  const monday = addDays(today, dow === 0 ? 1 : 1 - dow);
  const days = Array.from({ length: 5 }, (_, i) => {
    const date = addDays(monday, i);
    return { date, label: DAYS[weekdayOf(date)]!, count: 0, isToday: date === today };
  });
  let overdue = 0;
  for (const t of items) {
    const d = dueOf(t);
    if (!d) continue;
    if (d < today) {
      // Late work counts once, under “Late” — not again on its (past) weekday.
      overdue++;
      continue;
    }
    const day = days.find((x) => x.date === d);
    if (day) day.count++;
  }
  return { overdue, days };
}

function level(i: number): "lo" | "mid" | "hi" {
  return i < 3 ? "lo" : i < 5 ? "mid" : "hi";
}

export function WeekMeter({ items, today }: { items: TaskListItem[]; today: string }) {
  const { overdue, days } = weekLoad(items, today);
  const bars = [{ key: "late", label: "Late", count: overdue, isToday: false, late: true }, ...days.map((d) => ({ key: d.date, label: d.label, count: d.count, isToday: d.isToday, late: false }))];
  const summary = `Your week by due date: ${overdue} late, ${days.map((d) => `${d.label}${d.isToday ? " (today)" : ""} ${d.count}`).join(", ")}`;
  return (
    <figure className="meter" aria-label={summary} role="img">
      <figcaption className="meter-caption">
        <span>Your week</span>
        <span className="meter-sub">by due date</span>
      </figcaption>
      <div className="meter-bars" aria-hidden="true">
        {bars.map((b, col) => (
          <div key={b.key} className={`meter-col${b.isToday ? " is-today" : ""}${b.late ? " is-late" : ""}${b.count > 0 ? " has-load" : ""}`} title={`${b.label}: ${b.count}`}>
            <span className="meter-count">{b.count > SEGMENTS ? `${SEGMENTS}+` : b.count}</span>
            <div className="meter-stack">
              {Array.from({ length: SEGMENTS }, (_, i) => {
                const lit = i < Math.min(b.count, SEGMENTS);
                const style = lit ? ({ "--i": i, "--c": col } as CSSProperties) : undefined;
                return <span key={i} className={`meter-seg ${b.late ? "hi" : level(i)}${lit ? " lit" : ""}`} style={style} />;
              })}
            </div>
            <span className="meter-label">{b.label}</span>
          </div>
        ))}
      </div>
    </figure>
  );
}

/**
 * Keeping keyboard focus sane when an action removes the control that had it (a row after “Done”, a triage card
 * after its answer). The row/card records where focus should go before it acts; the parent screen applies the plan
 * in an effect after its data re-rendered — and only if focus was actually lost (fell to <body>).
 */

export interface FocusPlan {
  /** CSS selectors, tried in order. */
  targets: string[];
}

const esc = (s: string) => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, "\\$&"));

/** The id a [data-focus-fallback] ancestor names (a section heading with tabIndex=-1). */
function fallbackOf(el: Element): string[] {
  const id = el.closest<HTMLElement>("[data-focus-fallback]")?.dataset.focusFallback;
  return id ? [`#${esc(id)}`] : [];
}

/** For a task row (<li> with a[data-row-link]): the next row, else the previous one, else the section heading. */
export function rowFocusPlan(li: Element | null): FocusPlan | null {
  if (!li) return null;
  const targets: string[] = [];
  for (const sib of [li.nextElementSibling, li.previousElementSibling]) {
    const id = sib?.querySelector<HTMLElement>("a[data-row-link]")?.dataset.id;
    if (id) targets.push(`a[data-row-link][data-id="${esc(id)}"]`);
  }
  return { targets: [...targets, ...fallbackOf(li)] };
}

/** For a triage card ([data-ask]): the next card's first answer, else the previous one's, else the heading. */
export function cardFocusPlan(card: Element | null): FocusPlan | null {
  if (!card) return null;
  const targets: string[] = [];
  for (const sib of [card.nextElementSibling, card.previousElementSibling]) {
    const key = (sib as HTMLElement | null)?.dataset?.ask;
    if (key) targets.push(`[data-ask="${esc(key)}"] .ask-answer button`);
  }
  return { targets: [...targets, ...fallbackOf(card)] };
}

export function focusLost(): boolean {
  const a = document.activeElement;
  return !a || a === document.body || !a.isConnected;
}

/** Applies a plan if focus fell to <body>; returns whether it moved focus. */
export function restoreFocus(plan: FocusPlan | null): boolean {
  if (!plan || !focusLost()) return false;
  for (const sel of plan.targets) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el) {
      el.focus();
      return true;
    }
  }
  return false;
}

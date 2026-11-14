/**
 * Light/dark preference (per browser, purely cosmetic). The only localStorage use in the SPA: it stores the
 * word "light" or "dark", never content (test/web/safety.test.ts exempts this file only).
 */
import { createElement, useState } from "react";

type Theme = "auto" | "light" | "dark";
const THEME_KEY = "mailme.theme";
const THEME_LABELS: Record<Theme, string> = { auto: "Theme: automatic", light: "Theme: light", dark: "Theme: dark" };

function readTheme(): Theme {
  try {
    const t = window.localStorage.getItem(THEME_KEY);
    return t === "light" || t === "dark" ? t : "auto";
  } catch {
    return "auto";
  }
}

export function applyTheme(theme: Theme = readTheme()): void {
  if (theme === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

/** Button in the account menu that cycles auto → light → dark (the menu stays open to show the choice). */
export function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme>(readTheme);
  const next: Theme = theme === "auto" ? "light" : theme === "light" ? "dark" : "auto";
  const onClick = () => {
    try {
      window.localStorage.setItem(THEME_KEY, next);
    } catch {
      // Private mode: the choice lasts for this page only.
    }
    applyTheme(next);
    setTheme(next);
  };
  return createElement("button", { type: "button", onClick }, THEME_LABELS[theme]);
}

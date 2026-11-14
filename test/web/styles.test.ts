/**
 * The stylesheet's theme contract: colours that depend on the theme are tokens set in the three :root blocks (auto
 * dark, forced dark, light default), so html[data-theme] always wins; and the text/background pairs the redesign
 * uses meet WCAG AA (4.5:1) in both themes.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("../../web/src/styles.css", import.meta.url)), "utf8");

/** Custom properties declared directly in the first block that opens with `selector {`. */
function tokens(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  const body = css.slice(start + selector.length + 2, css.indexOf("}", start));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim();
  return out;
}

function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (l1 + 0.05) / (l2 + 0.05);
}

const light = tokens(":root");
const dark = { ...light, ...tokens(":root[data-theme=\"dark\"]") };

describe("theme overrides", () => {
  it("has no component-level prefers-color-scheme rule that would ignore data-theme", () => {
    const blocks = [...css.matchAll(/@media \(prefers-color-scheme: dark\) \{\s*([^{\s][^{]*)\{/g)].map((m) => m[1]!.trim());
    expect(blocks).toEqual([':root:not([data-theme="light"])']);
  });

  it("defines the same tokens for auto dark and forced dark", () => {
    const auto = css.slice(css.indexOf('  :root:not([data-theme="light"]) {'));
    const autoBody = auto.slice(0, auto.indexOf("}"));
    for (const [k, v] of Object.entries(tokens(':root[data-theme="dark"]'))) expect(autoBody, k).toContain(`${k}: ${v};`);
  });
});

describe("contrast (WCAG AA, 4.5:1 for body text)", () => {
  const pairs: Array<[string, string, string]> = [
    // The “today” time phrase on every background it sits on, and the warn banner.
    ["--warn", "--bg", "time phrase on a row"],
    ["--warn", "--surface", "time phrase on the task page"],
    ["--warn", "--accent-soft", "time phrase on a selected row"],
    ["--warn", "--warn-soft", "warn banner"],
    ["--danger", "--bg", "overdue phrase"],
    ["--danger", "--surface", "warning lead in a question card"],
    ["--waiting", "--bg", "waiting phrase"],
    ["--muted", "--bg", "attributions"],
    ["--muted", "--surface", "facts"],
    ["--on-danger", "--danger", "danger button, error toast"],
    ["--on-ok", "--ok", "success toast"],
    ["--accent-text", "--accent", "primary button"],
    ["--accent", "--bg", "links and quiet buttons"],
    // v3: the lit key, the AI's voice, and captions on the rack (the rack is dark in both themes).
    ["--on-key", "--key", "primary key"],
    ["--ai", "--ai-soft", "AI chip"],
    ["--ai", "--surface", "AI text on a card"],
    ["--text", "--surface", "card text"],
    ["--rack-muted", "--rack", "rack captions"],
    ["--rack-text-2", "--bridge-bottom", "bridge sentence"],
  ];
  for (const [theme, t] of [
    ["light", light],
    ["dark", dark],
  ] as const) {
    it.each(pairs)(`${theme}: %s on %s (%s)`, (fg, bg) => {
      expect(contrast(t[fg]!, t[bg]!)).toBeGreaterThanOrEqual(4.5);
    });
  }
});

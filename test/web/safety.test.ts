import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const WEB = fileURLToPath(new URL("../../web", import.meta.url));

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.(tsx?|html)$/.test(name)) out.push(p);
  }
  return out;
}

describe("SPA safety guards", () => {
  const files = [...sources(join(WEB, "src")), join(WEB, "index.html")];

  it("never renders raw HTML and never logs (email text must stay out of consoles)", () => {
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toMatch(/dangerouslySetInnerHTML|\.innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
      expect(text, f).not.toMatch(/console\.(log|info|warn|error|debug)/);
      // Content never goes to persistent storage; the theme word (light/dark) in theme.ts is the one exception.
      if (!f.endsWith("theme.ts")) expect(text, f).not.toMatch(/localStorage/);
    }
  });

  it("keeps a chat conversation in memory only (mail text in answers never reaches the browser's storage)", () => {
    const chat = files.filter((f) => /chat/i.test(f.slice(WEB.length)));
    expect(chat.length).toBeGreaterThanOrEqual(3);
    for (const f of chat) expect(readFileSync(f, "utf8"), f).not.toMatch(/sessionStorage|localStorage|indexedDB|document\.cookie|caches\./);
  });

  it("keeps index.html free of inline scripts and styles (strict CSP)", () => {
    const html = readFileSync(join(WEB, "index.html"), "utf8");
    for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
      expect(m[1]).toMatch(/\bsrc=/);
      expect(m[2]!.trim()).toBe("");
    }
    expect(html).not.toMatch(/<style\b|\sstyle=|data:/);
  });
});

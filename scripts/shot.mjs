#!/usr/bin/env node
/**
 * Dev-only UI screenshots over the Chrome DevTools protocol (no extra dependency; uses Playwright's cached
 * headless shell). Needs the dev server with auto-login (see web/vite.config.ts):
 *   MAILME_DEV_LOGIN_EMAIL=demo@contoso.example MAILME_DEV_LOGIN_PASSWORD_FILE=data/demo-password.txt pnpm dev:web
 * Usage:
 *   node scripts/shot.mjs <out.png> <hash-or-url> [width=1440] [height=900] [--full] [--dark] [--base=http://127.0.0.1:5173]
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--") && !a.includes("=")));
// Split at the first "=" only: --eval=… carries JavaScript with its own "=".
const opt = Object.fromEntries(args.filter((a) => a.startsWith("--") && a.includes("=")).map((a) => [a.slice(2, a.indexOf("=")), a.slice(a.indexOf("=") + 1)]));
const [out, target = "#/", w = "1440", h = "900"] = args.filter((a) => !a.startsWith("--"));
if (!out) {
  console.error("usage: node scripts/shot.mjs <out.png> <hash-or-url> [width] [height] [--full] [--dark]");
  process.exit(2);
}
const base = opt.base ?? "http://127.0.0.1:5173";
const url = /^https?:/.test(target) ? target : `${base}/${target.startsWith("#") ? target : `#${target}`}`;

const cache = join(homedir(), "Library/Caches/ms-playwright");
const shellDir = existsSync(cache) ? readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().pop() : null;
const bin = shellDir ? join(cache, shellDir, "chrome-headless-shell-mac-arm64/chrome-headless-shell") : null;
if (!bin || !existsSync(bin)) {
  console.error("No Playwright headless shell found (npx playwright install chromium-headless-shell).");
  process.exit(1);
}
const port = 9400 + Math.floor(Math.random() * 400);
const proc = spawn(bin, [`--remote-debugging-port=${port}`, `--user-data-dir=/private/tmp/mailme-shot-${port}`, "--no-first-run", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets;
for (let i = 0; i < 60 && !targets; i++) {
  try {
    targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  } catch {
    await sleep(150);
  }
}
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
};
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
try {
  await send("Emulation.setDeviceMetricsOverride", { width: Number(w), height: Number(h), deviceScaleFactor: Number(opt.scale ?? 2), mobile: Number(w) < 700 });
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: flags.has("--dark") ? "dark" : "light" }, { name: "prefers-reduced-motion", value: "reduce" }] });
  await send("Page.navigate", { url });
  await sleep(Number(opt.wait ?? 2500));
  if (opt.eval) {
    const r = await send("Runtime.evaluate", { expression: opt.eval, awaitPromise: true, returnByValue: true });
    const v = r?.result?.result?.value;
    console.log("eval:", v !== undefined ? (typeof v === "string" ? v : JSON.stringify(v)) : JSON.stringify(r?.result?.exceptionDetails ?? r?.result).slice(0, 400));
  }
  if (opt.eval) await sleep(800);
  let clip;
  if (flags.has("--full")) {
    const r = await send("Runtime.evaluate", { expression: "Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)", returnByValue: true });
    clip = { x: 0, y: 0, width: Number(w), height: Math.min(Number(r.result?.result?.value ?? h), 6000), scale: 1 };
  }
  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: Boolean(clip), ...(clip ? { clip } : {}) });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, Buffer.from(shot.result.data, "base64"));
  console.log(`saved ${out}`);
} finally {
  ws.close();
  proc.kill();
}

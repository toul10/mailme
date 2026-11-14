import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * SPA build: `pnpm build:web` → web/dist (served by the Fastify API via @fastify/static).
 * Dev: `pnpm dev:web` on :5173 with /api and one-click pages (/a/:token) proxied to the API on :3000, or to
 * MAILME_DEV_API (e.g. a second API on the demo database while the real one runs on :3000).
 */
const webRoot = fileURLToPath(new URL(".", import.meta.url));
const apiTarget = process.env.MAILME_DEV_API ?? "http://127.0.0.1:3000";

/**
 * Dev-only auto-login for UI work (screenshots, design iterations): with MAILME_DEV_LOGIN_EMAIL and
 * MAILME_DEV_LOGIN_PASSWORD_FILE set, the dev server logs into the local API once and forwards the session cookie on
 * proxied requests, so the browser never handles credentials. Never set these outside a local demo database.
 */
let devCookie: string | null = null;
async function devLogin(): Promise<void> {
  const email = process.env.MAILME_DEV_LOGIN_EMAIL;
  const file = process.env.MAILME_DEV_LOGIN_PASSWORD_FILE;
  if (!email || !file) return;
  const password = readFileSync(file, "utf8").trim();
  const res = await fetch(`${apiTarget}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:3000" },
    body: JSON.stringify({ email, password }),
  });
  const cookie = res.headers.get("set-cookie")?.split(";")[0] ?? null;
  devCookie = res.ok ? cookie : null;
  console.log(devCookie ? `[dev] auto-login as ${email}` : `[dev] auto-login failed (${res.status})`);
}

const withDevCookie = {
  configure(proxy: { on(event: "proxyReq", fn: (req: { setHeader(k: string, v: string): void }) => void): void }) {
    proxy.on("proxyReq", (req) => {
      if (devCookie) req.setHeader("cookie", devCookie);
    });
  },
};

const proxy = {
  "/api": { target: apiTarget, ...withDevCookie },
  // Regex key: a plain "/a" prefix would also swallow /assets/* and /api.
  "^/a/": { target: apiTarget, ...withDevCookie },
};

export default defineConfig({
  root: webRoot,
  base: "/",
  plugins: [react(), { name: "mailme-dev-login", apply: "serve", configureServer: () => devLogin() }],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy,
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
    proxy,
  },
});

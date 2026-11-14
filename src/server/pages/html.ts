/** Minimal server-rendered pages (one-click links). Everything interpolated goes through `esc`. No scripts. */

export function esc(value: string | number | null | undefined): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const STYLE = `
:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--fg:#1d2330;--muted:#5b6475;--line:#dde1e8;--accent:#1f5fbf;--accent-fg:#fff;--warn:#a4410e}
@media (prefers-color-scheme:dark){:root{--bg:#14171c;--card:#1d2128;--fg:#e8ebf0;--muted:#a3abb9;--line:#2e343d;--accent:#5b93e6;--accent-fg:#0d1117;--warn:#f0a36b}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:560px;margin:0 auto;padding:32px 16px}
.brand{font-weight:700;letter-spacing:.02em;color:var(--muted);margin-bottom:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px}
h1{font-size:1.25rem;margin:0 0 12px}
dl{margin:0 0 16px;display:grid;grid-template-columns:auto 1fr;gap:6px 12px}
dt{color:var(--muted)}
dd{margin:0;overflow-wrap:anywhere}
fieldset{border:1px solid var(--line);border-radius:8px;margin:0 0 16px;padding:12px}
legend{color:var(--muted);padding:0 4px}
label{display:flex;gap:8px;align-items:center;margin:6px 0;flex-wrap:wrap}
input[type=date]{font:inherit;padding:4px 6px}
button{font:inherit;font-weight:600;background:var(--accent);color:var(--accent-fg);border:0;border-radius:8px;padding:10px 18px;cursor:pointer;width:100%}
p{margin:0 0 12px}
.muted{color:var(--muted)}
.warn{color:var(--warn)}
a{color:var(--accent)}
`;

export function page(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)} · MailMe</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<div class="brand">MailMe</div>
<div class="card">
${bodyHtml}
</div>
</main>
</body>
</html>`;
}

/** Short message page (errors, results). `detail` is plain text. */
export function messagePage(title: string, detail: string, opts: { link?: { href: string; label: string }; warn?: boolean } = {}): string {
  const link = opts.link ? `<p><a href="${esc(opts.link.href)}">${esc(opts.link.label)}</a></p>` : "";
  return page(title, `<h1${opts.warn ? ' class="warn"' : ""}>${esc(title)}</h1>\n<p>${esc(detail)}</p>\n${link}`);
}

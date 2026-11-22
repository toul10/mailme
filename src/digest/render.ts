import { TAG } from "./labels.js";
import { calendarDiff, localDateOf, localTime, shortDayLabel } from "./calendar.js";
import type { DigestItem, DigestModel, DigestSectionKey, LinkFactory } from "./model.js";
import { cleanText, defangText, escapeHtml, sanitizeAiText } from "./sanitize.js";

/**
 * Report template: table layout with inline CSS only (classic Outlook's Word engine: no flex/grid,
 * no <style>, bgcolor attributes), dark text on white, ≤ 600 px. Every dynamic string is escaped; AI-written
 * text is stripped of links/contacts, mail-derived text is defanged. The only anchors come from the LinkFactory.
 */

type Tab = "todo" | "waiting" | "all";
type ActionName = Parameters<LinkFactory["action"]>[1];

const C = {
  text: "#1f2328",
  muted: "#57606a",
  rule: "#d8dee4",
  link: "#0b57d0",
  headBg: "#f6f8fa",
  bannerBg: "#fdecea",
  bannerText: "#8a1c1c",
  bannerRule: "#f1b5b0",
  lateBg: "#fff4e5",
  lateText: "#7a4b00",
  tagBg: "#eef1f4",
} as const;
const FONT = "font-family:'Segoe UI',Arial,Helvetica,sans-serif;";

export const SECTION_TITLES: Record<DigestSectionKey, string> = {
  today: "🔴 Today",
  promises: "🟡 Promises due in the next 3 business days",
  followup: "🟠 Follow up",
  new: "🆕 New since yesterday",
  autoClosed: "✅ Closed automatically",
  stillValid: "🔁 Still valid?",
  problems: "⚠️ Not analysed / Not delivered",
};

const SECTION_TAB: Record<DigestSectionKey, Tab> = {
  today: "todo",
  promises: "todo",
  followup: "waiting",
  new: "all",
  autoClosed: "all",
  stillValid: "all",
  problems: "all",
};

const RENDER_ORDER: DigestSectionKey[] = ["today", "promises", "followup", "new", "autoClosed", "stillValid", "problems"];

/** One-click actions offered per section (label, action). */
const SECTION_ACTIONS: Record<DigestSectionKey, Array<[string, ActionName]>> = {
  today: [["✔ Done", "complete"]],
  promises: [["✔ Done", "complete"]],
  followup: [["✔ They replied / done", "complete"]],
  new: [
    ["✔ Correct", "confirm"],
    ["✖ Not a task", "dismiss"],
  ],
  autoClosed: [["↺ Not done — reopen it", "reopen"]],
  stillValid: [
    ["✔ Yes, still valid", "still_valid"],
    ["✔ Already done", "complete"],
  ],
  problems: [],
};

interface RenderedLink {
  label: string;
  url: string;
}

interface ItemView {
  ref: number;
  title: string;
  taskUrl: string;
  tags: string[];
  details: string[];
  meta: string[];
  actions: RenderedLink[];
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "Thu 24 Sep 10:02" from the model's local "YYYY-MM-DD HH:mm". */
function formatLocal(dt: string | null): string | null {
  if (!dt) return null;
  const m = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/.exec(dt);
  if (!m) return null;
  return m[2] ? `${shortDayLabel(m[1]!)} ${m[2]}` : shortDayLabel(m[1]!);
}

function deadlineText(item: DigestItem, localDate: string): string | null {
  const open = item.status === "ACTION_REQUIRED" || item.status === "WAITING_FOR_ME" || item.status === "WAITING_FOR_OTHER";
  if (!open) return null;
  const parts: string[] = [];
  if (item.dueDate) {
    const overdue = item.overdueDays ?? (item.dueDate < localDate ? calendarDiff(item.dueDate, localDate) : null);
    if (overdue !== null && overdue > 0) parts.push(`overdue by ${plural(overdue, "day", "days")} (due ${shortDayLabel(item.dueDate)})`);
    else if (item.dueDate === localDate || overdue === 0) parts.push("due today");
    else parts.push(`due ${shortDayLabel(item.dueDate)}`);
  } else if (item.duePhrase) {
    parts.push(`“${sanitizeAiText(item.duePhrase, 80)}”`);
  }
  if (item.status === "WAITING_FOR_OTHER" && item.businessDaysWaiting !== null && item.businessDaysWaiting > 0) {
    parts.push(`waiting ${plural(item.businessDaysWaiting, "business day", "business days")}`);
  }
  return parts.length ? parts.join(" · ") : null;
}

async function itemView(item: DigestItem, section: DigestSectionKey, model: DigestModel, links: LinkFactory): Promise<ItemView> {
  const details: string[] = [];
  if (item.company) details.push(defangText(item.company, 80));
  if (item.nextAction) {
    const a = sanitizeAiText(item.nextAction, 200);
    if (a) details.push(a);
  }
  const dl = deadlineText(item, model.localDate);
  if (dl) details.push(dl);

  const meta: string[] = [];
  if (item.subject) meta.push(`Subject: “${defangText(item.subject, 160)}”`);
  if (item.sender) meta.push(defangText(item.sender, 80));
  const when = formatLocal(item.lastMessageDate);
  if (when) meta.push(when);

  const actions: RenderedLink[] = [];
  for (const [label, action] of SECTION_ACTIONS[section]) actions.push({ label, url: await links.action(item.taskId, action) });
  if (section !== "stillValid" && section !== "autoClosed" && item.tags.includes(TAG.stillValid)) {
    actions.push({ label: "✔ Yes, still valid", url: await links.action(item.taskId, "still_valid") });
  }

  return {
    ref: item.ref,
    title: sanitizeAiText(item.title, 160) || `Task #${item.ref}`,
    taskUrl: links.task(item.taskId),
    tags: item.tags.map((t) => defangText(t, 80)).filter(Boolean),
    details,
    meta,
    actions,
  };
}

function summaryLine(model: DigestModel): string {
  const parts: string[] = [];
  const c = model.counts;
  const promises = model.sections.promises.items.length + model.sections.promises.more;
  const fresh = model.sections.new.items.length + model.sections.new.more;
  parts.push(c.actionToday ? `${c.actionToday} due today` : "nothing due today");
  if (promises) parts.push(plural(promises, "promise", "promises"));
  if (c.waiting) parts.push(`${c.waiting} waiting`);
  if (c.overdue) parts.push(`${c.overdue} overdue`);
  if (fresh) parts.push(`${fresh} new`);
  parts.push(`${c.openTotal} open in total`);
  return parts.join(" · ");
}

export function digestSubject(model: DigestModel): string {
  const today = model.sections.today.items.length + model.sections.today.more;
  const promises = model.sections.promises.items.length + model.sections.promises.more;
  const fresh = model.sections.new.items.length + model.sections.new.more;
  let tail: string;
  if (today > 0) tail = `${today} due today`;
  else if (promises > 0) tail = plural(promises, "promise", "promises");
  else if (fresh > 0) tail = `${fresh} new`;
  else if (model.isEmpty) tail = "no open tasks";
  else tail = "nothing due today";
  const warn = model.freshness.banner ? " · ⚠️ analysis incomplete" : "";
  return `📋 Tasks — ${shortDayLabel(model.localDate)} · ${tail}${warn}`;
}

function zoneOf(model: DigestModel): string {
  const z = (model as DigestModel & { zone?: unknown }).zone;
  return typeof z === "string" && z ? z : "Europe/Athens";
}

function freshnessNote(model: DigestModel): string | null {
  if (model.freshness.banner || !model.freshness.lastSyncAt) return null;
  return `Last sync: ${localTime(model.freshness.lastSyncAt, zoneOf(model))}`;
}

function firstName(name: string): string {
  return cleanText(name, 60).split(" ")[0] ?? "";
}

/** "Summary" (the owner's summary rule): what happened since the previous report. */
function ruleSummaryLine(s: NonNullable<NonNullable<DigestModel["rules"]>["summary"]>): string {
  return [
    plural(s.received, "new email", "new emails"),
    plural(s.newTasks, "new task", "new tasks"),
    `${s.answered} answered by the team`,
    plural(s.updates, "update sent", "updates sent"),
    `${s.ignored} ignored by your rules`,
    `${s.openTotal} open`,
  ].join(" · ");
}

/** "Answered", "Forwarded to a colleague" and "Updates" (the owner's answered / updates rules). True when something was rendered. */
function renderRuleBlocks(model: DigestModel, links: LinkFactory, htmlRows: string[], text: string[]): boolean {
  const r = model.rules!;
  const zone = zoneOf(model);
  let shown = false;
  if (r.answered.length) {
    shown = true;
    const title = "💬 Answered";
    const count = r.answered.length + r.answeredMore;
    // A task of the forward rule says where the mail went ("forwarded to orders@…"), any other who answered.
    const lines = r.answered.map((t) => {
      const by = t.by ? defangText(t.by, 80) : null;
      const note = t.forwardedTo ? `forwarded to ${defangText(t.forwardedTo, 80)}${by ? ` (${by})` : ""}` : by ? `answered by ${by}` : null;
      return { url: links.task(t.taskId), ref: t.ref, title: t.title, note };
    });
    const body = lines
      .map((l) => row(`${a(l.url, `#${l.ref}`, "font-weight:bold;")} ${escapeHtml(l.title)}${l.note ? ` <span style="color:${C.muted};">— ${escapeHtml(l.note)}</span>` : ""}`, `padding:6px 12px;font-size:14px;line-height:20px;color:${C.text};border-bottom:1px solid ${C.rule};`))
      .join("");
    const more = r.answeredMore ? row(escapeHtml(`… and ${r.answeredMore} more`), `padding:6px 12px;font-size:13px;line-height:19px;color:${C.muted};`) : "";
    htmlRows.push(htmlSection(title, count, body, more));
    text.push("", `${title} (${count})`);
    for (const l of lines) text.push(`• #${l.ref} ${l.title}${l.note ? ` — ${l.note}` : ""}`, `  Open: ${l.url}`);
    if (r.answeredMore) text.push(`… and ${r.answeredMore} more`);
  }
  if (r.handedOver.length) {
    shown = true;
    const title = "↪ Forwarded to a colleague";
    const count = r.handedOver.length + r.handedOverMore;
    const lines = r.handedOver.map((t) => ({ url: links.task(t.taskId), ref: t.ref, title: t.title, to: t.to ? defangText(t.to, 80) : null }));
    const body = lines
      .map((l) => row(`${a(l.url, `#${l.ref}`, "font-weight:bold;")} ${escapeHtml(l.title)}${l.to ? ` <span style="color:${C.muted};">— handled by ${escapeHtml(l.to)}</span>` : ""}`, `padding:6px 12px;font-size:14px;line-height:20px;color:${C.text};border-bottom:1px solid ${C.rule};`))
      .join("");
    const more = r.handedOverMore ? row(escapeHtml(`… and ${r.handedOverMore} more`), `padding:6px 12px;font-size:13px;line-height:19px;color:${C.muted};`) : "";
    htmlRows.push(htmlSection(title, count, body, more));
    text.push("", `${title} (${count})`);
    for (const l of lines) text.push(`• #${l.ref} ${l.title}${l.to ? ` — handled by ${l.to}` : ""}`, `  Open: ${l.url}`);
    if (r.handedOverMore) text.push(`… and ${r.handedOverMore} more`);
  }
  if (r.updates.length) {
    shown = true;
    const title = "📣 Updates";
    const count = r.updates.length + r.updatesMore;
    const lines = r.updates.map((u) => `“${defangText(u.subject, 120)}” → ${plural(u.recipients, "recipient", "recipients")} · ${shortDayLabel(localDateOf(u.at, zone))} ${localTime(u.at, zone)}`);
    const body = lines.map((l) => row(escapeHtml(l), `padding:6px 12px;font-size:14px;line-height:20px;color:${C.text};border-bottom:1px solid ${C.rule};`)).join("");
    const more = r.updatesMore ? row(escapeHtml(`… and ${r.updatesMore} more`), `padding:6px 12px;font-size:13px;line-height:19px;color:${C.muted};`) : "";
    htmlRows.push(htmlSection(title, count, body, more));
    text.push("", `${title} (${count})`);
    for (const l of lines) text.push(`• ${l}`);
    if (r.updatesMore) text.push(`… and ${r.updatesMore} more`);
  }
  return shown;
}

// ── HTML ─────────────────────────────────────────────────────────────────────

const a = (url: string, label: string, extra = "") =>
  `<a href="${escapeHtml(url)}" style="color:${C.link};text-decoration:underline;${extra}">${escapeHtml(label)}</a>`;

const td = (content: string, style: string, attrs = "") => `<td ${attrs}style="${FONT}${style}">${content}</td>`;

const row = (content: string, style: string, attrs = "") => `<tr>${td(content, style, attrs)}</tr>`;

function htmlItem(v: ItemView): string {
  const tags = v.tags
    .map((t) => `<span style="${FONT}font-size:12px;color:${C.muted};background-color:${C.tagBg};padding:1px 4px;">${escapeHtml(t)}</span>`)
    .join(" ");
  const lines: string[] = [];
  lines.push(
    `<div style="${FONT}font-size:15px;line-height:21px;color:${C.text};">${a(v.taskUrl, `#${v.ref}`, "font-weight:bold;")} <b>${escapeHtml(v.title)}</b>${tags ? ` ${tags}` : ""}</div>`,
  );
  if (v.details.length) lines.push(`<div style="${FONT}font-size:14px;line-height:20px;color:${C.text};">${v.details.map(escapeHtml).join(" · ")}</div>`);
  if (v.meta.length) lines.push(`<div style="${FONT}font-size:12px;line-height:18px;color:${C.muted};">${v.meta.map(escapeHtml).join(" · ")}</div>`);
  if (v.actions.length) {
    lines.push(`<div style="${FONT}font-size:13px;line-height:22px;">${v.actions.map((l) => a(l.url, l.label)).join("&nbsp;&nbsp;&nbsp;")}</div>`);
  }
  return row(lines.join(""), `padding:8px 12px;border-bottom:1px solid ${C.rule};`);
}

function htmlSection(title: string, count: number, body: string, moreHtml: string): string {
  const head = row(`${escapeHtml(title)} <span style="font-weight:normal;color:${C.muted};">(${count})</span>`, `padding:8px 12px;font-size:16px;line-height:22px;font-weight:bold;color:${C.text};border-top:1px solid ${C.rule};`, `bgcolor="${C.headBg}" `);
  return `<tr><td style="padding:12px 0 0 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">${head}${body}${moreHtml}</table></td></tr>`;
}

// ── Plain text ───────────────────────────────────────────────────────────────

function textItem(v: ItemView): string[] {
  const out = [`• #${v.ref} ${v.title}${v.tags.length ? ` [${v.tags.join(" · ")}]` : ""}`];
  if (v.details.length) out.push(`  ${v.details.join(" · ")}`);
  if (v.meta.length) out.push(`  ${v.meta.join(" · ")}`);
  for (const l of v.actions) out.push(`  ${l.label}: ${l.url}`);
  out.push(`  Open: ${v.taskUrl}`);
  return out;
}

/** English, table-based HTML with inline CSS (≤600px, Outlook Word engine) + plain text. All text escaped. */
export async function renderDigest(model: DigestModel, links: LinkFactory): Promise<{ subject: string; html: string; text: string }> {
  const subject = digestSubject(model);
  const heading = `📋 Tasks — ${model.weekdayLabel}`;
  const greeting = firstName(model.userName) ? `Good morning, ${firstName(model.userName)}.` : "Good morning.";
  const summary = summaryLine(model);
  const banner = model.freshness.banner ? cleanText(model.freshness.banner, 400) : null;
  const note = freshnessNote(model);

  const htmlRows: string[] = [];
  const text: string[] = [heading, greeting, summary];

  htmlRows.push(row(escapeHtml(heading), `padding:16px 12px 4px 12px;font-size:20px;line-height:26px;font-weight:bold;color:${C.text};`));
  htmlRows.push(row(`${escapeHtml(greeting)} ${escapeHtml(summary)}`, `padding:0 12px 8px 12px;font-size:14px;line-height:20px;color:${C.text};`));
  if (model.late) {
    htmlRows.push(row("⏱ Sent late", `padding:6px 12px;font-size:13px;line-height:18px;color:${C.lateText};`, `bgcolor="${C.lateBg}" `));
    text.push("⏱ Sent late");
  }
  if (banner) {
    htmlRows.push(
      row(`⚠️ ${escapeHtml(banner)}`, `padding:10px 12px;font-size:14px;line-height:20px;font-weight:bold;color:${C.bannerText};border:1px solid ${C.bannerRule};`, `bgcolor="${C.bannerBg}" `),
    );
    text.push(`⚠️ ${banner}`);
  } else if (note) {
    htmlRows.push(row(escapeHtml(note), `padding:0 12px 4px 12px;font-size:12px;line-height:18px;color:${C.muted};`));
    text.push(note);
  }
  const ruleSummary = model.rules?.summary ? ruleSummaryLine(model.rules.summary) : null;
  if (ruleSummary) {
    htmlRows.push(row(`<b>Summary:</b> ${escapeHtml(ruleSummary)}`, `padding:4px 12px 8px 12px;font-size:14px;line-height:20px;color:${C.text};`));
    text.push(`Summary: ${ruleSummary}`);
  }

  const problemLines = model.problems.filter((p) => p.kind !== "bounce").map((p) => defangText(p.text, 300));
  let anything = false;
  for (const key of RENDER_ORDER) {
    // The owner's rule blocks (src/digest/rule-blocks.ts) come after the task sections, before the problems.
    if (key === "problems" && model.rules && renderRuleBlocks(model, links, htmlRows, text)) anything = true;
    const sec = model.sections[key];
    const lines = key === "problems" ? problemLines : [];
    if (!sec.items.length && !sec.more && !lines.length) continue;
    anything = true;
    const views: ItemView[] = [];
    for (const item of sec.items) views.push(await itemView(item, key, model, links));
    const count = sec.items.length + sec.more + lines.length;
    const listUrl = sec.more > 0 ? links.list(SECTION_TAB[key]) : null;
    const body = [
      ...views.map(htmlItem),
      ...lines.map((l) => row(escapeHtml(l), `padding:6px 12px;font-size:13px;line-height:19px;color:${C.text};border-bottom:1px solid ${C.rule};`)),
    ].join("");
    const moreHtml = listUrl ? row(a(listUrl, `+${sec.more} more`), `padding:6px 12px;font-size:13px;line-height:19px;`) : "";
    htmlRows.push(htmlSection(SECTION_TITLES[key], count, body, moreHtml));

    text.push("", `${SECTION_TITLES[key]} (${count})`);
    for (const v of views) text.push(...textItem(v));
    for (const l of lines) text.push(`• ${l}`);
    if (listUrl) text.push(`+${sec.more} more: ${listUrl}`);
  }

  if (!anything) {
    const empty = "No tasks for today. ☕";
    htmlRows.push(row(escapeHtml(empty), `padding:16px 12px;font-size:15px;line-height:21px;color:${C.text};`));
    text.push("", empty);
  }

  const allUrl = links.list("todo");
  const footer = "This report was generated by MailMe. Action links work once and expire in 7 days.";
  htmlRows.push(
    row(
      `${a(allUrl, "All tasks")}<br>${escapeHtml(footer)}`,
      `padding:16px 12px;font-size:12px;line-height:18px;color:${C.muted};border-top:1px solid ${C.rule};`,
    ),
  );
  text.push("", `All tasks: ${allUrl}`, footer);

  const html =
    `<!DOCTYPE html>\n<html lang="en"><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light only">` +
    `<title>${escapeHtml(subject)}</title></head>` +
    `<body style="margin:0;padding:0;background-color:#ffffff;" bgcolor="#ffffff">` +
    `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${escapeHtml(summary)}</div>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="border-collapse:collapse;background-color:#ffffff;">` +
    `<tr><td align="center" style="padding:8px 4px;">` +
    `<!--[if mso]><table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="border-collapse:collapse;max-width:600px;background-color:#ffffff;">` +
    htmlRows.join("\n") +
    `</table>` +
    `<!--[if mso]></td></tr></table><![endif]-->` +
    `</td></tr></table></body></html>\n`;

  return { subject, html, text: text.join("\n") + "\n" };
}

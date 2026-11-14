import fastifyFormbody from "@fastify/formbody";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import { DateTime } from "luxon";
import { organizations, tasks } from "../../db/schema.js";
import { redeemActionToken } from "../../digest/links.js";
import type { SnoozeMode } from "../../domain/types.js";
import { ConflictError, NotFoundError, type ActionCtx } from "../../engine/user-actions.js";
import { localDate, nextBusinessDay } from "../../lib/dates.js";
import { audit } from "../audit.js";
import { rateLimit } from "../auth/guard.js";
import type { AppContext } from "../context.js";
import { UUID_RE } from "../http.js";
import { formatDate } from "../labels.js";
import { performTaskAction } from "../routes/tasks.js";
import { isSameOriginRequest } from "../security.js";
import { esc, messagePage, page } from "./html.js";

/**
 * One-click pages from the daily report (no login). GET only shows a confirmation — link scanners prefetch
 * GETs — and the action happens on the form POST, after a same-origin check and single-use redemption.
 * Pages show only what the report already shows: title, company, action, deadline.
 */

export const ONE_CLICK_ACTIONS = ["complete", "dismiss", "snooze", "confirm", "reopen", "still_valid"] as const;
export type OneClickAction = (typeof ONE_CLICK_ACTIONS)[number];
const isOneClickAction = (a: string): a is OneClickAction => (ONE_CLICK_ACTIONS as readonly string[]).includes(a);

const HEADINGS: Record<OneClickAction, string> = {
  complete: "Mark as done?",
  dismiss: "Not a task?",
  snooze: "Snooze task",
  confirm: "Confirm task",
  reopen: "Reopen?",
  still_valid: "Still valid?",
};

const ACTION_LABELS: Record<OneClickAction, string> = {
  complete: "Done",
  dismiss: "Not a task",
  snooze: "Snooze",
  confirm: "Confirm",
  reopen: "Not done — reopen it",
  still_valid: "Still valid",
};

const BUTTONS: Record<OneClickAction, string> = {
  complete: "✔ Done",
  dismiss: "✖ Not a task",
  snooze: "Snooze",
  confirm: "✔ Confirm",
  reopen: "Reopen it",
  still_valid: "Yes, still valid",
};

const DISMISS_KINDS = ["not_a_task", "handled_by_other", "other"] as const;
type DismissKind = (typeof DISMISS_KINDS)[number];

const APP_LINK = { href: "/", label: "Open MailMe" };

type FormInput = { action: "snooze"; mode: SnoozeMode; until: string | null } | { action: "dismiss"; kind: DismissKind } | { action: Exclude<OneClickAction, "snooze" | "dismiss"> };

interface TaskView {
  id: string;
  title: string;
  company: string | null;
  dueDate: string | null;
  duePhrase: string | null;
  timezone: string;
}

function html(reply: FastifyReply, status: number, body: string): FastifyReply {
  return reply.code(status).type("text/html; charset=utf-8").send(body);
}

const invalidLinkPage = () =>
  messagePage("This link is no longer valid", "It has expired or has already been used. Open the app to see the task.", { link: APP_LINK, warn: true });

function confirmPage(token: string, action: OneClickAction, t: TaskView, today: string): string {
  const deadline = t.dueDate ? formatDate(t.dueDate) : t.duePhrase || "—";
  const tomorrow = DateTime.fromISO(today).plus({ days: 1 }).toISODate()!;
  const maxDate = DateTime.fromISO(today).plus({ days: 365 }).toISODate()!;
  let extra = "";
  if (action === "snooze") {
    const suggested = nextBusinessDay(tomorrow);
    extra = `<fieldset><legend>Until when?</legend>
<label><input type="radio" name="mode" value="until_date" checked> Until <input type="date" name="until" value="${esc(suggested)}" min="${esc(tomorrow)}" max="${esc(maxDate)}"></label>
<label><input type="radio" name="mode" value="until_reply"> until they reply</label>
</fieldset>`;
  } else if (action === "dismiss") {
    extra = `<fieldset><legend>Why?</legend>
<label><input type="radio" name="kind" value="not_a_task" checked> Not a task</label>
<label><input type="radio" name="kind" value="handled_by_other"> Someone else has it</label>
<label><input type="radio" name="kind" value="other"> Another reason</label>
</fieldset>`;
  }
  const actionUrl = `/a/${encodeURIComponent(token)}`;
  return page(
    HEADINGS[action],
    `<h1>${esc(HEADINGS[action])}</h1>
<dl>
<dt>Task</dt><dd>${esc(t.title)}</dd>
<dt>Company</dt><dd>${esc(t.company || "—")}</dd>
<dt>Action</dt><dd>${esc(ACTION_LABELS[action])}</dd>
<dt>Due date</dt><dd>${esc(deadline)}</dd>
</dl>
<form method="post" action="${esc(actionUrl)}">
<input type="hidden" name="token" value="${esc(token)}">
${extra}
<button type="submit">${esc(BUTTONS[action])}</button>
</form>
<p class="muted" style="margin-top:12px">Nothing happens until you press the button.</p>`,
  );
}

function resultText(input: FormInput): string {
  switch (input.action) {
    case "complete":
      return "The task is marked as done.";
    case "dismiss":
      return input.kind === "handled_by_other" ? "Marked as handled by someone else." : "The task was removed.";
    case "snooze":
      return input.mode === "until_reply" ? "Snoozed until they reply." : `Snoozed until ${formatDate(input.until)}.`;
    case "confirm":
      return "The task is confirmed.";
    case "reopen":
      return "The task is open again.";
    case "still_valid":
      return "Marked as still valid.";
  }
}

/** Validate the form for this action before the token is consumed (a bad date must not burn the link). */
function parseForm(action: OneClickAction, form: Record<string, string>, today: string): FormInput | null {
  if (action === "snooze") {
    const mode = form["mode"] ?? "until_date";
    if (mode === "until_reply") return { action, mode, until: null };
    if (mode !== "until_date") return null;
    const until = form["until"] ?? "";
    const d = DateTime.fromISO(until);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(until) || !d.isValid) return null;
    if (until <= today || until > DateTime.fromISO(today).plus({ days: 365 }).toISODate()!) return null;
    return { action, mode, until };
  }
  if (action === "dismiss") {
    const kind = form["kind"] ?? "not_a_task";
    return (DISMISS_KINDS as readonly string[]).includes(kind) ? { action, kind: kind as DismissKind } : null;
  }
  return { action };
}

function formFields(body: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (body && typeof body === "object") {
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) if (typeof v === "string") out[k] = v;
  }
  return out;
}

export async function registerOneClickRoutes(scope: FastifyInstance, ctx: AppContext): Promise<void> {
  const { db, clock } = ctx.deps;
  // Form bodies are accepted only in this scope (the JSON API never parses urlencoded bodies).
  await scope.register(fastifyFormbody, { bodyLimit: 4096 });

  async function loadTask(taskId: string, userId: string): Promise<TaskView | null> {
    if (!UUID_RE.test(taskId) || !UUID_RE.test(userId)) return null;
    const [row] = await db
      .select({ id: tasks.id, title: tasks.title, company: tasks.company, dueDate: tasks.dueDate, duePhrase: tasks.duePhrase, timezone: organizations.timezone })
      .from(tasks)
      .innerJoin(organizations, eq(organizations.id, tasks.orgId))
      .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId)))
      .limit(1);
    return row ?? null;
  }

  scope.get<{ Params: { token: string } }>("/a/:token", { onRequest: [rateLimit(ctx, "oneClick")] }, async (request, reply) => {
    const token = request.params.token;
    const now = clock.now();
    const payload = await redeemActionToken(db, ctx.linkSecret, token, now, false);
    if (!payload || !isOneClickAction(payload.action)) return html(reply, 410, invalidLinkPage());
    const task = await loadTask(payload.taskId, payload.userId);
    if (!task) return html(reply, 410, invalidLinkPage());
    return html(reply, 200, confirmPage(token, payload.action, task, localDate(now, task.timezone)));
  });

  scope.post<{ Params: { token: string } }>("/a/:token", { onRequest: [rateLimit(ctx, "oneClick")] }, async (request, reply) => {
    const token = request.params.token;
    const form = formFields(request.body);
    if (form["token"] !== undefined && form["token"] !== token) return html(reply, 400, invalidLinkPage());

    if (!isSameOriginRequest(request.headers, ctx.appOrigin)) {
      await audit(db, { event: "oneclick.rejected", detail: { reason: "origin" }, ip: request.ip });
      return html(reply, 403, messagePage("Not allowed", "This action is only allowed from the MailMe confirmation page.", { link: APP_LINK, warn: true }));
    }

    const now = clock.now();
    // Peek (no consume) to learn the action and validate the form first.
    const peek = await redeemActionToken(db, ctx.linkSecret, token, now, false);
    if (!peek || !isOneClickAction(peek.action)) return html(reply, 410, invalidLinkPage());
    const task = await loadTask(peek.taskId, peek.userId);
    if (!task) return html(reply, 410, invalidLinkPage());
    const input = parseForm(peek.action, form, localDate(now, task.timezone));
    if (!input) {
      return html(reply, 400, messagePage("Invalid choice", "Check the date and try again from the same link.", { warn: true }));
    }

    const payload = await redeemActionToken(db, ctx.linkSecret, token, now, true);
    if (!payload || payload.taskId !== peek.taskId || payload.userId !== peek.userId || payload.action !== peek.action) {
      await audit(db, { event: "oneclick.rejected", detail: { reason: "invalid_token" }, ip: request.ip });
      return html(reply, 410, invalidLinkPage());
    }

    const actx: ActionCtx = { db, clock, userId: payload.userId, via: "link" };
    try {
      await performTaskAction(actx, payload.taskId, input);
    } catch (err) {
      if (err instanceof ConflictError) {
        return html(reply, 409, messagePage("The action was not applied", "The task has already changed. Open the app to see its current status.", { link: APP_LINK, warn: true }));
      }
      if (err instanceof NotFoundError) return html(reply, 410, invalidLinkPage());
      throw err;
    }
    await audit(db, { userId: payload.userId, event: "oneclick.action", detail: { taskId: payload.taskId, action: payload.action }, ip: request.ip });
    return html(reply, 200, messagePage("Done ✔", `${resultText(input)} (${task.title})`, { link: APP_LINK }));
  });
}

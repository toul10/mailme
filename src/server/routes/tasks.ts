import { and, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { z } from "zod";
import { mailboxes, messages } from "../../db/schema.js";
import {
  completeTask,
  confirmTask,
  ConflictError,
  createManualTask,
  dismissTask,
  editTask,
  markStillValid,
  markWouldHaveMissed,
  mergeTasks,
  NotFoundError,
  reopenTask,
  resolveSuggestion,
  snoozeTask,
  unsnoozeTask,
  type ActionCtx,
  type TaskEdit,
} from "../../engine/user-actions.js";
import type { TaskAction, TaskDetail } from "../api-types.js";
import { authOf, requireAuth } from "../auth/guard.js";
import type { AppContext } from "../context.js";
import { badRequest, notFound, parseWith, UUID_RE, uuidParam } from "../http.js";
import { getTaskDetail, listCompanies, listTasks, ownedEventTaskId, ownedTaskId, type QueryScope } from "../queries.js";
import { getToday } from "../today.js";
import { BulkBody, CreateTaskBody, EditTaskBody, MergeBody, SuggestionBody, TaskActionBody, TaskActionSchema, TaskListQuery } from "../validation.js";

/** Run one task action through the engine (which writes the event, bumps version, locks fields). */
export async function performTaskAction(actx: ActionCtx, taskId: string, a: z.infer<typeof TaskActionSchema> | TaskAction): Promise<void> {
  switch (a.action) {
    case "complete":
      return completeTask(actx, taskId);
    case "dismiss":
      return dismissTask(actx, taskId, a.kind);
    case "reopen":
      return reopenTask(actx, taskId);
    case "snooze":
      return snoozeTask(actx, taskId, a.mode, a.until ?? null);
    case "unsnooze":
      return unsnoozeTask(actx, taskId);
    case "confirm":
      return confirmTask(actx, taskId);
    case "still_valid":
      return markStillValid(actx, taskId);
    case "would_have_missed":
      return markWouldHaveMissed(actx, taskId);
  }
}

/** Only the fields present in the request (undefined = unchanged). */
function toEdit(body: Partial<Record<keyof TaskEdit, unknown>>): TaskEdit {
  const edit: TaskEdit = {};
  for (const k of ["title", "status", "priority", "dueDate", "nextAction", "summary", "company", "counterpartyAddress", "counterpartyName"] as const) {
    if (body[k] !== undefined) (edit as Record<string, unknown>)[k] = body[k];
  }
  return edit;
}

export function registerTaskRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, clock } = ctx.deps;
  const full = { preHandler: requireAuth(ctx, "full") };

  const scopeOf = (request: FastifyRequest): QueryScope => {
    const auth = authOf(request);
    return { userId: auth.userId, timezone: auth.timezone, holySpiritHoliday: auth.holySpiritHoliday, now: clock.now() };
  };
  const actionCtx = (request: FastifyRequest, expectedVersion?: number): ActionCtx => ({
    db,
    clock,
    userId: authOf(request).userId,
    via: "web",
    ...(expectedVersion !== undefined ? { expectedVersion } : {}),
  });

  /** 404 unless the task belongs to the session user (checked before any engine call). */
  async function ownTask(request: FastifyRequest, raw: unknown): Promise<string> {
    const id = uuidParam(raw);
    if (!(await ownedTaskId(db, authOf(request).userId, id))) throw notFound();
    return id;
  }

  async function detailOrThrow(request: FastifyRequest, taskId: string): Promise<TaskDetail> {
    const d = await getTaskDetail(db, scopeOf(request), taskId);
    if (!d) throw notFound();
    return d;
  }

  app.get("/api/tasks", full, async (request) => {
    const q = parseWith(TaskListQuery, request.query);
    return listTasks(db, scopeOf(request), { tab: q.tab, company: q.company, q: q.q, review: q.review, limit: q.limit, cursor: q.cursor });
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id", full, async (request) => {
    return detailOrThrow(request, uuidParam(request.params.id));
  });

  app.post("/api/tasks", full, async (request) => {
    const body = parseWith(CreateTaskBody, request.body);
    let fromMessageId: string | null = null;
    if (body.fromMessageId) {
      if (!UUID_RE.test(body.fromMessageId)) throw notFound();
      const [m] = await db
        .select({ id: messages.id })
        .from(messages)
        .innerJoin(mailboxes, eq(mailboxes.id, messages.mailboxId))
        .where(and(eq(messages.id, body.fromMessageId), eq(mailboxes.userId, authOf(request).userId)))
        .limit(1);
      if (!m) throw notFound();
      fromMessageId = m.id;
    }
    const created = await createManualTask(actionCtx(request), { ...toEdit(body), title: body.title, status: body.status, fromMessageId });
    return { id: created.id, ref: created.ref };
  });

  app.patch<{ Params: { id: string } }>("/api/tasks/:id", full, async (request) => {
    const id = await ownTask(request, request.params.id);
    const body = parseWith(EditTaskBody, request.body);
    const edit = toEdit(body);
    if (Object.keys(edit).length === 0) throw badRequest("No changes");
    await editTask(actionCtx(request, body.version), id, edit);
    return detailOrThrow(request, id);
  });

  app.post<{ Params: { id: string } }>("/api/tasks/:id/actions", full, async (request) => {
    const id = await ownTask(request, request.params.id);
    const body = parseWith(TaskActionBody, request.body);
    await performTaskAction(actionCtx(request, body.version), id, body);
    return detailOrThrow(request, id);
  });

  app.post("/api/tasks/merge", full, async (request) => {
    const body = parseWith(MergeBody, request.body);
    const survivorId = await ownTask(request, body.survivorId);
    const mergedId = await ownTask(request, body.mergedId);
    if (survivorId === mergedId) throw badRequest("A task can't be merged with itself");
    await mergeTasks(actionCtx(request), survivorId, mergedId);
    return detailOrThrow(request, survivorId);
  });

  app.post("/api/tasks/bulk", full, async (request) => {
    const body = parseWith(BulkBody, request.body);
    const userId = authOf(request).userId;
    let done = 0;
    const conflicts: string[] = [];
    for (const raw of [...new Set(body.ids)]) {
      const id = UUID_RE.test(raw) ? raw.toLowerCase() : null;
      if (!id || !(await ownedTaskId(db, userId, id))) {
        conflicts.push(raw);
        continue;
      }
      try {
        await performTaskAction(actionCtx(request), id, body.action);
        done++;
      } catch (err) {
        if (err instanceof ConflictError || err instanceof NotFoundError) conflicts.push(raw);
        else throw err;
      }
    }
    return { done, conflicts };
  });

  app.post<{ Params: { eventId: string } }>("/api/suggestions/:eventId", full, async (request) => {
    const eventId = uuidParam(request.params.eventId);
    const body = parseWith(SuggestionBody, request.body);
    const taskId = await ownedEventTaskId(db, authOf(request).userId, eventId);
    if (!taskId) throw notFound();
    await resolveSuggestion(actionCtx(request), eventId, body.decision);
    return detailOrThrow(request, taskId);
  });

  app.get("/api/today", full, async (request) => {
    return getToday(db, scopeOf(request));
  });

  app.get("/api/companies", full, async (request) => {
    return { companies: await listCompanies(db, authOf(request).userId) };
  });
}

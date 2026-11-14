/**
 * Task edit/create form model. A user edit locks the edited fields against later AI changes,
 * so a PATCH must carry only the fields that actually changed (see diffTaskEdit).
 */
import type { Priority, TaskStatus } from "../../src/domain/types.js";
import type { CreateTaskRequest, EditTaskRequest, TaskDetail } from "../../src/server/api-types.js";
import { isIsoDate, looksLikeEmail } from "./format.js";
import { isOpen } from "./labels.js";

export interface TaskFormState {
  title: string;
  status: TaskStatus;
  priority: Priority;
  /** "" = no due date. */
  dueDate: string;
  nextAction: string;
  summary: string;
  company: string;
  counterpartyName: string;
  counterpartyAddress: string;
}

export type TaskEditPatch = Omit<EditTaskRequest, "version">;

export const EMPTY_TASK_FORM: TaskFormState = {
  title: "",
  status: "ACTION_REQUIRED",
  priority: "NORMAL",
  dueDate: "",
  nextAction: "",
  summary: "",
  company: "",
  counterpartyName: "",
  counterpartyAddress: "",
};

type EditableSource = Pick<
  TaskDetail,
  "title" | "status" | "priority" | "dueDate" | "nextAction" | "summary" | "company" | "counterpartyName" | "counterpartyAddress"
>;

export function formFromTask(task: EditableSource): TaskFormState {
  return {
    title: task.title,
    status: task.status,
    priority: task.priority,
    dueDate: task.dueDate ?? "",
    nextAction: task.nextAction ?? "",
    summary: task.summary ?? "",
    company: task.company ?? "",
    counterpartyName: task.counterpartyName ?? "",
    counterpartyAddress: task.counterpartyAddress ?? "",
  };
}

/** Trimmed text, with "" meaning null. */
function norm(value: string | null | undefined): string | null {
  const t = (value ?? "").trim();
  return t === "" ? null : t;
}

/** Only the fields whose value differs from the task (null and "" are the same "empty"). */
export function diffTaskEdit(task: EditableSource, form: TaskFormState): TaskEditPatch {
  const patch: TaskEditPatch = {};
  const title = form.title.trim();
  if (title && title !== task.title.trim()) patch.title = title;
  if (form.status !== task.status && isOpen(form.status)) patch.status = form.status;
  if (form.priority !== task.priority) patch.priority = form.priority;
  if (norm(form.dueDate) !== norm(task.dueDate)) patch.dueDate = norm(form.dueDate);
  if (norm(form.nextAction) !== norm(task.nextAction)) patch.nextAction = norm(form.nextAction);
  if (norm(form.summary) !== norm(task.summary)) patch.summary = norm(form.summary);
  if (norm(form.company) !== norm(task.company)) patch.company = norm(form.company);
  if (norm(form.counterpartyName) !== norm(task.counterpartyName)) patch.counterpartyName = norm(form.counterpartyName);
  const addr = norm(form.counterpartyAddress)?.toLowerCase() ?? null;
  if (addr !== (norm(task.counterpartyAddress)?.toLowerCase() ?? null)) patch.counterpartyAddress = addr;
  return patch;
}

export function isEmptyPatch(patch: TaskEditPatch): boolean {
  return Object.keys(patch).length === 0;
}

/** Validation message, or null when the form can be sent. */
export function validateTaskForm(form: TaskFormState): string | null {
  if (!form.title.trim()) return "The title is required.";
  if (form.title.trim().length > 300) return "The title is too long (300 characters at most).";
  if (form.dueDate && !isIsoDate(form.dueDate)) return "Invalid due date.";
  const addr = form.counterpartyAddress.trim();
  if (addr && !looksLikeEmail(addr)) return "Invalid contact email.";
  return null;
}

/** POST /api/tasks body from the new-task form (the form only offers open statuses). */
export function createRequestFromForm(form: TaskFormState, fromMessageId: string | null): CreateTaskRequest {
  const req: CreateTaskRequest = {
    title: form.title.trim(),
    status: isOpen(form.status) ? form.status : "ACTION_REQUIRED",
    priority: form.priority,
    dueDate: norm(form.dueDate),
    nextAction: norm(form.nextAction),
    company: norm(form.company),
    counterpartyName: norm(form.counterpartyName),
    counterpartyAddress: norm(form.counterpartyAddress)?.toLowerCase() ?? null,
    summary: norm(form.summary),
  };
  if (fromMessageId) req.fromMessageId = fromMessageId;
  return req;
}

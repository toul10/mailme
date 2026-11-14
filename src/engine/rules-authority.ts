import type { Operation } from "../ai/schema.js";
import { isOpenStatus, type LockableField, type TaskCardScope } from "../domain/types.js";
import { lockedFieldReason, R } from "./reconcile-reasons.js";

/** The task as the planner currently sees it (statuses evolve across the ops of one message). */
export interface AuthorityTask {
  status: string;
  closedBy: string | null;
  lockedFields: string[];
  scope: TaskCardScope;
  ownerRepliedInThreadAfterCreate: boolean;
}

export interface AuthoritySender {
  /** Effective direction: INBOUND, or a delivered copy claiming the owner as sender. */
  inbound: boolean;
  claimsOwnerSender: boolean;
}

export interface AuthorityVerdict {
  /** The op would be a no-op on the current state → log only. */
  log: string[];
  /** The op may not change the task by itself → suggestion (CREATE: created for review). */
  suggest: string[];
  /** Context worth recording, no effect on the decision. */
  info: string[];
}

/** UPDATE `changes` key → lockable task field. `expect_reply` and `add_items` are not lockable. */
export const UPDATE_FIELD_LOCKS = {
  status: "status",
  due: "dueDate",
  priority: "priority",
  next_action: "nextAction",
  summary: "summary",
} as const satisfies Record<string, LockableField>;

/**
 * Authority matrix and allowed status transitions. Evidence quality and tiers are not judged here.
 *
 * `changedFields`: for UPDATE, the lockable fields the op actually changes (a status equal to the current one must
 * already be removed by the caller).
 */
export function checkAuthority(op: Operation, task: AuthorityTask | null, sender: AuthoritySender, changedFields: LockableField[] = []): AuthorityVerdict {
  const v: AuthorityVerdict = { log: [], suggest: [], info: [] };
  const locked = (f: LockableField) => task?.lockedFields.includes(f) ?? false;
  const open = task ? isOpenStatus(task.status) : false;

  switch (op.op) {
    case "CREATE":
      // An inbound message can't commit the owner to anything.
      if (sender.inbound && op.status === "WAITING_FOR_ME") v.suggest.push(R.INBOUND_COMMITMENT);
      break;

    case "UPDATE": {
      if (!task) break;
      // closed → open only via REOPEN; a closed task's fields are frozen for the AI.
      if (!open) {
        v.suggest.push(R.TASK_CLOSED);
        break;
      }
      if (changedFields.includes("status") && sender.inbound) v.suggest.push(R.INBOUND_STATUS_CHANGE);
      // The owner's own promise date is the owner's to move.
      if (changedFields.includes("dueDate") && sender.inbound && task.status === "WAITING_FOR_ME") v.suggest.push(R.INBOUND_CHANGES_COMMITMENT);
      for (const f of changedFields) if (locked(f)) v.suggest.push(lockedFieldReason(f));
      if (task.scope === "RELATED_OPEN") v.suggest.push(R.CROSS_THREAD);
      break;
    }

    case "COMPLETE": {
      if (!task) break;
      if (!open) {
        v.log.push(R.ALREADY_CLOSED);
        break;
      }
      if (locked("status")) v.suggest.push(lockedFieldReason("status"));
      // Inbound may only close what the owner was waiting for; anything else is "Done already?".
      if (sender.inbound && task.status !== "WAITING_FOR_OTHER") {
        v.suggest.push(R.INBOUND_CANNOT_COMPLETE);
        if (task.ownerRepliedInThreadAfterCreate) v.info.push(R.OWNER_REPLIED_AFTER_CREATE);
      }
      if (task.scope === "RELATED_OPEN") v.suggest.push(R.CROSS_THREAD);
      break;
    }

    case "REOPEN": {
      if (!task) break;
      if (open) {
        v.log.push(R.NOT_CLOSED);
        break;
      }
      if (sender.inbound) v.suggest.push(R.INBOUND_REOPEN);
      if (task.closedBy === "user") v.suggest.push(R.USER_CLOSED);
      else if (task.closedBy !== "ai") v.suggest.push(R.NOT_AI_CLOSED);
      if (locked("status")) v.suggest.push(lockedFieldReason("status"));
      if (task.scope === "RELATED_OPEN") v.suggest.push(R.CROSS_THREAD);
      break;
    }

    case "SUGGEST_DISMISS": {
      if (!task) break;
      if (!open) {
        v.log.push(R.ALREADY_CLOSED);
        break;
      }
      v.suggest.push(R.SUGGEST_DISMISS);
      if (task.scope === "RELATED_OPEN") v.suggest.push(R.CROSS_THREAD);
      break;
    }
  }

  if (sender.claimsOwnerSender && v.suggest.length > 0) v.suggest.push(R.CLAIMS_OWNER_SENDER);
  return v;
}

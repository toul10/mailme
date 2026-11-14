import { describe, expect, it } from "vitest";
import { OPEN_STATUSES, PRIORITIES, TASK_STATUSES, FOLDER_ROLES, MAILBOX_STATUSES, EVENT_OPS } from "../../src/domain/types.js";
import {
  FILTER_BAR,
  FOLDER_ROLE_ORDER,
  LOCKABLE_FIELD_LABELS,
  MAILBOX_STATUS_LABELS,
  OPEN_STATUS_ORDER,
  PRIORITY_LABELS,
  PRIORITY_ORDER,
  STATUS_LABELS,
  TAB_LABELS,
  TAB_ORDER,
  eventOpLabel,
  evidenceSourceLabel,
  isListFilter,
  isOpen,
  isTaskTab,
  linkRoleLabel,
} from "../../web/src/labels.js";

describe("English labels", () => {
  it("names every status in the user's words and every priority", () => {
    expect(Object.keys(STATUS_LABELS).sort()).toEqual([...TASK_STATUSES].sort());
    expect(STATUS_LABELS).toEqual({
      ACTION_REQUIRED: "Asked of you",
      WAITING_FOR_ME: "You promised",
      WAITING_FOR_OTHER: "Waiting on others",
      COMPLETED: "Done",
      DISMISSED: "Removed",
    });
    // The same field name as the task page's facts.
    expect(LOCKABLE_FIELD_LABELS.nextAction).toBe("Next step");
    expect(PRIORITY_ORDER).toEqual([...PRIORITIES]);
    expect(PRIORITY_ORDER.map((p) => PRIORITY_LABELS[p])).toEqual(["Urgent", "High", "Normal", "Low"]);
  });

  it("offers only open statuses for editing", () => {
    expect(OPEN_STATUS_ORDER).toEqual([...OPEN_STATUSES]);
    expect(isOpen("WAITING_FOR_OTHER")).toBe(true);
    expect(isOpen("COMPLETED")).toBe(false);
  });

  it("shows the brief's five segments; other filters only by link", () => {
    expect(FILTER_BAR.map((t) => TAB_LABELS[t])).toEqual(["Open", "Waiting", "Colleagues", "Closed", "Earlier"]);
    // “To do” on Today is only what was asked of you; the todo tab also holds promises.
    expect(TAB_LABELS.todo).not.toBe("To do");
    expect(TAB_ORDER).toContain("snoozed");
    expect(isTaskTab("closed")).toBe(true);
    expect(isTaskTab("snoozed")).toBe(false);
    expect(isListFilter("snoozed")).toBe(true);
    expect(isTaskTab("done")).toBe(false);
    expect(isTaskTab(null)).toBe(false);
  });

  it("covers folder roles, mailbox statuses and every event op", () => {
    expect(FOLDER_ROLE_ORDER).toEqual([...FOLDER_ROLES]);
    expect(Object.keys(MAILBOX_STATUS_LABELS).sort()).toEqual([...MAILBOX_STATUSES].sort());
    for (const op of EVENT_OPS) expect(eventOpLabel(op)).not.toBe(op);
    expect(eventOpLabel("SOMETHING_NEW")).toBe("SOMETHING_NEW");
  });

  it("falls back to raw codes for unknown sources and roles", () => {
    expect(evidenceSourceLabel("ATTACHMENT_NAME")).toBe("Attachment name");
    expect(evidenceSourceLabel("X")).toBe("X");
    expect(evidenceSourceLabel(null)).toBeNull();
    expect(linkRoleLabel("origin")).toBe("Start");
    expect(linkRoleLabel("weird")).toBe("weird");
  });
});

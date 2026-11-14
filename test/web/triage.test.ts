import { describe, expect, it } from "vitest";
import type { TaskEventView, TaskListItem } from "../../src/server/api-types.js";
import { describeChanges, latestReviewedChange, parseChangeSummary, reviewKind, triageCopy, type TriageCopy, type TriageInput } from "../../web/src/triage.js";

const TODAY = "2026-09-24";
const person = (name: string, o: Partial<{ isOwner: boolean; isInternal: boolean }> = {}) => ({ name, address: `${name}@x-gr.example`, isOwner: false, isInternal: false, ...o });

type Task = TriageInput["task"];
const task = (o: Partial<Task> = {}): Task => ({
  status: "ACTION_REQUIRED",
  reviewCodes: [],
  dueDate: null,
  evidence: { quote: "μπορείτε να μας στείλετε προσφορά;", source: "NEW", messageId: "m1", author: person("Μαρία"), at: "2026-09-21T08:00:00Z" },
  originEvidence: null,
  lastMessage: { author: person("Μαρία"), at: "2026-09-21T08:00:00Z", subject: "Προσφορά", direction: "INBOUND" },
  ...o,
});
const review = (t: Partial<Task>, place: "today" | "task" = "today", change: string | null = null) => triageCopy({ kind: "review", suggestion: null, task: task(t), place, today: TODAY, change });
const suggestion = (op: string, summary: string, t: Partial<Task> = {}, o: Partial<TaskEventView> = {}) =>
  triageCopy({ kind: "suggestion", suggestion: { op, summary, author: person("Νίκος", { isInternal: true }), reasons: [], ...o } as TaskEventView, task: task(t), place: "today", today: TODAY });

const effects = (c: TriageCopy) => c.answers.map((a) => (a.effect.type === "action" ? `${a.effect.action.action}${"kind" in a.effect.action ? `:${a.effect.action.kind}` : ""}` : a.effect.type === "suggestion" ? a.effect.decision : a.effect.type));
const teachesNotATask = (c: TriageCopy) => c.answers.some((a) => a.effect.type === "action" && a.effect.action.action === "dismiss" && a.effect.action.kind === "not_a_task");

describe("review questions follow why the AI asks", () => {
  it("a bounce says so, and no answer dismisses the task", () => {
    const c = review({ reviewCodes: ["bounce"], status: "WAITING_FOR_OTHER" });
    expect(c.tone).toBe("warn");
    expect(c.lead).toBe("Your email wasn't delivered.");
    expect(c.answers.map((a) => a.label)).toEqual(["I'll take a look", "OK"]);
    expect(effects(c)).toEqual(["open", "confirm"]);
    // Also on a task the bounced reply had auto-completed, and on the task page itself.
    expect(effects(review({ reviewCodes: ["bounce"], status: "COMPLETED" }, "task"))).toEqual(["confirm"]);
  });

  it("a forged or suspicious email is a warning whose “no” is not “not a task”", () => {
    const spoof = review({ reviewCodes: ["claims_owner_sender", "message_review"] });
    expect(spoof.tone).toBe("warn");
    expect(spoof.lead).toMatch(/^This email may not be genuine/);
    expect(effects(spoof)).toEqual(["confirm", "dismiss:other"]);
    expect(spoof.answers[1]!.undo).toBe(true);
    expect(review({ reviewCodes: ["suspicious_instructions"] }).lead).toMatch(/instructions for the system/);
    expect(teachesNotATask(spoof)).toBe(false);
  });

  it("only doubt about the task itself asks “Does something need to be done?”, and its “No” asks first", () => {
    const c = review({ reviewCodes: ["implied", "due_disagrees"] });
    expect(c.question).toBe("Does something need to be done?");
    expect(effects(c)).toEqual(["confirm", "dismiss:not_a_task"]);
    expect(c.answers[1]!.confirm).toMatchObject({ confirmLabel: "Remove", danger: true });
    expect(c.answers[1]!.done).toBe("Removed");
  });

  it("not being the addressee offers “someone else has it” (no lesson for the AI)", () => {
    const c = review({ reviewCodes: ["owner_cc"] });
    expect(c.lead).toBe("You were only in Cc.");
    expect(effects(c)).toEqual(["confirm", "dismiss:handled_by_other"]);
  });

  it("date doubt asks about the date and “No” opens the edit form", () => {
    const c = review({ reviewCodes: ["due_disagrees"], dueDate: "2026-09-29" });
    expect(c.lead).toBe("The AI isn't sure about the due date (Tue 29 Sep).");
    expect(effects(c)).toEqual(["confirm", "edit"]);
  });

  it("a change the AI made from a reviewed message names it; “No” opens edit", () => {
    const later = { at: "2026-09-23T10:00:00Z", author: person("Μαρία"), subject: "Re: Προσφορά", direction: "INBOUND" as const };
    const c = review({ reviewCodes: ["message_review", "class_mismatch"], lastMessage: later });
    expect(c.lead).toBe("A newer email in the conversation needs a look.");
    expect(effects(c)).toEqual(["confirm", "edit"]);
    const named = review({ reviewCodes: ["message_review"] }, "task", "Due date → 29 Sep 2026");
    expect(named.lead).toBe("The AI changed: new due date Tue 29 Sep.");
    expect(named.question).toBe("Is that right?");
  });

  it("anything else (including no codes from an older server) never dismisses", () => {
    for (const codes of [[], ["message_review"], ["late_message"], ["something_new"]]) {
      const today = review({ reviewCodes: codes });
      expect(effects(today)).toEqual(["confirm", "open"]);
      expect(effects(review({ reviewCodes: codes }, "task"))).toEqual(["confirm", "edit"]);
      expect(teachesNotATask(today)).toBe(false);
    }
    expect(review({ reviewCodes: ["class_mismatch", "message_review"] }).lead).toBe("The email looked informational or automated.");
  });

  it("closed tasks only get acknowledged", () => {
    for (const codes of [["implied"], ["message_review"], ["claims_owner_sender"]]) {
      expect(effects(review({ reviewCodes: codes, status: "COMPLETED" }, "task"))).toEqual(["confirm"]);
    }
  });

  it("classifies codes with parameters and in priority order", () => {
    expect(reviewKind(["locked_field:dueDate", "bounce"], { open: true, changed: false })).toBe("bounce");
    expect(reviewKind(["implied", "claims_owner_sender"], { open: true, changed: false })).toBe("spoof");
    expect(reviewKind(["message_review"], { open: true, changed: false })).toBe("check");
    expect(reviewKind(["message_review"], { open: true, changed: true })).toBe("changed");
  });
});

describe("suggestion questions", () => {
  it("a colleague's completion is a plain question (the quote carries who wrote it)", () => {
    const c = suggestion("COMPLETE", "Done already?");
    expect(c.lead).toBeNull();
    expect(c.question).toBe("Looks like a colleague did it. Close it?");
    expect(c.answers.map((a) => [a.label, a.done])).toEqual([
      ["Yes, it's done", "Closed"],
      ["No, keep it open", "Stays open"],
    ]);
  });

  it("a question that no longer applies is acknowledged, not asked again", () => {
    const reopen = suggestion("REOPEN", "Suggestion: reopen", { status: "ACTION_REQUIRED" });
    expect(reopen.question).toBe("It's already been reopened.");
    expect(effects(reopen)).toEqual(["reject"]);
    expect(suggestion("REOPEN", "", { status: "COMPLETED" }).question).toBe("Looks like it wasn't done after all. Reopen it?");
    expect(suggestion("COMPLETE", "", { status: "DISMISSED" }).question).toBe("It's already closed.");
    expect(suggestion("SUGGEST_DISMISS", "", { status: "COMPLETED" }).question).toBe("It's already closed.");
  });

  it("an update reads as a sentence, with the value it would replace and no doubled prefix", () => {
    const c = suggestion("UPDATE", "Suggestion: Due date → 20 Sep 2026", { dueDate: TODAY }, { reasons: ["You changed “Due date” yourself"] });
    expect(c.lead).toBe("The AI suggests: new due date Sun 20 Sep (currently Thu 24 Sep). You had changed it yourself, so the AI is asking.");
    expect(c.question).toBe("Make this change?");
    expect(c.lead).not.toMatch(/Suggestion/);
    expect(effects(c)).toEqual(["accept", "reject"]);
  });

  it("a status change names the status in the user's words", () => {
    expect(suggestion("UPDATE", "Suggestion: Status → You promised").question).toBe("Move it to “You promised”?");
    expect(suggestion("UPDATE", "Suggestion: Status → Waiting on others", { status: "COMPLETED" }).question).toBe("Reopen it as “Waiting on others”?");
    expect(suggestion("UPDATE", "Suggested change").question).toBe("The AI suggests a change. Make it?");
    expect(suggestion("UPDATE", "Suggestion: Due date → 20 Sep 2026", { status: "COMPLETED" }).question).toBe("It's already closed.");
  });
});

describe("change summaries", () => {
  it("parses every fragment the server writes and keeps unknown ones", () => {
    expect(
      parseChangeSummary("Suggestion: Status → Asked of you · Due date → none · Due date → “ως την Τρίτη” · Priority → Urgent · Next step → Call Maria · Summary updated · Company → ABC · Reply expected by → 30 Sep 2026 · Something else"),
    ).toEqual([
      { field: "status", value: "ACTION_REQUIRED" },
      { field: "dueDate", value: null },
      { field: "duePhrase", value: "ως την Τρίτη" },
      { field: "priority", value: "Urgent" },
      { field: "nextAction", value: "Call Maria" },
      { field: "summary", value: null },
      { field: "company", value: "ABC" },
      { field: "expectReplyBy", value: "2026-09-30" },
      { field: "other", value: "Something else" },
    ]);
    expect(parseChangeSummary("Due date → 29/09/2026 · Title updated · Contact updated")).toEqual([
      { field: "dueDate", value: "2026-09-29" },
      { field: "title", value: null },
      { field: "counterparty", value: null },
    ]);
    expect(parseChangeSummary("Suggested change")).toEqual([]);
    expect(parseChangeSummary(null)).toEqual([]);
  });

  it("describes changes as phrases", () => {
    expect(describeChanges(parseChangeSummary("Status → You promised · Next step removed"), null, TODAY)).toEqual(["status “You promised”", "no next step"]);
    expect(describeChanges(parseChangeSummary("Due date → none"), { dueDate: "2026-09-25" }, TODAY)).toEqual(["no due date (currently Fri 25 Sep)"]);
  });

  it("finds the last change the AI applied while unsure", () => {
    const ev = (o: Partial<TaskEventView>) => ({ actor: "ai", applied: true, tier: "review", op: "UPDATE", summary: "Due date → 29 Sep 2026", createdAt: "2026-09-22T10:00:00Z", ...o }) as TaskEventView;
    expect(latestReviewedChange([ev({ op: "CREATE", summary: "Created from email" }), ev({}), ev({ tier: "auto", createdAt: "2026-09-23T10:00:00Z" })])).toBe("Due date → 29 Sep 2026");
    expect(latestReviewedChange([ev({ applied: false })])).toBeNull();
  });
});

// Keep the Pick in sync with what the cards pass (a compile-time check).
const _full: TriageInput["task"] = {} as TaskListItem;
void _full;

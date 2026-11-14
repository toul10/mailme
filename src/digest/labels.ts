import { dayMonth } from "./calendar.js";

/** Display tags (also used by the renderer to decide which one-click links to show). */
export const TAG = {
  review: "⚠️ To check",
  urgent: "Urgent",
  high: "High priority",
  resurfaced: "Back from snooze",
  stillValid: "Still valid?",
  promised: (due: string) => `Promised for ${dayMonth(due)}`,
  replyBy: (d: string) => `Reply expected by ${dayMonth(d)}`,
  bounce: (to: string | null) => (to ? `⚠️ Not delivered to ${to}` : "⚠️ Not delivered"),
} as const;

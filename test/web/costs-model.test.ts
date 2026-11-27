import { describe, expect, it } from "vitest";
import type { AiCostDay, AiCosts } from "../../src/server/api-types.js";
import {
  cappedDays,
  costSeries,
  dayTotal,
  formatTick,
  formatUsd,
  labelledDays,
  launchPricesInUse,
  mailboxSince,
  meterTone,
  modelLabel,
  niceScale,
  perMail,
  priceSource,
  seriesValue,
  sumDays,
} from "../../web/src/costs-model.js";
import { billedShare } from "../../src/ai/pricing.js";

const day = (date: string, mail: Record<string, number>, chat = 0, mails = 0, questions = 0): AiCostDay => ({ date, mail, chat, mails, questions });

describe("costs-model", () => {
  it("formatUsd: small amounts, per-email precision", () => {
    expect(formatUsd(14.845)).toBe("$14.85");
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.004)).toBe("< $0.01");
    expect(formatUsd(0.0102, 3)).toBe("$0.010");
    expect(formatUsd(1234.5)).toBe("$1,234.50");
    expect(formatUsd(Number.NaN)).toBe("$0.00");
  });

  it("modelLabel", () => {
    expect(modelLabel("gemini-3.5-flash-lite")).toBe("Gemini 3.5 Flash-Lite");
    expect(modelLabel("claude-opus-5-5")).toBe("Claude Opus 5.5");
    expect(modelLabel("some-model")).toBe("some-model");
  });

  it("priceSource: the price table, the provider's own figure, or the deliberately high ceiling", () => {
    expect(priceSource("claude-sonnet-5")).toBe("table");
    expect(priceSource("claude-haiku-4-5-20251001")).toBe("table");
    expect(priceSource("gemini-3.5-flash-lite")).toBe("table");
    expect(priceSource("gemini-9-unlisted")).toBe("ceiling");
    expect(priceSource("grok-5")).toBe("reported");
    expect(priceSource("gpt-6")).toBe("ceiling");
    // Only Gemini has launch prices: a Claude or OpenAI call is shown at its stored cost.
    expect(billedShare("claude-opus-5", new Date("2026-11-27T10:00:00Z"))).toBe(1);
    expect(billedShare("gpt-6", new Date("2026-11-27T10:00:00Z"))).toBe(1);
  });

  it("series: colours follow the mailbox's place; the chat is always slot 3; past six mailboxes the rest fold", () => {
    const mailboxes = Array.from({ length: 8 }, (_, i) => ({ id: `m${i}`, address: `m${i}@x-gr.example` })) as AiCosts["mailboxes"];
    const days = [day("2026-11-27", { m1: 1, m6: 2, m7: 3 }, 0.5)];
    const s = costSeries({ mailboxes, days }, new Map([["m1", "purchasing"]]));
    expect(s).toEqual([
      { key: "m1", label: "purchasing", slot: 2 },
      { key: "chat", label: "Ask your mail", slot: 3 },
      { key: "other", label: "Other mailboxes", slot: 8 },
    ]);
    const shown = new Set(["m0", "m1", "m2", "m3", "m4", "m5"]);
    expect(seriesValue(days[0]!, s[2]!, shown)).toBe(5);
    expect(seriesValue(days[0]!, s[1]!, shown)).toBe(0.5);
    expect(dayTotal(days[0]!)).toBe(6.5);
  });

  it("sumDays from a date on", () => {
    const days = [day("2026-10-31", { a: 1 }, 0, 3), day("2026-11-01", { a: 2, b: 1 }, 0.5, 4, 2), day("2026-11-02", {}, 0.25, 0, 1)];
    expect(sumDays(days, "2026-11-01")).toEqual({ mail: 3, chat: 0.75, mails: 4, questions: 3 });
    expect(sumDays(days).mail).toBe(4);
    expect(mailboxSince(days, "a", "2026-11-01")).toBe(2);
    expect(mailboxSince(days, "b")).toBe(1);
    expect(mailboxSince(days, "c")).toBe(0);
  });

  it("niceScale: round steps that cover the maximum", () => {
    expect(niceScale(5.41)).toEqual({ top: 6, ticks: [0, 2, 4, 6] });
    expect(niceScale(9.418)).toEqual({ top: 10, ticks: [0, 2.5, 5, 7.5, 10] });
    expect(niceScale(0.37)).toEqual({ top: 0.4, ticks: [0, 0.1, 0.2, 0.3, 0.4] });
    expect(niceScale(0)).toEqual({ top: 1, ticks: [0, 0.5, 1] });
    expect(formatTick(2.5)).toBe("$2.5");
    expect(formatTick(0.05)).toBe("$0.05");
    expect(formatTick(6)).toBe("$6");
  });

  it("labelledDays: all of a short run; else the first, every 7th back from today, today", () => {
    expect([...labelledDays(Array.from({ length: 8 }, (_, i) => day(`d${i}`, {})))].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect([...labelledDays(Array.from({ length: 30 }, (_, i) => day(`d${i}`, {})))].sort((a, b) => a - b)).toEqual([0, 8, 15, 22, 29]);
  });

  it("cappedDays: the highest day, and today unless it is right next to it", () => {
    expect([...cappedDays([1, 5, 2, 0, 0, 3])]).toEqual([1, 5]);
    expect([...cappedDays([1, 2, 5, 2, 3])]).toEqual([2]);
    expect([...cappedDays([1, 2, 5])]).toEqual([2]);
    expect([...cappedDays([5, 1, 1, 1, 0])]).toEqual([0]);
    expect([...cappedDays([0, 0])]).toEqual([]);
    expect([...cappedDays([])]).toEqual([]);
  });

  it("launchPricesInUse: from the price table, only while in force and only for models in use", () => {
    const at = (iso: string) => new Date(iso);
    expect(launchPricesInUse(["gemini-3.5-flash-lite", "gemini-3.8-flash"], at("2026-11-27T10:00:00Z"))).toEqual([
      { model: "gemini-3.8-flash", factor: 0.5, lastDay: "2026-12-31", from: "2027-01-01" },
    ]);
    expect(launchPricesInUse(["gemini-3.8-flash"], at("2027-01-01T00:00:00Z"))).toEqual([]);
    expect(launchPricesInUse(["gemini-3.5-flash-lite"], at("2026-11-27T10:00:00Z"))).toEqual([]);
  });

  it("perMail of the model used last, and the meter tones", () => {
    expect(perMail({ models: [] })).toBeNull();
    expect(perMail({ models: [{ model: "gemini-3.5-flash-lite", mails: 193, calls: 193, usd: 1.987, firstDay: "", lastDay: "" }] })).toEqual({ model: "gemini-3.5-flash-lite", usd: 1.987 / 193 });
    expect([meterTone(0.5), meterTone(0.8), meterTone(1)]).toEqual(["ok", "warn", "danger"]);
  });
});

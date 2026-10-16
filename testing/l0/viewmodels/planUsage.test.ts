import { describe, expect, test } from "bun:test";
import type { DriverPlanUsage, PlanUsageReport, PlanWindow } from "@harness/shared";
import {
  duration, elapsedFraction, filterChoices, formatPercent, limitedText, parseFilter, parseMode, projectedFill, projectedTone, projectedUse, resetText, rowFor, rowsFor, updatedText, usedTone,
} from "../../../app/src/renderer/state/planUsage";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const win = (o: Partial<PlanWindow> = {}): PlanWindow => ({ id: "five_hour", label: "5-hour", usedPercent: 40, resetsAt: NOW + 2.5 * HOUR, windowSeconds: 5 * 3600, ...o });
const driver = (o: Partial<DriverPlanUsage> = {}): DriverPlanUsage => ({ driver: "claude-code", name: "Claude Code", windows: [win()], status: "ok", error: null, fetchedAt: NOW, ...o });

describe("tones and percent", () => {
  test("usedTone bands at 75 and 90", () => {
    expect([0, 74.9, 75, 89.9, 90, 100].map(usedTone)).toEqual(["neutral", "neutral", "amber", "amber", "red", "red"]);
  });
  test("projectedTone: green below 90, amber to 100 inclusive, red over", () => {
    expect([89.9, 90, 100, 100.1].map(projectedTone)).toEqual(["green", "amber", "amber", "red"]);
  });
  test("projectedFill puts 100 on the tick and clamps", () => {
    expect(projectedFill(100)).toBe(80);
    expect(projectedFill(75)).toBe(50);
    expect(projectedFill(10)).toBe(0);
    expect(projectedFill(500)).toBe(100);
  });
  test("formatPercent rounds and clamps to 0..999", () => {
    expect(formatPercent(62.5)).toBe("63%");
    expect(formatPercent(-3)).toBe("0%");
    expect(formatPercent(5000)).toBe("999%");
  });
});

describe("elapsedFraction / projectedUse", () => {
  test("halfway through the window", () => {
    expect(elapsedFraction(win(), NOW)).toBeCloseTo(0.5);
  });
  test("a reset in the past or a zero-length window is a fresh window", () => {
    expect(elapsedFraction(win({ resetsAt: NOW }), NOW)).toBe(0);
    expect(elapsedFraction(win({ resetsAt: NOW - 1 }), NOW)).toBe(0);
    expect(elapsedFraction(win({ windowSeconds: 0 }), NOW)).toBe(0);
  });
  test("a reset further out than the window clamps to 0", () => {
    expect(elapsedFraction(win({ resetsAt: NOW + 10 * HOUR }), NOW)).toBe(0);
  });
  test("projection is withheld before 10% of the window and divides after", () => {
    expect(projectedUse(5, 0.09)).toBeNull();
    expect(projectedUse(5, 0.1)).toBe(50);
    expect(projectedUse(40, 0.5)).toBe(80);
  });
});

describe("text helpers", () => {
  test("duration rounds up to a minute and splits hours", () => {
    expect(duration(1)).toBe("1m");
    expect(duration(0)).toBe("1m");
    expect(duration(14 * MIN)).toBe("14m");
    expect(duration(2 * HOUR + 14 * MIN)).toBe("2h 14m");
    expect(duration(2 * HOUR + 14 * MIN + 1)).toBe("2h 15m");
    expect(duration(HOUR)).toBe("1h 0m");
  });
  test("resetText: now/past is resetting, under a day is a countdown, a day or more names a weekday", () => {
    expect(resetText(NOW, NOW)).toBe("resetting…");
    expect(resetText(NOW - 5, NOW)).toBe("resetting…");
    expect(resetText(NOW + 2 * HOUR + 14 * MIN, NOW)).toBe("resets in 2h 14m");
    expect(resetText(NOW + 24 * HOUR - MIN, NOW)).toBe("resets in 23h 59m");
    expect(resetText(NOW + 24 * HOUR, NOW)).toMatch(/^resets (Mon|Tue|Wed|Thu|Fri|Sat|Sun) \S/);
  });
  test("limitedText adds the weekday only a day or more out", () => {
    expect(limitedText(NOW + HOUR, NOW)).toMatch(/^Limited until \d/);
    expect(limitedText(NOW + 24 * HOUR - 1, NOW)).toMatch(/^Limited until \d/);
    expect(limitedText(NOW + 24 * HOUR, NOW)).toMatch(/^Limited until (Mon|Tue|Wed|Thu|Fri|Sat|Sun) /);
  });
  test("updatedText: just now under a minute, minutes under an hour, then hours; a future stamp is just now", () => {
    expect(updatedText(NOW - 59_999, NOW)).toBe("updated just now");
    expect(updatedText(NOW + 5 * MIN, NOW)).toBe("updated just now");
    expect(updatedText(NOW - 3 * MIN, NOW)).toBe("updated 3m ago");
    expect(updatedText(NOW - 59 * MIN, NOW)).toBe("updated 59m ago");
    expect(updatedText(NOW - 2 * HOUR - 30 * MIN, NOW)).toBe("updated 2h ago");
  });
});

describe("rowFor", () => {
  test("used mode: percent, tone by band, no tick", () => {
    const r = rowFor(win({ usedPercent: 80 }), "used", NOW, NOW);
    expect(r).toMatchObject({ id: "five_hour", fill: 80, tick: false, tone: "amber", text: "80% used", reset: "resets in 2h 30m" });
    expect(r.title).toBe("5-hour: 80% used, resets in 2h 30m. updated just now");
  });
  test("a full window is limited, red, and names when it's back", () => {
    const r = rowFor(win({ usedPercent: 100 }), "used", NOW, NOW);
    expect(r).toMatchObject({ fill: 100, tick: false, tone: "red", text: "100% used" });
    expect(r.reset).toStartWith("Limited until");
  });
  test("an overage above 100 clamps to the full bar", () => {
    expect(rowFor(win({ usedPercent: 130 }), "used", NOW, NOW)).toMatchObject({ fill: 100, text: "100% used" });
  });
  test("a window that already reset reads as fresh, not limited", () => {
    const r = rowFor(win({ usedPercent: 100, resetsAt: NOW - 1 }), "used", NOW, NOW);
    expect(r).toMatchObject({ fill: 0, text: "0% used", tone: "neutral", reset: "resetting…" });
  });
  test("projected mode too early to project", () => {
    // 2% of the window gone
    const r = rowFor(win({ usedPercent: 2, resetsAt: NOW + 4.9 * HOUR }), "projected", NOW, NOW);
    expect(r).toMatchObject({ tick: false, text: "2% used · too early to project", fill: 2 });
  });
  test("projected mode on pace: fill from the projection, tick shown, tone green", () => {
    const r = rowFor(win({ usedPercent: 40 }), "projected", NOW, NOW);
    expect(r).toMatchObject({ tick: true, tone: "green", text: "on pace for 80% · 40% used" });
    expect(r.fill).toBeCloseTo(56);
    expect(r.title).toContain("50% of the window gone");
  });
  test("projected over the limit is red", () => {
    expect(rowFor(win({ usedPercent: 60 }), "projected", NOW, NOW).tone).toBe("red");
  });
  test("the noun follows the window: week for long windows, month for monthly", () => {
    const week = rowFor(win({ id: "seven_day", windowSeconds: 7 * 86_400, resetsAt: NOW + 3.5 * 86_400 }), "projected", NOW, NOW);
    expect(week.title).toContain("of the week gone");
    const month = rowFor(win({ id: "monthly", windowSeconds: 30 * 86_400, resetsAt: NOW + 15 * 86_400 }), "projected", NOW, NOW);
    expect(month.title).toContain("of the month gone");
    const shortSeven = rowFor(win({ id: "seven_day", windowSeconds: 5 * 86_400, resetsAt: NOW + 2.5 * 86_400 }), "projected", NOW, NOW);
    expect(shortSeven.title).toContain("of the window gone");
  });
});

describe("rowsFor / filterChoices", () => {
  const claude = driver();
  const copilot = driver({ driver: "copilot", name: "Copilot", windows: [win({ id: "monthly", label: "Monthly" })] });
  const report: PlanUsageReport = { drivers: [claude, copilot] };

  test("no report or the hide filter shows nothing", () => {
    expect(rowsFor(null, "all", "used", NOW)).toEqual([]);
    expect(rowsFor(report, "hide", "used", NOW)).toEqual([]);
  });
  test("all shows every driver; a driver id shows just that one; an unknown id shows none", () => {
    expect(rowsFor(report, "all", "used", NOW).map((d) => d.driver)).toEqual(["claude-code", "copilot"]);
    expect(rowsFor(report, "copilot", "used", NOW).map((d) => d.driver)).toEqual(["copilot"]);
    expect(rowsFor(report, "gone", "used", NOW)).toEqual([]);
  });
  test("a driver without windows gives its error, else a status note, else is dropped", () => {
    const rows = rowsFor(
      { drivers: [driver({ windows: [], error: "Sign in to Claude Code to see plan usage", status: "limited" }), driver({ driver: "b", windows: [], status: "limited" }), driver({ driver: "c", windows: [], status: "near_limit" }), driver({ driver: "d", windows: [], status: "ok" })] },
      "all", "used", NOW,
    );
    expect(rows.map((r) => r.note)).toEqual(["Sign in to Claude Code to see plan usage", "Limited", "Near the limit"]);
    expect(rows.every((r) => r.rows.length === 0)).toBe(true);
  });
  test("choices list All, each driver, Hide; a stored driver that went quiet stays", () => {
    expect(filterChoices(report, "all").map((c) => c.id)).toEqual(["all", "claude-code", "copilot", "hide"]);
    expect(filterChoices(report, "codex")).toContainEqual({ id: "codex", label: "codex" });
    expect(filterChoices(report, "hide").map((c) => c.id)).toEqual(["all", "claude-code", "copilot", "hide"]);
    expect(filterChoices(null, "all").map((c) => c.id)).toEqual(["all", "hide"]);
  });
});

describe("parseMode / parseFilter", () => {
  test("tolerates anything", () => {
    expect(parseMode("projected")).toBe("projected");
    expect([parseMode("used"), parseMode(null), parseMode(3), parseMode("x")]).toEqual(["used", "used", "used", "used"]);
    expect(parseFilter("copilot")).toBe("copilot");
    expect([parseFilter(""), parseFilter(null), parseFilter(7)]).toEqual(["all", "all", "all"]);
  });
});

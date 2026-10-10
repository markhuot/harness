import { describe, expect, test } from "bun:test";
import type { DriverPlanUsage, PlanUsageReport, PlanWindow } from "@harness/shared";
import { DEFAULT_LAYOUT, parseLayout } from "./layout";
import { elapsedFraction, filterChoices, limitedText, projectedFill, projectedTone, projectedUse, resetText, rowFor, rowsFor, updatedText, usedTone } from "./planUsage";

const H = 3_600_000;
const NOW = new Date(2026, 9, 7, 12, 0, 0).getTime(); // a Wednesday, local noon
const WEEK = 7 * 86_400;

/** A weekly window `elapsed` of the way through, `used`% used. */
const week = (used: number, elapsed: number, over: Partial<PlanWindow> = {}): PlanWindow => ({
  id: "seven_day",
  label: "Weekly",
  usedPercent: used,
  resetsAt: NOW + (1 - elapsed) * WEEK * 1000,
  windowSeconds: WEEK,
  ...over,
});
const driver = (over: Partial<DriverPlanUsage> = {}): DriverPlanUsage => ({ driver: "claude-code", name: "Claude Code", windows: [], status: null, error: null, fetchedAt: NOW - 3 * 60_000, ...over });

describe("colour bands", () => {
  test("used so far: neutral < 75, amber from 75, red from 90", () => {
    expect([74.9, 75, 89.9, 90, 100].map(usedTone)).toEqual(["neutral", "amber", "amber", "red", "red"]);
  });
  test("projected: green to 90, amber 90–100, red over 100", () => {
    expect([89.9, 90, 100, 100.1].map(projectedTone)).toEqual(["green", "amber", "amber", "red"]);
  });
});

describe("projected bar", () => {
  test("100% projected fills to the 80% tick, 75% fills half", () => {
    expect(projectedFill(100)).toBeCloseTo(80);
    expect(projectedFill(75)).toBeCloseTo(50);
  });
  test("about 117% fills the bar and more stays clamped; low use is empty", () => {
    expect(projectedFill(116.7)).toBeCloseTo(100, 0);
    expect(projectedFill(400)).toBe(100);
    expect(projectedFill(33)).toBe(0);
    expect(projectedFill(10)).toBe(0);
  });
});

describe("elapsed and projection", () => {
  test("elapsed comes from resetsAt and windowSeconds", () => {
    expect(elapsedFraction(week(0, 0.8), NOW)).toBeCloseTo(0.8);
  });
  test("a reset in the past is a fresh window", () => {
    expect(elapsedFraction({ resetsAt: NOW - 1000, windowSeconds: WEEK }, NOW)).toBe(0);
  });
  test("the 10% guard: just below gives no projection, at it projects", () => {
    expect(projectedUse(5, 0.0999)).toBeNull();
    expect(projectedUse(5, 0.1)).toBeCloseTo(50);
  });
});

describe("rowFor", () => {
  test("used so far: percent text, tone, no tick", () => {
    const r = rowFor(week(80, 0.5), "used", NOW, NOW);
    expect(r).toMatchObject({ fill: 80, tick: false, tone: "amber", text: "80% used" });
  });
  test("50% used 80% through the week projects to 63%: green, tick, accessibility says 80% of the week gone", () => {
    const r = rowFor(week(50, 0.8), "projected", NOW, NOW - 3 * 60_000);
    expect(r.text).toBe("on pace for 63% · 50% used");
    expect(r.tone).toBe("green");
    expect(r.tick).toBe(true);
    expect(r.fill).toBeCloseTo(1.2 * 62.5 - 40);
    expect(r.title).toContain("80% of the week gone");
    expect(r.title).toContain("updated 3m ago");
  });
  test("50% used a quarter through projects to 200%: red and full", () => {
    const r = rowFor(week(50, 0.25), "projected", NOW, NOW);
    expect(r).toMatchObject({ text: "on pace for 200% · 50% used", tone: "red", fill: 100 });
  });
  test("amber band: 92% projected", () => {
    expect(rowFor(week(46, 0.5), "projected", NOW, NOW).tone).toBe("amber");
  });
  test("before 10% of the window it shows used so far with 'too early to project'", () => {
    const r = rowFor(week(2, 0.05), "projected", NOW, NOW);
    expect(r).toMatchObject({ fill: 2, tick: false, tone: "neutral", text: "2% used · too early to project" });
  });
  test("already at 100% is red and Limited until, in both modes", () => {
    for (const mode of ["used", "projected"] as const) {
      const r = rowFor(week(100, 0.5), mode, NOW, NOW);
      expect(r).toMatchObject({ fill: 100, tone: "red", tick: false });
      expect(r.reset).toMatch(/^Limited until /);
    }
  });
  test("a reset in the past reads as a fresh, empty window rather than the stale percentage", () => {
    const r = rowFor(week(97, 1, { resetsAt: NOW - H }), "used", NOW, NOW);
    expect(r).toMatchObject({ fill: 0, tone: "neutral", text: "0% used", reset: "resetting…" });
  });
});

describe("reset text", () => {
  test("relative under a day", () => {
    expect(resetText(NOW + 2 * H + 14 * 60_000, NOW)).toBe("resets in 2h 14m");
    expect(resetText(NOW + 14 * 60_000, NOW)).toBe("resets in 14m");
    expect(resetText(NOW + 5_000, NOW)).toBe("resets in 1m");
  });
  test("weekday and time from a day on", () => {
    const thu = new Date(2026, 9, 8, 12, 0).getTime(); // exactly 24h later
    expect(resetText(thu, NOW)).toMatch(/^resets Thu 12:00/);
    expect(resetText(thu - 60_000, NOW)).toBe("resets in 23h 59m");
  });
  test("limited: time only within a day, weekday after", () => {
    expect(limitedText(NOW + 2 * H, NOW)).toMatch(/^Limited until 2:00/);
    expect(limitedText(new Date(2026, 9, 10, 9, 0).getTime(), NOW)).toMatch(/^Limited until Sat 9:00/);
  });
  test("updated", () => {
    expect(updatedText(NOW - 20_000, NOW)).toBe("updated just now");
    expect(updatedText(NOW - 125 * 60_000, NOW)).toBe("updated 2h ago");
  });
});

describe("filter", () => {
  const report: PlanUsageReport = {
    drivers: [
      driver({ windows: [week(10, 0.5), week(20, 0.5, { id: "five_hour", label: "5-hour", windowSeconds: 18000 })] }),
      driver({ driver: "github-copilot", name: "GitHub Copilot", windows: [week(5, 0.5, { id: "monthly", label: "Premium requests" })] }),
    ],
  };
  test("all drivers", () => {
    expect(rowsFor(report, "all", "used", NOW).map((d) => d.driver)).toEqual(["claude-code", "github-copilot"]);
  });
  test("one driver", () => {
    const rows = rowsFor(report, "github-copilot", "used", NOW);
    expect(rows.map((d) => d.driver)).toEqual(["github-copilot"]);
    expect(rows[0]!.rows.map((r) => r.label)).toEqual(["Premium requests"]);
  });
  test("hide, no report, and a driver with no row show nothing", () => {
    expect(rowsFor(report, "hide", "used", NOW)).toEqual([]);
    expect(rowsFor(null, "all", "used", NOW)).toEqual([]);
    expect(rowsFor(report, "anthropic-api", "used", NOW)).toEqual([]);
    expect(rowsFor({ drivers: [] }, "all", "used", NOW)).toEqual([]);
  });
  test("choices list the reporting drivers, Hide last, and keep a stored driver that went quiet", () => {
    expect(filterChoices(report, "all").map((c) => c.id)).toEqual(["all", "claude-code", "github-copilot", "hide"]);
    expect(filterChoices(report, "anthropic-api").map((c) => c.id)).toContain("anthropic-api");
  });
});

describe("unreadable drivers", () => {
  test("no windows shows the reason, not a bar", () => {
    const [d] = rowsFor({ drivers: [driver({ error: "Sign in to Claude Code to see plan usage" })] }, "all", "used", NOW);
    expect(d).toMatchObject({ rows: [], note: "Sign in to Claude Code to see plan usage" });
  });
  test("a limited status without percentages shows that state", () => {
    expect(rowsFor({ drivers: [driver({ status: "limited" })] }, "all", "used", NOW)[0]!.note).toBe("Limited");
    expect(rowsFor({ drivers: [driver({ status: "near_limit" })] }, "all", "used", NOW)[0]!.note).toBe("Near the limit");
  });
  test("nothing known means no row", () => {
    expect(rowsFor({ drivers: [driver()] }, "all", "used", NOW)).toEqual([]);
  });
  test("an error beside real windows still shows the bars", () => {
    const [d] = rowsFor({ drivers: [driver({ windows: [week(10, 0.5)], error: "x" })] }, "all", "used", NOW);
    expect(d!.rows).toHaveLength(1);
    expect(d!.note).toBeNull();
  });
});

describe("stored preferences", () => {
  test("default to All drivers and Used so far, and survive junk", () => {
    expect(parseLayout(null)).toMatchObject({ usageFilter: "all", usageMode: "used" });
    expect(parseLayout(JSON.stringify({ usageFilter: 7, usageMode: "wat" }))).toMatchObject({ usageFilter: "all", usageMode: "used" });
  });
  test("round-trip", () => {
    expect(parseLayout(JSON.stringify({ ...DEFAULT_LAYOUT, usageFilter: "hide", usageMode: "projected" }))).toMatchObject({ usageFilter: "hide", usageMode: "projected" });
  });
});

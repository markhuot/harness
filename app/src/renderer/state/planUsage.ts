// The sidebar's plan-usage gauges, as pure functions: percent formatting, colour bands, reset text,
// the "Projected at reset" maths and the per-device driver filter. The component
// (views/PlanUsage.tsx) only renders what rowsFor() returns; planUsage.test.ts covers the edges.

import type { DriverPlanUsage, PlanUsageReport, PlanWindow } from "@harness/shared";

export type UsageMode = "used" | "projected";
/** "all", "hide" (a one-line header), or one driver's id */
export type UsageFilter = string;
export type Tone = "neutral" | "amber" | "red" | "green";

export const USAGE_MODES: { id: UsageMode; label: string }[] = [
  { id: "used", label: "Used so far" },
  { id: "projected", label: "Projected at reset" },
];

/** Until this much of a window has passed, the projection swings too wildly to show. */
export const MIN_ELAPSED = 0.1;
/** Where "on pace to use exactly the limit" sits on the projected bar (percent of its length). */
export const TICK_AT = 80;

export const INFO_USED =
  "How much of your plan's usage limits the agents have used. Claude Code limits usage per 5-hour window and per week; when one fills, runs stop with a usage-limit error until it resets. Shared with anything else using the same account, such as Claude Code in your terminal.";
export const INFO_PROJECTED =
  "Projected at reset divides what's used by how much of the window has passed, so you can see whether the agents are on pace to run out before it resets. The tick marks using exactly 100% by the reset.";

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export const formatPercent = (p: number) => `${Math.round(clamp(p, 0, 999))}%`;

/** Used so far: neutral below 75%, amber from 75%, red from 90% (and at 100%). */
export function usedTone(percent: number): Tone {
  if (percent >= 90) return "red";
  if (percent >= 75) return "amber";
  return "neutral";
}

/** Projected at reset: green up to 90%, amber to 100%, red over 100%. */
export function projectedTone(projected: number): Tone {
  if (projected > 100) return "red";
  if (projected >= 90) return "amber";
  return "green";
}

/** The projected bar's fill: 100% projected sits on the tick (80%), 75% fills half, ~117% fills it. */
export const projectedFill = (projected: number) => clamp(1.2 * projected - 40, 0, 100);

/**
 * How far through the window we are, 0–1. A reset time in the past means the window has rolled
 * over and the next poll hasn't said so yet: treated as a fresh one (0).
 */
export function elapsedFraction(w: Pick<PlanWindow, "resetsAt" | "windowSeconds">, now: number): number {
  if (w.resetsAt <= now || w.windowSeconds <= 0) return 0;
  return clamp(1 - (w.resetsAt - now) / (w.windowSeconds * 1000), 0, 1);
}

/** Projected use at the reset (percent), or null before MIN_ELAPSED of the window has passed. */
export function projectedUse(usedPercent: number, elapsed: number): number | null {
  return elapsed < MIN_ELAPSED ? null : usedPercent / elapsed;
}

const clock = (d: Date) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const weekday = (d: Date) => d.toLocaleDateString("en-US", { weekday: "short" });

/** "2h 14m", "14m", "1m" (rounded up to a minute). */
export function duration(ms: number): string {
  const mins = Math.max(1, Math.ceil(ms / 60_000));
  const h = Math.floor(mins / 60);
  return h ? `${h}h ${mins % 60}m` : `${mins}m`;
}

const DAY = 86_400_000;

/** "resets in 2h 14m" within a day, "resets Thu 9:00 AM" after. */
export function resetText(resetsAt: number, now: number): string {
  const left = resetsAt - now;
  if (left <= 0) return "resetting…";
  if (left < DAY) return `resets in ${duration(left)}`;
  const d = new Date(resetsAt);
  return `resets ${weekday(d)} ${clock(d)}`;
}

/** "Limited until 9:00 AM" (with the weekday when it's a day or more away). */
export function limitedText(resetsAt: number, now: number): string {
  const d = new Date(resetsAt);
  return `Limited until ${resetsAt - now >= DAY ? `${weekday(d)} ` : ""}${clock(d)}`;
}

/** "updated just now", "updated 3m ago", "updated 2h ago" */
export function updatedText(fetchedAt: number, now: number): string {
  const mins = Math.floor(Math.max(0, now - fetchedAt) / 60_000);
  if (mins < 1) return "updated just now";
  return mins < 60 ? `updated ${mins}m ago` : `updated ${Math.floor(mins / 60)}h ago`;
}

function windowNoun(w: PlanWindow): string {
  if (w.id === "monthly") return "month";
  if (w.id === "five_hour") return "window";
  return w.windowSeconds >= 6 * 86_400 ? "week" : "window";
}

export interface UsageRow {
  id: string;
  label: string;
  /** Bar fill, 0–100 */
  fill: number;
  /** Show the 80% "on pace for exactly the limit" tick */
  tick: boolean;
  tone: Tone;
  /** "63% used", "on pace for 63% · 50% used", "2% used · too early to project" */
  text: string;
  /** "resets in 2h 14m" or "Limited until 9:00 AM" */
  reset: string;
  /** Tooltip / accessibility label */
  title: string;
}

export function rowFor(w: PlanWindow, mode: UsageMode, now: number, fetchedAt: number): UsageRow {
  // A window that has already reset is a fresh one until the next poll says so.
  const rolled = w.resetsAt <= now;
  const used = rolled ? 0 : clamp(w.usedPercent, 0, 100);
  const elapsed = elapsedFraction(w, now);
  const updated = updatedText(fetchedAt, now);
  const base = { id: w.id, label: w.label };

  if (used >= 100) {
    const reset = limitedText(w.resetsAt, now);
    return { ...base, fill: 100, tick: false, tone: "red", text: "100% used", reset, title: `${w.label}: 100% used. ${reset}. ${updated}` };
  }
  const reset = resetText(w.resetsAt, now);
  const projected = mode === "projected" ? projectedUse(used, elapsed) : null;
  if (projected === null) {
    const early = mode === "projected";
    const text = early ? `${formatPercent(used)} used · too early to project` : `${formatPercent(used)} used`;
    return { ...base, fill: used, tick: false, tone: usedTone(used), text, reset, title: `${w.label}: ${text}, ${reset}. ${updated}` };
  }
  const text = `on pace for ${formatPercent(projected)} · ${formatPercent(used)} used`;
  const gone = `${Math.round(elapsed * 100)}% of the ${windowNoun(w)} gone`;
  return { ...base, fill: projectedFill(projected), tick: true, tone: projectedTone(projected), text, reset, title: `${w.label}: ${text}, ${gone}, ${reset}. ${updated}` };
}

export interface DriverRows {
  driver: string;
  name: string;
  rows: UsageRow[];
  /** Why there are no bars: "Sign in to Claude Code to see plan usage", "Limited", "Near the limit" */
  note: string | null;
}

function driverRows(d: DriverPlanUsage, mode: UsageMode, now: number): DriverRows | null {
  if (d.windows.length) {
    return { driver: d.driver, name: d.name, rows: d.windows.map((w) => rowFor(w, mode, now, d.fetchedAt)), note: null };
  }
  // No percentages: say what we do know instead of showing a stale bar.
  const note = d.error ?? (d.status === "limited" ? "Limited" : d.status === "near_limit" ? "Near the limit" : null);
  return note ? { driver: d.driver, name: d.name, rows: [], note } : null;
}

/** What the section shows for the stored filter. "hide" and a driver with nothing to show give []. */
export function rowsFor(report: PlanUsageReport | null, filter: UsageFilter, mode: UsageMode, now: number): DriverRows[] {
  if (!report || filter === "hide") return [];
  return report.drivers
    .filter((d) => filter === "all" || d.driver === filter)
    .map((d) => driverRows(d, mode, now))
    .filter((r): r is DriverRows => r !== null);
}

/** The filter menu's choices: every driver that reports usage (the stored one stays even when it has gone quiet). */
export function filterChoices(report: PlanUsageReport | null, filter: UsageFilter): { id: UsageFilter; label: string }[] {
  const drivers = (report?.drivers ?? []).map((d) => ({ id: d.driver, label: d.name }));
  if (filter !== "all" && filter !== "hide" && !drivers.some((d) => d.id === filter)) drivers.push({ id: filter, label: filter });
  return [{ id: "all", label: "All drivers" }, ...drivers, { id: "hide", label: "Hide" }];
}

export const infoText = (mode: UsageMode) => (mode === "projected" ? `${INFO_USED} ${INFO_PROJECTED}` : INFO_USED);

/** Parse the stored mode, tolerating anything. */
export const parseMode = (v: unknown): UsageMode => (v === "projected" ? "projected" : "used");
export const parseFilter = (v: unknown): UsageFilter => (typeof v === "string" && v ? v : "all");

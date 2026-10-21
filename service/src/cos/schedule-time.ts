// When a schedule fires (DESIGN.md "Schedules"): pure functions of a spec and a time, in the Mac's
// timezone. Cron is parsed by croner, which owns the DST rules (a time skipped by spring-forward runs
// at the next valid one; a time repeated by fall-back runs once).

import { SCHEDULE_MIN_INTERVAL_MS, type ScheduleSpec } from "@harness/shared";
import { Cron } from "croner";

/** The fewest fires looked at to judge how tight a cron expression is. */
const GAP_SAMPLES = 8;

function cronOf(expr: string): Cron {
  if (expr.trim().split(/\s+/).length !== 5) throw new Error('cron takes 5 fields: "minute hour day-of-month month day-of-week", e.g. "0 9 * * 1-5"');
  try {
    return new Cron(expr.trim(), { legacyMode: true });
  } catch (err) {
    throw new Error(`Not a valid cron expression: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The first fire strictly after `after`, or null when the spec has none left. */
export function nextFire(spec: ScheduleSpec, after: number): number | null {
  if (spec.type === "at") return spec.at > after ? spec.at : null;
  if (spec.type === "every") return after + spec.everyMs;
  return cronOf(spec.cron).nextRun(new Date(after))?.getTime() ?? null;
}

/** The occurrence after one that fired at `scheduledFor`, when it is `now`: a missed run is skipped, never replayed, and an interval keeps its phase. */
export function advance(spec: ScheduleSpec, scheduledFor: number, now: number): number | null {
  if (spec.type === "at") return null;
  if (spec.type === "every") return scheduledFor + spec.everyMs * (Math.floor((now - scheduledFor) / spec.everyMs) + 1);
  return nextFire(spec, Math.max(now, scheduledFor));
}

/** Throws a message for the agent when the spec can't be scheduled from `now`: in the past, too tight, or malformed. */
export function validateSpec(spec: ScheduleSpec, now: number): void {
  if (spec.type === "at") {
    if (!Number.isFinite(spec.at) || spec.at <= now) throw new Error("`at` must be a time in the future.");
    return;
  }
  if (spec.type === "every") {
    if (!Number.isFinite(spec.everyMs) || spec.everyMs < SCHEDULE_MIN_INTERVAL_MS) throw new Error(`A repeating schedule fires at most every ${SCHEDULE_MIN_INTERVAL_MS / 60_000} minutes.`);
    return;
  }
  const cron = cronOf(spec.cron);
  const times = cron.nextRuns(GAP_SAMPLES, new Date(now)).map((d) => d.getTime());
  if (!times.length) throw new Error("That cron expression never fires.");
  for (let i = 1; i < times.length; i++) {
    if (times[i]! - times[i - 1]! < SCHEDULE_MIN_INTERVAL_MS) throw new Error(`A repeating schedule fires at most every ${SCHEDULE_MIN_INTERVAL_MS / 60_000} minutes.`);
  }
}

/** "Fri 24 Oct, 09:00" style text in the Mac's timezone, for the agent and the push. */
export function describeTime(at: number): string {
  return new Date(at).toLocaleString("en-US", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
}

export function describeSpec(spec: ScheduleSpec): string {
  if (spec.type === "at") return `once at ${describeTime(spec.at)}`;
  if (spec.type === "every") return `every ${spec.everyMs % 3_600_000 === 0 ? `${spec.everyMs / 3_600_000} h` : `${Math.round(spec.everyMs / 60_000)} min`}`;
  return `cron "${spec.cron}"`;
}

/** The spec a create call asks for: exactly one of `at` (a date-time; without an offset it is the Mac's local time), `everyMinutes` or `cron`. */
export function specFromInput(input: { at?: string; everyMinutes?: number; cron?: string }): ScheduleSpec {
  const given = [input.at !== undefined, input.everyMinutes !== undefined, input.cron !== undefined].filter(Boolean).length;
  if (given !== 1) throw new Error("Give exactly one of `at` (once), `every_minutes` (repeating) or `cron` (repeating).");
  if (input.at !== undefined) {
    // A bare date parses as UTC midnight, which is the wrong day for a Mac west of Greenwich: ask for a time.
    const at = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(input.at.trim()) ? Date.parse(input.at.trim()) : NaN;
    if (Number.isNaN(at)) throw new Error('`at` must be an ISO 8601 date-time such as "2026-10-23T09:00" (the Mac\'s local time when it has no offset).');
    return { type: "at", at };
  }
  if (input.everyMinutes !== undefined) return { type: "every", everyMs: Math.round(input.everyMinutes * 60_000) };
  return { type: "cron", cron: input.cron! };
}

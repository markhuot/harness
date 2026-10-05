// A run that stops on a usage limit says when the limit resets. The ticket blocks as for any failed
// run, and the scheduler restarts it a few minutes after that time (DESIGN.md "Usage limits").

/** How long after the reset a ticket restarts, so the limit has really cleared. */
export const RESUME_GRACE_MS = 5 * 60_000;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * When the usage limit named in a run's error resets (ms), or null when the error isn't a usage
 * limit or doesn't say when. Understands the Claude CLI's forms:
 *  - "You've hit your limit · resets 2:30pm (America/New_York)" (also "5-hour limit reached ∙ resets 3am",
 *    "your session limit resets 2:30pm (…)", "weekly limit … resets Oct 9, 5pm (…)" or "Oct 9 at 5pm")
 *  - "Claude AI usage limit reached|1791230400" (epoch seconds)
 * A time without a date is its next occurrence after `now` in the named zone (the machine's zone
 * when none is named).
 */
export function usageLimitResetAt(error: string | null | undefined, now = Date.now()): number | null {
  if (!error || !/limit/i.test(error)) return null;
  const epoch = /limit reached\|(\d{10,13})\b/i.exec(error);
  if (epoch) {
    const n = Number(epoch[1]);
    return epoch[1]!.length > 10 ? n : n * 1000;
  }
  const m = /\bresets?\s+(?:at\s+)?(?:(?:on\s+)?([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?/i.exec(error);
  if (!m) return null;
  const [, monthName, dayText, hourText, minuteText, meridiem, zoneText] = m;
  let hour = Number(hourText);
  const minute = minuteText ? Number(minuteText) : 0;
  if (minute > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (meridiem.toLowerCase() === "pm" ? 12 : 0);
  } else if (!minuteText || hour > 23) {
    return null; // "resets 3" is no time
  }
  const zone = validZone(zoneText?.trim());
  if (zoneText && !zone) return null;
  const today = wallDate(now, zone);
  if (monthName && dayText) {
    const month = MONTHS.indexOf(monthName.toLowerCase());
    const day = Number(dayText);
    if (month < 0 || day < 1 || day > 31) return null;
    // The next such date: Dec 31 named on Jan 1 is last year's, which has passed, so a year on.
    let at = zonedTime({ year: today.year, month, day, hour, minute }, zone);
    if (at < now - 24 * 3600_000) at = zonedTime({ year: today.year + 1, month, day, hour, minute }, zone);
    return at;
  }
  let at = zonedTime({ ...today, hour, minute }, zone);
  for (let i = 0; at <= now && i < 2; i++) {
    const next = new Date(Date.UTC(today.year, today.month, today.day + 1 + i));
    at = zonedTime({ year: next.getUTCFullYear(), month: next.getUTCMonth(), day: next.getUTCDate(), hour, minute }, zone);
  }
  return at;
}

/**
 * Whether a run's error is a usage or spend limit, whether or not it says when it resets
 * ("You've hit your individual spend limit · …", "5-hour limit reached", "usage limit reached|…").
 */
export function isUsageLimit(error: string | null | undefined): boolean {
  if (!error) return false;
  if (usageLimitResetAt(error) !== null) return true;
  return /\b(?:spend|spending|usage|session|weekly|daily|monthly|5-hour|credit) limit\b|\bhit your (?:\S+ )?limit\b|\blimit reached\b/i.test(error);
}

/** When a ticket blocked by this error restarts on its own (the reset plus RESUME_GRACE_MS), or null. */
export function usageLimitResumeAt(error: string | null | undefined, now = Date.now()): number | null {
  const reset = usageLimitResetAt(error, now);
  return reset === null ? null : Math.max(reset, now) + RESUME_GRACE_MS;
}

/** "2:35 PM", in this machine's zone: the restart time Activity and the transcript name. */
export function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function validZone(zone: string | undefined): string | undefined {
  if (!zone) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return undefined;
  }
}

interface WallDate {
  year: number;
  /** 0-based */
  month: number;
  day: number;
}

function parts(ms: number, zone: string | undefined): WallDate & { hour: number; minute: number; second: number } {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
  const p: Record<string, number> = {};
  for (const x of f.formatToParts(new Date(ms))) if (x.type !== "literal") p[x.type] = Number(x.value);
  return { year: p.year!, month: p.month! - 1, day: p.day!, hour: p.hour! % 24, minute: p.minute!, second: p.second! };
}

function wallDate(ms: number, zone: string | undefined): WallDate {
  const { year, month, day } = parts(ms, zone);
  return { year, month, day };
}

/** The instant a wall-clock time in `zone` names (the machine's zone when undefined). */
function zonedTime(w: WallDate & { hour: number; minute: number }, zone: string | undefined): number {
  const asUtc = Date.UTC(w.year, w.month, w.day, w.hour, w.minute);
  // The zone's offset at a guess, then again at the corrected instant (a DST change in between).
  let at = asUtc;
  for (let i = 0; i < 2; i++) {
    const p = parts(at, zone);
    const offset = Date.UTC(p.year, p.month, p.day, p.hour, p.minute, p.second) - Math.floor(at / 1000) * 1000;
    at = asUtc - offset;
  }
  return at;
}

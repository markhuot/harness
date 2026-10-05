import { describe, expect, test } from "bun:test";
import { RESUME_GRACE_MS, usageLimitResetAt, usageLimitResumeAt } from "./usage-limit";

// 2026-10-05 14:20 EDT (18:20 UTC), when ACAMS-33's run hit its limit.
const NOW = Date.UTC(2026, 9, 5, 18, 20);
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

describe("usageLimitResetAt", () => {
  test("the CLI's spend limit with a zone resets later the same day", () => {
    const error =
      "You've hit your individual spend limit · run /usage-credits to ask your admin for a higher limit · your session limit resets 2:30pm (America/New_York)";
    expect(iso(usageLimitResetAt(error, NOW))).toBe("2026-10-05T18:30:00.000Z");
  });

  test("a time that has passed today is tomorrow's", () => {
    expect(iso(usageLimitResetAt("5-hour limit reached ∙ resets 3am (America/New_York)", NOW))).toBe("2026-10-06T07:00:00.000Z");
  });

  test("the zone decides the instant", () => {
    // 7pm in London (BST) was 18:00 UTC, 20 minutes ago: tomorrow's.
    expect(iso(usageLimitResetAt("You've hit your limit · resets 7pm (Europe/London)", NOW))).toBe("2026-10-06T18:00:00.000Z");
    expect(iso(usageLimitResetAt("You've hit your limit · resets 8pm (Europe/London)", NOW))).toBe("2026-10-05T19:00:00.000Z");
  });

  test("a date names that day, across a DST change", () => {
    // Nov 2 is after the US falls back: 5pm EST is 22:00 UTC, not 21:00.
    expect(iso(usageLimitResetAt("You've hit your weekly limit · resets Nov 2, 5pm (America/New_York)", NOW))).toBe("2026-11-02T22:00:00.000Z");
    expect(iso(usageLimitResetAt("Weekly limit reached ∙ resets Oct 9 at 5:15pm (America/New_York)", NOW))).toBe("2026-10-09T21:15:00.000Z");
  });

  test("a date earlier in the year is next year's", () => {
    expect(iso(usageLimitResetAt("weekly limit · resets Jan 3, 9am (America/New_York)", NOW))).toBe("2027-01-03T14:00:00.000Z");
  });

  test("the epoch form", () => {
    expect(usageLimitResetAt("Claude AI usage limit reached|1791230400", NOW)).toBe(1791230400_000);
  });

  test("anything else isn't a usage limit with a reset", () => {
    expect(usageLimitResetAt(null, NOW)).toBeNull();
    expect(usageLimitResetAt("Driver error", NOW)).toBeNull();
    expect(usageLimitResetAt("Prompt is too long", NOW)).toBeNull();
    expect(usageLimitResetAt("You've hit your limit", NOW)).toBeNull(); // no reset time
    expect(usageLimitResetAt("The connection resets 3pm (America/New_York)", NOW)).toBeNull(); // no limit
    expect(usageLimitResetAt("limit · resets 13pm", NOW)).toBeNull();
    expect(usageLimitResetAt("limit · resets 3pm (Not/AZone)", NOW)).toBeNull();
  });
});

describe("usageLimitResumeAt", () => {
  test("restarts five minutes after the reset", () => {
    expect(usageLimitResumeAt("limit · resets 2:30pm (America/New_York)", NOW)).toBe(Date.UTC(2026, 9, 5, 18, 35));
  });

  test("a reset already past (the epoch form) restarts five minutes from now", () => {
    expect(usageLimitResumeAt("Claude AI usage limit reached|1791000000", NOW)).toBe(NOW + RESUME_GRACE_MS);
  });

  test("no reset, no restart", () => {
    expect(usageLimitResumeAt("Driver error", NOW)).toBeNull();
  });
});

import { expect, test } from "bun:test";
import { isUsageLimit, RESUME_GRACE_MS, usageLimitResetAt, usageLimitResumeAt } from "../../../service/src/orchestrator/usage-limit";
import { RunInput } from "../../../service/src/drivers/input";

// 2026-03-10 12:00:00 UTC, a Tuesday outside any DST change in New York.
const NOW = Date.UTC(2026, 2, 10, 12, 0, 0);

test("an epoch in the CLI's limit-reached form is read in seconds or milliseconds", () => {
  expect(usageLimitResetAt("Claude AI usage limit reached|1791230400")).toBe(1791230400_000);
  expect(usageLimitResetAt("limit reached|1791230400000")).toBe(1791230400_000);
});

test("a clock time in a named zone is its next occurrence after now", () => {
  // 2:30pm New York on Mar 10 (EDT, UTC-4) is 18:30 UTC, still ahead of 12:00 UTC.
  expect(usageLimitResetAt("You've hit your limit · resets 2:30pm (America/New_York)", NOW)).toBe(Date.UTC(2026, 2, 10, 18, 30));
  // 5am New York already passed today (09:00 UTC): it means tomorrow.
  expect(usageLimitResetAt("5-hour limit reached ∙ resets 5am (America/New_York)", NOW)).toBe(Date.UTC(2026, 2, 11, 9, 0));
});

test("a dated reset names the month and day, and rolls into next year when this year's has long passed", () => {
  expect(usageLimitResetAt("weekly limit resets Mar 14, 5pm (UTC)", NOW)).toBe(Date.UTC(2026, 2, 14, 17));
  expect(usageLimitResetAt("weekly limit resets Mar 14 at 5pm (UTC)", NOW)).toBe(Date.UTC(2026, 2, 14, 17));
  expect(usageLimitResetAt("limit resets Jan 2, 5pm (UTC)", NOW)).toBe(Date.UTC(2027, 0, 2, 17));
});

test("anything that isn't a time, or names a bad one, is null", () => {
  expect(usageLimitResetAt("Something failed", NOW)).toBeNull();
  expect(usageLimitResetAt(null)).toBeNull();
  expect(usageLimitResetAt("limit resets 3", NOW)).toBeNull();
  expect(usageLimitResetAt("limit resets 13pm (UTC)", NOW)).toBeNull();
  expect(usageLimitResetAt("limit resets 2:75pm (UTC)", NOW)).toBeNull();
  expect(usageLimitResetAt("limit resets 2pm (Not/AZone)", NOW)).toBeNull();
  expect(usageLimitResetAt("limit resets Foo 3, 2pm (UTC)", NOW)).toBeNull();
});

test("a usage limit is recognized with or without a reset time; other errors aren't", () => {
  expect(isUsageLimit("You've hit your individual spend limit")).toBe(true);
  expect(isUsageLimit("weekly limit resets Mar 14, 5pm (UTC)")).toBe(true);
  expect(isUsageLimit("5-hour limit reached")).toBe(true);
  expect(isUsageLimit("rate limit exceeded on tool")).toBe(false);
  expect(isUsageLimit("claude exited with code 1")).toBe(false);
  expect(isUsageLimit(undefined)).toBe(false);
});

test("the restart is the reset plus five minutes, or five minutes after now when the reset has passed", () => {
  expect(usageLimitResumeAt("limit reached|1791230400", 1791230400_000 - 1000)).toBe(1791230400_000 + RESUME_GRACE_MS);
  expect(usageLimitResumeAt("limit reached|1791230400", 1791230400_000 + 60_000)).toBe(1791230400_000 + 60_000 + RESUME_GRACE_MS);
  expect(usageLimitResumeAt("5-hour limit reached", NOW)).toBeNull();
});

test("RunInput: a taken message stays pending until delivered, and one that never is comes back as sent", () => {
  const input = new RunInput();
  let pushes = 0;
  input.onPush(() => pushes++);
  expect(input.push("first")).toBe(true);
  input.push("second", { text: "second as sent", attachments: [] });
  expect(pushes).toBe(2);
  const taken = input.take();
  expect(taken.map((m) => m.text)).toEqual(["first", "second"]);
  expect(input.take()).toEqual([]);
  expect(input.inFlight()).toHaveLength(2);
  expect(input.delivered(taken[0]!.id)).toBe(true);
  expect(input.delivered(taken[0]!.id)).toBe(false);
  expect(input.pending).toBe(true);
  expect(input.undelivered()).toEqual([{ text: "second as sent", attachments: [] }]);
});

test("RunInput: once closed it refuses messages and stops notifying", () => {
  const input = new RunInput();
  let pushes = 0;
  input.onPush(() => pushes++);
  input.close();
  expect(input.isClosed).toBe(true);
  expect(input.push("late")).toBe(false);
  expect(pushes).toBe(0);
});

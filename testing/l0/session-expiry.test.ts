import { expect, test } from "bun:test";
import { idleLabel, SESSION_EXPIRY_MIN_TOKENS, sessionExpiry } from "../../service/src/orchestrator/session-expiry";

const HOUR = 3_600_000;
const base = { lastCallAt: 1_000_000, ttlMs: HOUR, contextTokens: 150_000 };

test("a gap inside the TTL, and one exactly at it, resume the session", () => {
  expect(sessionExpiry({ ...base, now: base.lastCallAt + HOUR - 1 })).toBeNull();
  expect(sessionExpiry({ ...base, now: base.lastCallAt + HOUR })).toBeNull();
});

test("a gap past the TTL starts a new session, and reports how long it sat idle", () => {
  expect(sessionExpiry({ ...base, now: base.lastCallAt + HOUR + 1 })).toBe(HOUR + 1);
});

test("a small conversation resumes however long it sat: only 100k tokens and up rotates", () => {
  const now = base.lastCallAt + 5 * HOUR;
  expect(SESSION_EXPIRY_MIN_TOKENS).toBe(100_000);
  expect(sessionExpiry({ ...base, now, contextTokens: 99_999 })).toBeNull();
  expect(sessionExpiry({ ...base, now, contextTokens: 100_000 })).toBe(5 * HOUR);
});

test("a driver without a TTL, or a session without a recorded call, never rotates", () => {
  const now = base.lastCallAt + 100 * HOUR;
  expect(sessionExpiry({ ...base, now, ttlMs: undefined })).toBeNull();
  expect(sessionExpiry({ ...base, now, lastCallAt: null })).toBeNull();
});

test("idleLabel writes hours and minutes", () => {
  expect(idleLabel(3 * HOUR + 12 * 60_000)).toBe("3h 12m");
  expect(idleLabel(HOUR)).toBe("1h");
  expect(idleLabel(45 * 60_000)).toBe("45m");
});

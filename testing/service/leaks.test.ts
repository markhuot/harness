import { afterEach, expect, test } from "bun:test";
import { assertNoTimerLeaks, trackTimers } from "./leaks";

afterEach(() => {
  try {
    assertNoTimerLeaks();
  } catch {}
});

test("a running interval is a leak, named with where it was started, and is stopped so it can't fail the next test", () => {
  trackTimers();
  const t = setInterval(() => {}, 60_000);
  const heldTheProcessOpen = t.hasRef();
  expect(() => assertNoTimerLeaks()).toThrow(/interval \(60000ms\) started at .*leaks\.test\.ts/);
  expect(heldTheProcessOpen).toBe(true);
  expect(t.hasRef()).toBe(false); // stopped by the check
  expect(() => assertNoTimerLeaks()).not.toThrow();
});

test("a timeout that can still fire is a leak", () => {
  trackTimers();
  setTimeout(() => {}, 60_000);
  expect(() => assertNoTimerLeaks()).toThrow(/timeout \(60000ms\)/);
});

test("a cleared timer, an unref'd one and one that already fired aren't", async () => {
  trackTimers();
  clearInterval(setInterval(() => {}, 60_000));
  clearTimeout(setTimeout(() => {}, 60_000));
  setInterval(() => {}, 60_000).unref();
  setTimeout(() => {}, 60_000).unref();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(() => assertNoTimerLeaks()).not.toThrow();
});

test("starting a new count forgets what an earlier test left", () => {
  trackTimers();
  const t = setTimeout(() => {}, 60_000);
  trackTimers();
  expect(() => assertNoTimerLeaks()).not.toThrow();
  clearTimeout(t);
});

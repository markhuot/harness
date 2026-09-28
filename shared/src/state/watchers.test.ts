import { describe, expect, test } from "bun:test";
import type { Watcher, WatcherLive } from "../protocol";
import { untilTime, watcherStatus } from "./watchers";

const NOW = 1_800_000_000_000;

function w(patch: Partial<Watcher> = {}, live?: Partial<WatcherLive>): Watcher {
  return {
    id: "w1",
    name: "jira-sprint",
    command: "watch-jira --follow",
    args: [],
    prompt: "",
    cwd: null,
    env: {},
    mode: "loop",
    intervalSec: 60,
    enabled: true,
    driver: null,
    lastRunAt: NOW - 5 * 60_000,
    lastError: null,
    createdAt: 0,
    updatedAt: 0,
    ...(live ? { live: { state: "waiting", since: NOW, nextRunAt: null, failures: 0, ...live } } : {}),
    ...patch,
  };
}

describe("watcherStatus", () => {
  test("running shows when it started, and hides an earlier interval run's error", () => {
    expect(watcherStatus(w({ lastError: "old" }, { state: "running", since: NOW - 3 * 60_000 }), NOW)).toEqual({
      label: "Running",
      tone: "green",
      detail: "started 3m ago",
      error: null,
    });
  });

  test("a failure waiting out its backoff is red, counts repeats, and says when it retries", () => {
    const err = "Command exited with code 1: auth rejected";
    expect(watcherStatus(w({ lastError: err }, { nextRunAt: NOW + 120_000, failures: 1 }), NOW)).toMatchObject({ label: "Failed", tone: "red", detail: "retrying in 2m", error: err });
    expect(watcherStatus(w({ lastError: err }, { nextRunAt: NOW + 30_000, failures: 4 }), NOW).label).toBe("Failed 4× in a row");
  });

  test("waiting without an error is the next run, or starting while the old process stops", () => {
    expect(watcherStatus(w({ mode: "interval" }, { nextRunAt: NOW + 45_000 }), NOW)).toMatchObject({ label: "Waiting", tone: "neutral", detail: "next run in 45s", error: null });
    expect(watcherStatus(w({}, { nextRunAt: null }), NOW).detail).toBe("starting");
  });

  test("paused watchers are muted and don't show their error", () => {
    expect(watcherStatus(w({ enabled: false, lastError: "boom" }, { state: "stopped" }), NOW)).toEqual({ label: "Paused", tone: "neutral", detail: "last run 5m ago", error: null });
  });

  test("an enabled watcher that stopped keeps its error visible", () => {
    expect(watcherStatus(w({ lastError: "boom" }, { state: "stopped", since: NOW - 60_000 }), NOW)).toMatchObject({ label: "Stopped", tone: "red", error: "boom" });
  });

  test("services that don't report the process state fall back to the last run", () => {
    expect(watcherStatus(w({ lastError: "ENOENT" }), NOW)).toMatchObject({ label: "Failed", tone: "red", detail: "last run 5m ago", error: "ENOENT" });
    expect(watcherStatus(w(), NOW)).toMatchObject({ label: "Enabled", tone: "neutral", error: null });
  });
});

test("untilTime rounds into the largest unit and is 'now' once due", () => {
  expect(untilTime(NOW - 1000, NOW)).toBe("now");
  expect(untilTime(NOW, NOW)).toBe("now");
  expect(untilTime(NOW + 59_000, NOW)).toBe("in 59s");
  expect(untilTime(NOW + 60_000, NOW)).toBe("in 1m");
  expect(untilTime(NOW + 5 * 3_600_000, NOW)).toBe("in 5h");
  expect(untilTime(NOW + 3 * 86_400_000, NOW)).toBe("in 3d");
});

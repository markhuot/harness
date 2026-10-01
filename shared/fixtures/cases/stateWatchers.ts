// Watcher status for the Inbox strip (shared/src/state/watchers.ts) for HarnessKit's
// State/WatcherStatus.swift. Every case carries its own `now` so outputs are deterministic.
import type { Watcher, WatcherLive } from "../../src/protocol";
import { untilTime, watcherStatus } from "../../src/state/watchers";
import { cases } from "../case";

const NOW = 1_800_000_000_000;
const S = 1000;
const M = 60 * S;
const H = 60 * M;
const D = 24 * H;

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
    lastRunAt: NOW - 5 * M,
    lastError: null,
    createdAt: 0,
    updatedAt: 0,
    ...(live ? { live: { state: "waiting", since: NOW, nextRunAt: null, failures: 0, ...live } } : {}),
    ...patch,
  };
}

export const untilTimeCases = cases(({ ts, now }: { ts: number; now: number }) => untilTime(ts, now), {
  "past is now": { ts: NOW - S, now: NOW },
  "exactly due": { ts: NOW, now: NOW },
  "499ms rounds to 0: now": { ts: NOW + 499, now: NOW },
  "500ms rounds to 1s": { ts: NOW + 500, now: NOW },
  "1s": { ts: NOW + S, now: NOW },
  "59s": { ts: NOW + 59 * S, now: NOW },
  "59.4s stays seconds": { ts: NOW + 59_400, now: NOW },
  "59.5s rounds to 60s: 1m": { ts: NOW + 59_500, now: NOW },
  "60s": { ts: NOW + M, now: NOW },
  "89s rounds to 1m": { ts: NOW + 89 * S, now: NOW },
  "90s rounds to 2m": { ts: NOW + 90 * S, now: NOW },
  "59m": { ts: NOW + 59 * M, now: NOW },
  "59m29s stays minutes": { ts: NOW + 59 * M + 29 * S, now: NOW },
  "59m30s rounds to 1h": { ts: NOW + 59 * M + 30 * S, now: NOW },
  "5h": { ts: NOW + 5 * H, now: NOW },
  "23h29m stays hours": { ts: NOW + 23 * H + 29 * M, now: NOW },
  "23h30m rounds to 1d": { ts: NOW + 23 * H + 30 * M, now: NOW },
  "3d": { ts: NOW + 3 * D, now: NOW },
  "400d": { ts: NOW + 400 * D, now: NOW },
});

export const watcherStatusCases = cases(({ watcher, now }: { watcher: Watcher; now: number }) => watcherStatus(watcher, now), {
  "running hides an earlier error": { watcher: w({ lastError: "old" }, { state: "running", since: NOW - 3 * M }), now: NOW },
  "running just started": { watcher: w({}, { state: "running", since: NOW - 2 * S }), now: NOW },
  "failure waiting out backoff": { watcher: w({ lastError: "Command exited with code 1: auth rejected" }, { nextRunAt: NOW + 120_000, failures: 1 }), now: NOW },
  "repeated failures counted": { watcher: w({ lastError: "boom" }, { nextRunAt: NOW + 30_000, failures: 4 }), now: NOW },
  "two failures counted": { watcher: w({ lastError: "boom" }, { nextRunAt: NOW + 30_000, failures: 2 }), now: NOW },
  "failure with zero failures count is plain Failed": { watcher: w({ lastError: "boom" }, { nextRunAt: NOW + 30_000, failures: 0 }), now: NOW },
  "failure without a next run is restarting": { watcher: w({ lastError: "boom" }, { nextRunAt: null, failures: 3 }), now: NOW },
  "failure with nextRunAt 0 is restarting (falsy)": { watcher: w({ lastError: "boom" }, { nextRunAt: 0, failures: 1 }), now: NOW },
  "failure retry already due": { watcher: w({ lastError: "boom" }, { nextRunAt: NOW - 5 * S, failures: 1 }), now: NOW },
  "waiting for the next interval run": { watcher: w({ mode: "interval" }, { nextRunAt: NOW + 45_000 }), now: NOW },
  "waiting without a next run is starting": { watcher: w({}, { nextRunAt: null }), now: NOW },
  "empty error string is no error": { watcher: w({ lastError: "" }, { nextRunAt: NOW + 45_000, failures: 2 }), now: NOW },
  "paused hides its error": { watcher: w({ enabled: false, lastError: "boom" }, { state: "stopped" }), now: NOW },
  "paused never ran": { watcher: w({ enabled: false, lastRunAt: null }), now: NOW },
  "stopped keeps its error": { watcher: w({ lastError: "boom" }, { state: "stopped", since: NOW - M }), now: NOW },
  "stopped without error is neutral": { watcher: w({}, { state: "stopped", since: NOW - 2 * H }), now: NOW },
  "no live state, failed": { watcher: w({ lastError: "ENOENT" }), now: NOW },
  "no live state, enabled": { watcher: w(), now: NOW },
  "no live state, never ran": { watcher: w({ lastRunAt: null }), now: NOW },
  "unknown live state falls through to waiting": { watcher: w({}, { state: "sleeping" as never, nextRunAt: NOW + 10 * S }), now: NOW },
});

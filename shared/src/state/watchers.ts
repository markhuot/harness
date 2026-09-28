// Watcher status for the Inbox's watcher strip: one label, tone and detail line per watcher.

import type { Watcher } from "../protocol";
import { relativeTime } from "./format";

export type WatcherTone = "amber" | "green" | "neutral" | "red";

export interface WatcherStatus {
  label: string;
  tone: WatcherTone;
  /** When it started, or when it runs next ("started 5m ago", "retrying in 2m") */
  detail: string;
  /** The last run's error, shown under the status */
  error: string | null;
}

/** "in 45s" / "in 3m" / "in 2h" for a future time; "now" once it's due. */
export function untilTime(ts: number, now = Date.now()): string {
  const s = Math.round((ts - now) / 1000);
  if (s <= 0) return "now";
  if (s < 60) return `in ${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `in ${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `in ${h}h`;
  return `in ${Math.round(h / 24)}d`;
}

/**
 * What a watcher is doing, for people: running, waiting for its next run, or failed and waiting
 * to retry. Paused watchers are muted. A service that doesn't report the process state (older
 * builds) falls back to the last run and its error.
 */
export function watcherStatus(w: Watcher, now = Date.now()): WatcherStatus {
  const error = w.lastError || null;
  if (!w.enabled) return { label: "Paused", tone: "neutral", detail: `last run ${relativeTime(w.lastRunAt, now)}`, error: null };
  const live = w.live;
  if (!live) return { label: error ? "Failed" : "Enabled", tone: error ? "red" : "neutral", detail: `last run ${relativeTime(w.lastRunAt, now)}`, error };
  if (live.state === "running") return { label: "Running", tone: "green", detail: `started ${relativeTime(live.since, now)}`, error: null };
  if (live.state === "stopped") return { label: "Stopped", tone: error ? "red" : "neutral", detail: `stopped ${relativeTime(live.since, now)}`, error };
  const next = live.nextRunAt ? untilTime(live.nextRunAt, now) : null;
  if (error) {
    const label = live.failures > 1 ? `Failed ${live.failures}× in a row` : "Failed";
    return { label, tone: "red", detail: next ? `retrying ${next}` : "restarting", error };
  }
  return { label: "Waiting", tone: "neutral", detail: next ? `next run ${next}` : "starting", error: null };
}

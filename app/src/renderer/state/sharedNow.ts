// One clock for many relative times ("2m ago" on every board card): a single interval while anything
// listens, instead of a timer per card.

import { useSyncExternalStore } from "react";

const TICK_MS = 30_000;
const listeners = new Set<() => void>();
let now = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!timer) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const l of listeners) l();
    }, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** The time, refreshed every 30 seconds for everything showing it at once. */
export function useSharedNow(): number {
  return useSyncExternalStore(subscribe, () => now);
}

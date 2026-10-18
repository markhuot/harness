// Which file types wrap their long lines, kept in localStorage on this device (a wide pane and a phone
// can want different things, so it isn't synced). The pure parts are in shared/src/viewOptions.ts.

import { useSyncExternalStore } from "react";
import { parseWrapPrefs, serializeWrapPrefs, withWrap, type WrapPrefs } from "@harness/shared";

export const WRAP_KEY = "harness.wrap";

let current: WrapPrefs | null = null;
const listeners = new Set<() => void>();

function get(): WrapPrefs {
  if (current) return current;
  try {
    current = parseWrapPrefs(localStorage.getItem(WRAP_KEY));
  } catch {
    current = {};
  }
  return current;
}

export function isWrapped(key: string): boolean {
  return !!get()[key];
}

export function setWrapped(key: string, wrap: boolean) {
  if (!!get()[key] === wrap) return;
  current = withWrap(get(), key, wrap);
  try {
    localStorage.setItem(WRAP_KEY, serializeWrapPrefs(current));
  } catch {}
  for (const fn of listeners) fn();
}

/** Whether `key`'s file type wraps, following changes from any pane. */
export function useWrapped(key: string): boolean {
  return useSyncExternalStore(
    (fn) => (listeners.add(fn), () => void listeners.delete(fn)),
    () => isWrapped(key),
  );
}

/** Forgets what was read (tests that set localStorage directly). */
export function resetWrapPrefs() {
  current = null;
  for (const fn of listeners) fn();
}

// The layout store: persists to localStorage and keeps every subscriber (and the View menu's
// "Show Sidebar" checkmark) in sync. The pure helpers live in layoutRules.ts and are re-exported.

import { useSyncExternalStore } from "react";
import { DEFAULT_LAYOUT, parseLayout, serializeLayout, type Layout } from "./layoutRules";

export * from "./layoutRules";


export const LAYOUT_KEY = "harness.layout";

function load(): Layout {
  try {
    return parseLayout(localStorage.getItem(LAYOUT_KEY));
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}

let current: Layout | null = null;
const listeners = new Set<() => void>();
const get = () => (current ??= load());

function publish(next: Layout) {
  const prev = get();
  current = next;
  if (prev.sidebarCollapsed !== next.sidebarCollapsed) window.harness?.setSidebarVisible?.(!next.sidebarCollapsed);
  for (const fn of listeners) fn();
}

export function updateLayout(patch: Partial<Layout>) {
  const next = { ...get(), ...patch };
  try {
    localStorage.setItem(LAYOUT_KEY, serializeLayout(next));
  } catch {}
  publish(next);
}

export const toggleSidebar = () => updateLayout({ sidebarCollapsed: !get().sidebarCollapsed });
export const toggleBrowserSizeRow = () => updateLayout({ browserSizeRow: !get().browserSizeRow });

let started = false;
function subscribe(fn: () => void) {
  if (!started) {
    started = true;
    // Another window (or a test/screenshot setup) changed it: follow.
    window.addEventListener("storage", (e: StorageEvent) => {
      if (e.key === LAYOUT_KEY || e.key === null) publish(load());
    });
    window.harness?.setSidebarVisible?.(!get().sidebarCollapsed);
  }
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

export function useLayout(): Layout {
  return useSyncExternalStore(subscribe, get);
}

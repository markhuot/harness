// Window layout preferences: the left sidebar (collapsed, width), and whether the Browser pane's
// size row is open. Ticket panes and their sizes live in panes.ts.
// The pure helpers (bounds, clamping, parsing, keyboard steps) are tested in layout.test.ts; the
// store at the bottom persists to localStorage and keeps every subscriber (and the View menu's
// "Show Sidebar" checkmark) in sync.

import { useSyncExternalStore } from "react";
import { parseFilter, parseMode, type UsageFilter, type UsageMode } from "./planUsage";

export const SIDEBAR_MIN = 180;
export const SIDEBAR_MAX = 400;
/** Matches --sidebar-w in styles.css (the width before anyone drags). */
export const SIDEBAR_DEFAULT = 232;

export interface Layout {
  sidebarCollapsed: boolean;
  /** null = the default width */
  sidebarWidth: number | null;
  /** The Browser pane's second row (Desktop | Mobile, Responsive, width × height), in every pane. */
  browserSizeRow: boolean;
  /** Sidebar plan-usage gauges: which driver's rows ("all", one driver's id, or "hide") and how they read. */
  usageFilter: UsageFilter;
  usageMode: UsageMode;
}

export const DEFAULT_LAYOUT: Layout = { sidebarCollapsed: false, sidebarWidth: null, browserSizeRow: false, usageFilter: "all", usageMode: "used" };

export interface Bounds {
  min: number;
  max: number;
}

/** Round and clamp; when the room is smaller than the minimum the minimum wins. */
export function clampWidth(width: number, { min, max }: Bounds): number {
  const w = Math.round(width);
  return Math.max(min, Math.min(w, Math.max(min, max)));
}

export const sidebarBounds = (): Bounds => ({ min: SIDEBAR_MIN, max: SIDEBAR_MAX });

/** Width while dragging a handle on the pane's right edge (drag right = wider). */
export function dragWidth(startWidth: number, startX: number, x: number, bounds: Bounds): number {
  return clampWidth(startWidth + x - startX, bounds);
}

/**
 * Keyboard resizing on a focused right-edge handle (role=separator). Arrow keys move the handle
 * 16px (64px with Shift) in the arrow's direction; Home/End jump to the narrowest/widest.
 * Returns the new width, or null when the key isn't a resize key.
 */
export function keyWidth(key: string, shift: boolean, width: number, bounds: Bounds): number | null {
  const step = shift ? 64 : 16;
  switch (key) {
    case "ArrowRight":
      return clampWidth(width + step, bounds);
    case "ArrowLeft":
      return clampWidth(width - step, bounds);
    case "Home":
      return bounds.min;
    case "End":
      return clampWidth(bounds.max, bounds);
    default:
      return null;
  }
}

const widthOrNull = (v: unknown, bounds: Bounds): number | null => (typeof v === "number" && Number.isFinite(v) ? clampWidth(v, bounds) : null);

/**
 * Read the stored layout, tolerating anything (missing, corrupt, older shapes, junk values). Older
 * builds also stored the ticket panel's `detailWidth`; it's ignored now that tickets open in panes.
 */
export function parseLayout(raw: string | null | undefined): Layout {
  if (!raw) return { ...DEFAULT_LAYOUT };
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return { ...DEFAULT_LAYOUT };
  const o = v as Record<string, unknown>;
  return {
    sidebarCollapsed: o.sidebarCollapsed === true,
    sidebarWidth: widthOrNull(o.sidebarWidth, sidebarBounds()),
    browserSizeRow: o.browserSizeRow === true,
    usageFilter: parseFilter(o.usageFilter),
    usageMode: parseMode(o.usageMode),
  };
}

export const serializeLayout = (l: Layout) => JSON.stringify(l);

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

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

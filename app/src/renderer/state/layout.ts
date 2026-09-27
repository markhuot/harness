// Window layout preferences: the left sidebar (collapsed, width) and the ticket panel's width.
// The pure helpers (bounds, clamping, parsing, keyboard steps) are tested in layout.test.ts; the
// store at the bottom persists to localStorage and keeps every subscriber (and the View menu's
// "Show Sidebar" checkmark) in sync.

import { useSyncExternalStore } from "react";

export const SIDEBAR_MIN = 180;
export const SIDEBAR_MAX = 400;
/** Matches --sidebar-w in styles.css (the width before anyone drags). */
export const SIDEBAR_DEFAULT = 232;

export const DETAIL_MIN = 360;
/** The ticket panel never takes more than this share of the window… */
export const DETAIL_MAX_SHARE = 0.8;
/** …and always leaves the board at least this wide next to it. */
export const BOARD_MIN = 320;

export interface Layout {
  sidebarCollapsed: boolean;
  /** null = the default width */
  sidebarWidth: number | null;
  /** null = the default responsive width (clamp(440px, 40vw, 680px)) */
  detailWidth: number | null;
}

export const DEFAULT_LAYOUT: Layout = { sidebarCollapsed: false, sidebarWidth: null, detailWidth: null };

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

/** How wide the ticket panel may get: ≤80% of the window and never squeezing the board below BOARD_MIN. */
export function detailBounds(windowWidth: number, layoutWidth: number): Bounds {
  const max = Math.floor(Math.min(windowWidth * DETAIL_MAX_SHARE, layoutWidth - BOARD_MIN));
  return { min: DETAIL_MIN, max: Math.max(DETAIL_MIN, max) };
}

/**
 * Width while dragging a handle. `edge` is which side of the pane the handle sits on: the
 * sidebar's handle is on its right (drag right = wider), the ticket panel's on its left.
 */
export function dragWidth(startWidth: number, startX: number, x: number, edge: "left" | "right", bounds: Bounds): number {
  const dx = x - startX;
  return clampWidth(edge === "right" ? startWidth + dx : startWidth - dx, bounds);
}

/**
 * Keyboard resizing on a focused handle (role=separator). Arrow keys move the handle 16px
 * (64px with Shift) in the arrow's direction; Home/End jump to the narrowest/widest.
 * Returns the new width, or null when the key isn't a resize key.
 */
export function keyWidth(key: string, shift: boolean, width: number, edge: "left" | "right", bounds: Bounds): number | null {
  const step = shift ? 64 : 16;
  const grow = edge === "right" ? 1 : -1; // moving the handle right grows a right-edge pane
  switch (key) {
    case "ArrowRight":
      return clampWidth(width + step * grow, bounds);
    case "ArrowLeft":
      return clampWidth(width - step * grow, bounds);
    case "Home":
      return bounds.min;
    case "End":
      return clampWidth(bounds.max, bounds);
    default:
      return null;
  }
}

const widthOrNull = (v: unknown, bounds: Bounds): number | null => (typeof v === "number" && Number.isFinite(v) ? clampWidth(v, bounds) : null);

/** Read the stored layout, tolerating anything (missing, corrupt, older shapes, junk values). */
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
    // The window's size isn't known here; render-time CSS clamps to the current room.
    detailWidth: widthOrNull(o.detailWidth, { min: DETAIL_MIN, max: Number.MAX_SAFE_INTEGER }),
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

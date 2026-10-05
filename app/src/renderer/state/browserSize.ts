// Pure helpers for the Browser pane's size controls (Desktop | Mobile, Responsive, width × height)
// and its trackpad pinch-zoom (BrowserView), kept apart so they can be tested.

import { BROWSER_MAX_SIDE, BROWSER_MIN_SIDE, type BrowserInput, type BrowserState } from "@harness/shared";

/**
 * Whether this pane's stage size drives the tab (it sends `resize`): only while it owns Responsive.
 * A service from before per-tab sizes sends no `size`, and every pane drives it, as it always did.
 */
export function drivesSize(state: Pick<BrowserState, "size" | "sizeOwner"> | null): boolean {
  if (!state) return false;
  if (!state.size) return true;
  return state.size.responsive && state.sizeOwner === true;
}

/**
 * Whether `next` hands this pane a Responsive tab it didn't already drive: switched on here, given
 * to it as the newest viewer (a new tab, or the owner left), or owned on another tab it moved to.
 * The pane then sends its stage size even though the stage didn't change, or the tab keeps the size
 * the last owner gave it.
 */
export function takesOverSize(prev: Pick<BrowserState, "tabId" | "size" | "sizeOwner"> | null, next: Pick<BrowserState, "tabId" | "size" | "sizeOwner"> | null): boolean {
  if (!next?.size?.responsive || next.sizeOwner !== true) return false;
  return !(prev?.size?.responsive && prev.sizeOwner === true && prev.tabId === next.tabId);
}

/** How the Responsive switch looks: off, lit (this pane owns it) or dimmed-lit (another pane does). */
export type ResponsiveLook = "off" | "owned" | "following";

export function responsiveLook(state: Pick<BrowserState, "size" | "sizeOwner"> | null): ResponsiveLook {
  if (!state?.size?.responsive) return "off";
  return state.sizeOwner ? "owned" : "following";
}

/**
 * What clicking the switch sends: an owner switches it off; otherwise (off, or following another
 * pane) it's switched on for this pane, at this stage's size, which takes the ownership over.
 */
export function responsiveInput(look: ResponsiveLook, stage: { width: number; height: number }): BrowserInput {
  if (look === "owned") return { type: "responsive", on: false };
  return { type: "responsive", on: true, width: Math.round(stage.width), height: Math.round(stage.height) };
}

/**
 * A width or height input's text → a side in CSS pixels, held to BROWSER_MIN_SIDE–BROWSER_MAX_SIDE.
 * Text that isn't a number keeps `fallback` (the tab's current side).
 */
export function sideInput(text: string, fallback: number): number {
  const n = Number.parseFloat(text.trim());
  if (!Number.isFinite(n)) return fallback;
  return Math.min(BROWSER_MAX_SIDE, Math.max(BROWSER_MIN_SIDE, Math.round(n)));
}

/** What a wheel event over the frame does. */
export type WheelAction = { kind: "zoom"; factor: number } | { kind: "pan"; dx: number; dy: number } | { kind: "page" };

/**
 * A wheel event (deltas already in pixels) → zoom, pan or the page. Chromium delivers a trackpad
 * pinch as a wheel event with ctrlKey: it zooms the frame and never reaches the page (pinching
 * apart is a negative deltaY, which zooms in). While zoomed, scrolling pans the frame (the content
 * follows the fingers, as scrolling a page does); at 1× it scrolls the page.
 */
export function wheelAction(e: { ctrlKey: boolean; deltaX: number; deltaY: number }, zoomed: boolean): WheelAction {
  if (e.ctrlKey) return { kind: "zoom", factor: Math.exp(-e.deltaY / 100) };
  if (zoomed) return { kind: "pan", dx: -e.deltaX, dy: -e.deltaY };
  return { kind: "page" };
}

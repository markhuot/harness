// Whether a transcript or summaries list should keep following new content. Shared by the
// desktop and iOS scrollers so both decide "the user scrolled away" the same way.
//
// Scroll events don't say who caused them: the app's own jump to the bottom, the browser or
// UIScrollView clamping after content shrinks, a list re-measuring rows, or the user. Only the
// user moves the view *up*, away from the bottom, so that's the one signal that unpins. Content
// growing or the viewport shrinking (keyboard, a taller composer) leaves the offset alone or
// moves it down, which keeps the current state. Getting back near the bottom re-pins.
//
// On iOS that isn't enough: UIScrollView also nudges the offset up by itself while a list lays
// out, so the iOS app (StickToBottom.swift) only asks this during a drag or its momentum.

export interface ScrollMetrics {
  /** Distance scrolled from the top (scrollTop / contentOffset.y). */
  offset: number;
  /** Full scrollable height (scrollHeight / contentSize.height). */
  contentHeight: number;
  /** Visible height (clientHeight / layoutMeasurement.height). */
  viewportHeight: number;
}

/** Within this many px of the bottom counts as "at the bottom" for re-pinning. */
export const STICK_THRESHOLD = 48;

export function distanceFromBottom(m: ScrollMetrics): number {
  return m.contentHeight - m.offset - m.viewportHeight;
}

/** The next pinned state after a scroll event, given the offset from the previous event. */
export function nextPinned(pinned: boolean, prevOffset: number, m: ScrollMetrics, threshold = STICK_THRESHOLD): boolean {
  const distance = distanceFromBottom(m);
  // A clamp after content shrinks also moves the offset up, but lands on the bottom (distance ~0).
  if (m.offset < prevOffset - 1 && distance > 2) return false;
  if (distance <= threshold) return true;
  return pinned;
}

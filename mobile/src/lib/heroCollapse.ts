// When the ticket hero (title, badges, actions) gets out of the way (ui/heroCollapse.tsx): a
// gesture that scrolls a tab's body forward hides it and one that scrolls back brings it back, like
// Safari's toolbars. The tab strip stays put, so the hero reads as the top of the page scrolling
// off.
//
// Only a gesture (a drag and the momentum after it) toggles it, and at most once: hiding the hero
// grows the tab body's viewport, and UIKit then clamps an offset that was near the bottom, which
// would otherwise read as scrolling back and bring the hero straight back.

import type { ScrollMetrics } from "@harness/shared/state";

/** How far one gesture scrolls one way before the hero hides or comes back. */
export const COLLAPSE_THRESHOLD = 24;

export interface Collapse {
  hidden: boolean;
  /** A drag or its momentum is under way and hasn't toggled the hero yet. */
  live: boolean;
  /** Where the gesture's current run in one direction started. */
  anchor: number;
}

export const SHOWN: Collapse = { hidden: false, live: false, anchor: 0 };

export type CollapseEvent =
  | ({ type: "beginDrag" } & ScrollMetrics)
  | ({ type: "scroll" } & ScrollMetrics)
  /** velocity: the drag's release velocity; none means no momentum phase follows. */
  | { type: "endDrag"; velocity: number }
  | { type: "momentumEnd" }
  /** A status-bar tap, another tab, a tap on the current one, news on the ticket. */
  | { type: "show" };

/** The offset inside the scrollable range: bounces past either end don't count as scrolling. */
const clamped = (m: ScrollMetrics) => Math.min(Math.max(m.offset, 0), Math.max(0, m.contentHeight - m.viewportHeight));

/** The state after an event. heroHeight: how much taller the tab body gets with the hero hidden. */
export function collapseStep(s: Collapse, e: CollapseEvent, heroHeight: number): Collapse {
  switch (e.type) {
    case "beginDrag":
      return { ...s, live: true, anchor: clamped(e) };
    case "endDrag":
      return e.velocity ? s : { ...s, live: false };
    case "momentumEnd":
      return { ...s, live: false };
    case "show":
      return SHOWN;
    case "scroll": {
      if (!s.live) return s;
      const y = clamped(e);
      if (s.hidden) {
        if (y <= 0 || s.anchor - y >= COLLAPSE_THRESHOLD) return { hidden: false, live: false, anchor: y };
        return { ...s, anchor: Math.max(s.anchor, y) };
      }
      // With the hero gone the body must still scroll, or nothing could bring the hero back.
      const room = e.contentHeight - e.viewportHeight - heroHeight;
      if (y - s.anchor >= COLLAPSE_THRESHOLD && room >= COLLAPSE_THRESHOLD) return { hidden: true, live: false, anchor: y };
      return { ...s, anchor: Math.min(s.anchor, y) };
    }
  }
}

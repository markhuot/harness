// The gesture gating behind useStickToBottom (ui/stickToBottom.ts), apart from React and UIKit:
// which scroll events may unpin or re-pin the list (nextPinned decides how), and when to jump to
// the end.
//
// Only a gesture (a drag, the momentum after it, a status-bar tap) can unpin or re-pin. UIKit and
// FlatList move the offset on their own too: when the viewport changes height while a list lays
// out, iOS nudges the offset up with no finger down, and reading that as the user scrolling away
// is what left the transcript stranded mid-list.

import { nextPinned, type ScrollMetrics } from "@harness/shared/state";

export interface Stick {
  pinned: boolean;
  /** Finger on the list: don't move it. */
  dragging: boolean;
  /** A drag or its momentum is under way: scroll events are the user's. */
  gesture: boolean;
  lastOffset: number;
}

export const STUCK: Stick = { pinned: true, dragging: false, gesture: false, lastOffset: 0 };

export type StickEvent =
  | ({ type: "scroll" } & ScrollMetrics)
  | ({ type: "beginDrag" } & ScrollMetrics)
  /** velocity: the drag's vertical release velocity; none means no momentum phase follows. */
  | ({ type: "endDrag"; velocity: number } & ScrollMetrics)
  | { type: "momentumBegin" }
  | ({ type: "momentumEnd" } & ScrollMetrics)
  | { type: "scrollToTop" }
  /** The content grew or shrank, or the viewport was laid out again. */
  | { type: "resize" };

/** The state after an event, and whether to jump to the end now. */
export function stickStep(s: Stick, e: StickEvent): { stick: Stick; follow: boolean } {
  const track = (x: Stick, m: ScrollMetrics): Stick => ({ ...x, pinned: x.gesture ? nextPinned(x.pinned, x.lastOffset, m) : x.pinned, lastOffset: m.offset });
  const follows = (x: Stick) => x.pinned && !x.dragging;
  // The gesture is over: re-follow if it ended at the bottom. iOS also reports a momentum end
  // after a programmatic jump, which isn't a gesture and changes nothing.
  const settle = (x: Stick, m: ScrollMetrics) => {
    const t = track(x, m);
    return t.gesture ? { stick: { ...t, gesture: false }, follow: follows(t) } : { stick: t, follow: false };
  };
  switch (e.type) {
    case "scroll":
      return { stick: track(s, e), follow: false };
    case "beginDrag":
      return { stick: track({ ...s, dragging: true, gesture: true }, e), follow: false };
    case "endDrag": {
      const t = track({ ...s, dragging: false }, e);
      return e.velocity ? { stick: t, follow: false } : settle(t, e);
    }
    case "momentumBegin":
      return { stick: { ...s, gesture: true }, follow: false };
    case "momentumEnd":
      return settle(s, e);
    case "scrollToTop":
      return { stick: { ...s, pinned: false }, follow: false };
    case "resize":
      return { stick: s, follow: follows(s) };
  }
}

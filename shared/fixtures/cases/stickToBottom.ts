// Stick-to-bottom scrolling (shared/src/state/stickToBottom.ts and mobile/src/lib/stickToBottom.ts)
// for HarnessKit's StickToBottom.swift.
import { type Stick, type StickEvent, stickStep, STUCK } from "../../../mobile/src/lib/stickToBottom";
import { distanceFromBottom, nextPinned, type ScrollMetrics, STICK_THRESHOLD } from "../../src/state/stickToBottom";
import { cases } from "../case";

export const constants = { STICK_THRESHOLD, STUCK };

const at = (offset: number, contentHeight = 2000, viewportHeight = 500): ScrollMetrics => ({ offset, contentHeight, viewportHeight });

export const distanceFromBottomCases = cases(distanceFromBottom, {
  "at the bottom": at(1500),
  "above the bottom": at(1000),
  "bounced past the bottom": at(1600),
  "content shorter than the viewport": at(0, 300),
});

type PinnedInput = { pinned: boolean; prevOffset: number; m: ScrollMetrics; threshold?: number };

export const nextPinnedCases = cases(({ pinned, prevOffset, m, threshold }: PinnedInput) => nextPinned(pinned, prevOffset, m, threshold), {
  // stickToBottom.test.ts
  "scrolling up unpins": { pinned: true, prevOffset: 1500, m: at(1480) },
  "content growing keeps pinned": { pinned: true, prevOffset: 1500, m: at(1500, 3000) },
  "undershooting jump stays pinned": { pinned: true, prevOffset: 1000, m: at(1200, 3000) },
  "clamp after shrink stays pinned": { pinned: true, prevOffset: 1500, m: at(1300, 1800) },
  "viewport shrinking keeps pinned": { pinned: true, prevOffset: 1500, m: at(1500, 2000, 200) },
  "viewport shrinking keeps unpinned": { pinned: false, prevOffset: 800, m: at(800, 2000, 200) },
  "content growing stays unpinned": { pinned: false, prevOffset: 800, m: at(800, 3000) },
  "scrolling down short stays unpinned": { pinned: false, prevOffset: 800, m: at(1200) },
  "back within threshold re-pins": { pinned: false, prevOffset: 1400, m: at(1460) },
  "just outside threshold": { pinned: false, prevOffset: 1400, m: at(1451) },
  // boundaries
  "exactly at threshold": { pinned: false, prevOffset: 1400, m: at(1452) },
  "up by exactly 1 is not a scroll up": { pinned: true, prevOffset: 1001, m: at(1000) },
  "up by just over 1": { pinned: true, prevOffset: 1001.5, m: at(1000) },
  "up landing 2 from the bottom stays pinned": { pinned: true, prevOffset: 1600, m: at(1498) },
  "up landing just over 2 from the bottom unpins": { pinned: true, prevOffset: 1600, m: at(1497.5) },
  "custom threshold re-pins": { pinned: false, prevOffset: 1000, m: at(1300), threshold: 200 },
  "custom zero threshold": { pinned: false, prevOffset: 1000, m: at(1499), threshold: 0 },
  "short content is at the bottom": { pinned: false, prevOffset: 0, m: at(0, 300) },
});

// stickStep, as event sequences (stickToBottom.test.ts runs them through `run`).

const at6 = (offset: number, contentHeight = 2000): ScrollMetrics => ({ offset, contentHeight, viewportHeight: 600 });
const dragUp: StickEvent[] = [
  { type: "beginDrag", ...at6(1400) },
  { type: "scroll", ...at6(1100) },
  { type: "endDrag", velocity: 0, ...at6(1000) },
];

function run({ from, events }: { from: Stick; events: StickEvent[] }) {
  let stick = from;
  const steps: { stick: Stick; follow: boolean }[] = [];
  for (const e of events) {
    const r = stickStep(stick, e);
    stick = r.stick;
    steps.push(r);
  }
  return steps;
}

const pinnedAtBottom: Stick = { ...STUCK, lastOffset: 1400 };
const unpinned = run({ from: pinnedAtBottom, events: dragUp }).at(-1)!.stick;

export const stickStepCases = cases(run, {
  // stickToBottom.test.ts
  "new content follows while pinned": { from: pinnedAtBottom, events: [{ type: "resize" }] },
  "nudge without a finger doesn't unpin": { from: pinnedAtBottom, events: [{ type: "scroll", ...at6(1100) }, { type: "resize" }] },
  "dragging up unpins": { from: pinnedAtBottom, events: [...dragUp, { type: "resize" }] },
  "no follow while dragging": { from: pinnedAtBottom, events: [{ type: "beginDrag", ...at6(1400) }, { type: "resize" }] },
  "fling back re-pins at momentum end": {
    from: pinnedAtBottom,
    events: [
      ...dragUp,
      { type: "beginDrag", ...at6(1000) },
      { type: "endDrag", velocity: 2, ...at6(1200) },
      { type: "momentumBegin" },
      { type: "scroll", ...at6(1390) },
      { type: "momentumEnd", ...at6(1400) },
    ],
  },
  "momentum end without a gesture": { from: unpinned, events: [{ type: "momentumEnd", ...at6(1400) }] },
  "status-bar tap unpins": { from: pinnedAtBottom, events: [{ type: "scrollToTop" }, { type: "resize" }] },
  // more
  "drag released at the bottom re-pins and follows": {
    from: unpinned,
    events: [
      { type: "beginDrag", ...at6(1000) },
      { type: "scroll", ...at6(1380) },
      { type: "endDrag", velocity: 0, ...at6(1390) },
    ],
  },
  "drag released short stays unpinned": {
    from: unpinned,
    events: [
      { type: "beginDrag", ...at6(1000) },
      { type: "endDrag", velocity: 0, ...at6(1200) },
      { type: "resize" },
    ],
  },
  "negative velocity also waits for momentum": {
    from: pinnedAtBottom,
    events: [
      { type: "beginDrag", ...at6(1400) },
      { type: "endDrag", velocity: -1.5, ...at6(1300) },
      { type: "resize" },
      { type: "momentumBegin" },
      { type: "momentumEnd", ...at6(900) },
      { type: "resize" },
    ],
  },
  "momentum begin without a drag makes scrolls count": {
    from: pinnedAtBottom,
    events: [{ type: "momentumBegin" }, { type: "scroll", ...at6(1000) }, { type: "momentumEnd", ...at6(900) }],
  },
  "scroll while unpinned tracks the offset only": { from: unpinned, events: [{ type: "scroll", ...at6(1400) }, { type: "resize" }] },
  "status-bar tap during a drag": { from: pinnedAtBottom, events: [{ type: "beginDrag", ...at6(1400) }, { type: "scrollToTop" }, { type: "endDrag", velocity: 0, ...at6(1400) }] },
  "content shrink clamp during a drag stays pinned": {
    from: pinnedAtBottom,
    events: [
      { type: "beginDrag", ...at6(1400) },
      { type: "scroll", ...at6(1200, 1800) },
      { type: "endDrag", velocity: 0, ...at6(1200, 1800) },
    ],
  },
  "no events": { from: STUCK, events: [] },
});

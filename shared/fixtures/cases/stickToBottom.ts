// Stick-to-bottom scrolling for HarnessKit's StickToBottom.swift. shared/src/state/stickToBottom.ts
// is computed; the gesture state machine (stickStep and its STUCK start state, from the retired RN
// app, now only in Swift) is frozen.
import { distanceFromBottom, nextPinned, type ScrollMetrics, STICK_THRESHOLD } from "../../src/state/stickToBottom";
import { cases, frozen } from "../case";

export const constants = { STICK_THRESHOLD, STUCK: frozen<{ STUCK: unknown }>("stickToBottom", "constants").STUCK };

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

// Frozen: stickStep, as event sequences (StickToBottom.swift is the only implementation).
export const stickStepCases = frozen("stickToBottom", "stickStepCases");

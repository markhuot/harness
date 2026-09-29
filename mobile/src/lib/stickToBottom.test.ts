import { describe, expect, test } from "bun:test";
import { stickStep, STUCK, type Stick, type StickEvent } from "./stickToBottom";

// A 2000pt list in a 600pt viewport: the bottom is offset 1400.
const at = (offset: number, contentHeight = 2000) => ({ offset, contentHeight, viewportHeight: 600 });
function run(events: StickEvent[], from: Stick = { ...STUCK, lastOffset: 1400 }) {
  let stick = from;
  const follows: boolean[] = [];
  for (const e of events) {
    const r = stickStep(stick, e);
    stick = r.stick;
    follows.push(r.follow);
  }
  return { stick, follows };
}
const dragUp: StickEvent[] = [
  { type: "beginDrag", ...at(1400) },
  { type: "scroll", ...at(1100) },
  { type: "endDrag", velocity: 0, ...at(1000) },
];

describe("stickStep", () => {
  test("new content follows while pinned", () => {
    expect(run([{ type: "resize" }]).follows).toEqual([true]);
  });

  test("an offset nudge with no finger down doesn't unpin (UIKit relayout)", () => {
    const { stick, follows } = run([{ type: "scroll", ...at(1100) }, { type: "resize" }]);
    expect(stick.pinned).toBe(true);
    expect(follows).toEqual([false, true]);
  });

  test("dragging up unpins, and new content then leaves the view alone", () => {
    const { stick, follows } = run([...dragUp, { type: "resize" }]);
    expect(stick.pinned).toBe(false);
    expect(follows.at(-1)).toBe(false);
  });

  test("nothing follows while the finger is still down, even pinned", () => {
    const { follows } = run([{ type: "beginDrag", ...at(1400) }, { type: "resize" }]);
    expect(follows).toEqual([false, false]);
  });

  test("a fling back to the bottom re-pins when its momentum ends", () => {
    const { stick, follows } = run([
      ...dragUp,
      { type: "beginDrag", ...at(1000) },
      { type: "endDrag", velocity: 2, ...at(1200) },
      { type: "momentumBegin" },
      { type: "scroll", ...at(1390) },
      { type: "momentumEnd", ...at(1400) },
    ]);
    expect(stick.pinned).toBe(true);
    expect(stick.gesture).toBe(false);
    expect(follows.at(-1)).toBe(true);
    // A release with velocity waits for the momentum instead of settling.
    expect(follows[4]).toBe(false);
  });

  test("a momentum end after a programmatic jump (no gesture) changes nothing", () => {
    const unpinned = run(dragUp).stick;
    const { stick, follows } = run([{ type: "momentumEnd", ...at(1400) }], unpinned);
    expect(stick.pinned).toBe(false);
    expect(follows).toEqual([false]);
  });

  test("a status-bar tap unpins", () => {
    const { stick, follows } = run([{ type: "scrollToTop" }, { type: "resize" }]);
    expect(stick.pinned).toBe(false);
    expect(follows).toEqual([false, false]);
  });
});

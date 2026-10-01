import { describe, expect, test } from "bun:test";
import { collapseStep, SHOWN, type Collapse, type CollapseEvent } from "./heroCollapse";

// A 2000pt body in a 600pt viewport (the bottom is offset 1400), under a 200pt hero.
const HERO = 200;
const at = (offset: number, contentHeight = 2000) => ({ offset, contentHeight, viewportHeight: 600 });
const run = (events: CollapseEvent[], from: Collapse = SHOWN) => events.reduce((s, e) => collapseStep(s, e, HERO), from);
const drag = (from: number, to: number, contentHeight?: number): CollapseEvent[] => [
  { type: "beginDrag", ...at(from, contentHeight) },
  { type: "scroll", ...at(to, contentHeight) },
  { type: "endDrag", velocity: 0 },
];

describe("collapseStep", () => {
  test("scrolling forward past the threshold hides the hero", () => {
    expect(run(drag(300, 330)).hidden).toBe(true);
  });

  test("a nudge under the threshold leaves it", () => {
    expect(run(drag(300, 310)).hidden).toBe(false);
  });

  test("scrolling back brings it back", () => {
    const hidden = run(drag(300, 400));
    expect(run(drag(400, 360), hidden).hidden).toBe(false);
  });

  test("the threshold counts from where the gesture turned, not where it began", () => {
    // Back 20 (under the threshold), then forward 30 from there: 10 past the start.
    const s = run([{ type: "beginDrag", ...at(300) }, { type: "scroll", ...at(280) }, { type: "scroll", ...at(310) }]);
    expect(s.hidden).toBe(true);
  });

  test("offsets that change with no finger down don't count (stick-to-bottom, relayout)", () => {
    expect(run([{ type: "scroll", ...at(300) }, { type: "scroll", ...at(900) }]).hidden).toBe(false);
  });

  test("the momentum after a flick still counts, and ends the gesture when it settles", () => {
    const flick: CollapseEvent[] = [{ type: "beginDrag", ...at(300) }, { type: "scroll", ...at(310) }, { type: "endDrag", velocity: 2 }, { type: "scroll", ...at(360) }];
    expect(run(flick).hidden).toBe(true);
    const settled = run([{ type: "beginDrag", ...at(300) }, { type: "endDrag", velocity: 2 }, { type: "momentumEnd" }, { type: "scroll", ...at(360) }]);
    expect(settled.hidden).toBe(false);
  });

  test("one gesture toggles once: the offset UIKit clamps after hiding doesn't bring it back", () => {
    // Hidden at the bottom; the taller viewport clamps the offset from 1400 to 1200 mid-momentum.
    const s = run([{ type: "beginDrag", ...at(1300) }, { type: "endDrag", velocity: 3 }, { type: "scroll", ...at(1400) }, { type: "scroll", offset: 1200, contentHeight: 2000, viewportHeight: 800 }]);
    expect(s.hidden).toBe(true);
  });

  test("the bounce back from pulling past the bottom isn't scrolling back", () => {
    const hidden = run(drag(1300, 1400));
    const s = run([{ type: "beginDrag", ...at(1400) }, { type: "scroll", ...at(1500) }, { type: "endDrag", velocity: 0 }], hidden);
    expect(run([{ type: "beginDrag", ...at(1500) }, { type: "scroll", ...at(1400) }], s).hidden).toBe(true);
  });

  test("the top brings it back, even closer than the threshold", () => {
    const hidden: Collapse = { hidden: true, live: false, anchor: 0 };
    expect(run(drag(10, -40), hidden).hidden).toBe(false);
  });

  test("a body that would fit once the hero is gone never hides it", () => {
    // 900pt in 600pt: 300 to scroll now, 100 with the hero gone, which is enough.
    expect(run(drag(0, 100, 900)).hidden).toBe(true);
    // 810pt: only 10 left with the hero gone, too little to scroll it back.
    expect(run(drag(0, 100, 810)).hidden).toBe(false);
  });

  test("show resets it", () => {
    expect(collapseStep(run(drag(300, 400)), { type: "show" }, HERO)).toEqual(SHOWN);
  });
});

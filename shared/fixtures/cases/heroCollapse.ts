// The ticket hero's collapse while a tab body scrolls (mobile/src/lib/heroCollapse.ts) for
// HarnessKit's HeroCollapse.swift. Each case runs an event sequence through collapseStep and records
// the state after every step.
import { collapseStep, COLLAPSE_THRESHOLD, SHOWN, type Collapse, type CollapseEvent } from "../../../mobile/src/lib/heroCollapse";
import { cases } from "../case";

export const constants = { COLLAPSE_THRESHOLD, SHOWN };

// A 2000pt body in a 600pt viewport (the bottom is offset 1400), under a 200pt hero.
const HERO = 200;
const at = (offset: number, contentHeight = 2000, viewportHeight = 600) => ({ offset, contentHeight, viewportHeight });
const drag = (from: number, to: number, contentHeight?: number): CollapseEvent[] => [
  { type: "beginDrag", ...at(from, contentHeight) },
  { type: "scroll", ...at(to, contentHeight) },
  { type: "endDrag", velocity: 0 },
];

type Input = { from: Collapse; heroHeight: number; events: CollapseEvent[] };

function run({ from, heroHeight, events }: Input): Collapse[] {
  let s = from;
  return events.map((e) => (s = collapseStep(s, e, heroHeight)));
}

const hidden: Collapse = { hidden: true, live: false, anchor: 400 };
const input = (events: CollapseEvent[], from: Collapse = SHOWN, heroHeight = HERO): Input => ({ from, heroHeight, events });

export const collapseStepCases = cases(run, {
  // heroCollapse.test.ts
  "scrolling forward past the threshold hides the hero": input(drag(300, 330)),
  "a nudge under the threshold leaves it": input(drag(300, 310)),
  "scrolling back brings it back": input(drag(400, 360), hidden),
  "the threshold counts from where the gesture turned": input([{ type: "beginDrag", ...at(300) }, { type: "scroll", ...at(280) }, { type: "scroll", ...at(310) }]),
  "offsets with no finger down don't count": input([{ type: "scroll", ...at(300) }, { type: "scroll", ...at(900) }]),
  "the momentum after a flick still counts": input([{ type: "beginDrag", ...at(300) }, { type: "scroll", ...at(310) }, { type: "endDrag", velocity: 2 }, { type: "scroll", ...at(360) }]),
  "momentum end ends the gesture": input([{ type: "beginDrag", ...at(300) }, { type: "endDrag", velocity: 2 }, { type: "momentumEnd" }, { type: "scroll", ...at(360) }]),
  "one gesture toggles once": input([{ type: "beginDrag", ...at(1300) }, { type: "endDrag", velocity: 3 }, { type: "scroll", ...at(1400) }, { type: "scroll", ...at(1200, 2000, 800) }]),
  "the bounce back past the bottom isn't scrolling back": input([
    ...drag(1300, 1400),
    { type: "beginDrag", ...at(1400) },
    { type: "scroll", ...at(1500) },
    { type: "endDrag", velocity: 0 },
    { type: "beginDrag", ...at(1500) },
    { type: "scroll", ...at(1400) },
  ]),
  "the top brings it back, even closer than the threshold": input(drag(10, -40), { hidden: true, live: false, anchor: 0 }),
  "a body with room left once the hero is gone hides it": input(drag(0, 100, 900)),
  "a body that would fit once the hero is gone never hides it": input(drag(0, 100, 810)),
  "show resets it": input([...drag(300, 400), { type: "show" }]),
  // boundaries
  "exactly the threshold forward hides": input(drag(300, 300 + COLLAPSE_THRESHOLD)),
  "just under the threshold forward stays": input(drag(300, 300 + COLLAPSE_THRESHOLD - 0.5)),
  "exactly the threshold back shows": input(drag(400, 400 - COLLAPSE_THRESHOLD), hidden),
  "just under the threshold back stays hidden": input(drag(400, 400 - COLLAPSE_THRESHOLD + 0.5), hidden),
  "room exactly the threshold hides": input(drag(0, 100, 600 + HERO + COLLAPSE_THRESHOLD)),
  "room just under the threshold stays": input(drag(0, 100, 600 + HERO + COLLAPSE_THRESHOLD - 1)),
  "hidden, scrolling further forward moves the anchor": input([{ type: "beginDrag", ...at(400) }, { type: "scroll", ...at(600) }, { type: "scroll", ...at(590) }], hidden),
  "a drag ending with velocity stays live": input([{ type: "beginDrag", ...at(300) }, { type: "endDrag", velocity: -1 }]),
  "zero hero height": input(drag(0, 30, 650), SHOWN, 0),
});

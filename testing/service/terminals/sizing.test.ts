import { expect, test } from "bun:test";
import { MAX_TERMINAL_COLS, MIN_TERMINAL_COLS, MIN_TERMINAL_ROWS } from "@harness/shared";
import { clampSize, SizeCoordinator, watchesTerminal, type Size } from "../../../service/src/terminals/sizing";
import { manualTimers } from "./fakes";

test("clampSize floors fractions, clamps to the limits and refuses nonsense", () => {
  expect(clampSize(80.9, 24.2)).toEqual({ cols: 80, rows: 24 });
  expect(clampSize(1, 1)).toEqual({ cols: MIN_TERMINAL_COLS, rows: MIN_TERMINAL_ROWS });
  expect(clampSize(1e9, 24)!.cols).toBe(MAX_TERMINAL_COLS);
  for (const [c, r] of [[0, 24], [80, -1], [NaN, 24], ["80", 24], [0.5, 24], [Infinity, 24]] as const) expect(clampSize(c, r)).toBeNull();
});

test("a client counts unless its presence says it's hidden or showing other terminals", () => {
  expect(watchesTerminal(null, "t-1")).toBe(true);
  expect(watchesTerminal({ visible: true }, "t-1")).toBe(true);
  expect(watchesTerminal({ visible: false, terminals: ["t-1"] }, "t-1")).toBe(false);
  expect(watchesTerminal({ visible: true, terminals: ["t-2"] }, "t-1")).toBe(false);
  expect(watchesTerminal({ visible: true, terminals: ["t-1"] }, "t-1")).toBe(true);
});

function rig(opts: { initial?: Size } = {}) {
  const clock = manualTimers(1_000);
  const applied: Size[] = [];
  const sizes = new SizeCoordinator({ initial: opts.initial ?? { cols: 80, rows: 24 }, apply: (s) => applied.push(s), now: clock.now, timers: clock.timers });
  return { clock, applied, sizes };
}

test("the first client to attach gets its own size at once, even a larger one", () => {
  const { applied, sizes } = rig();
  expect(sizes.report("a", 120, 40)).toBe(true);
  expect(applied).toEqual([{ cols: 120, rows: 40 }]);
  expect(sizes.size).toEqual({ cols: 120, rows: 40 });
});

test("an unusable report is refused and changes nothing", () => {
  const { applied, sizes } = rig();
  expect(sizes.report("a", 0, 0)).toBe(false);
  expect(applied).toEqual([]);
  expect(sizes.clientCount).toBe(0);
});

test("a second, smaller client shrinks the shell right away; leaving makes it grow back only after the grow delay", () => {
  const { clock, applied, sizes } = rig();
  sizes.report("big", 120, 40);
  clock.advance(200); // the first report's debounce window closes
  sizes.report("small", 60, 20);
  expect(applied.at(-1)).toEqual({ cols: 60, rows: 20 });
  clock.advance(200);
  sizes.remove("small");
  expect(sizes.size).toEqual({ cols: 60, rows: 20 });
  clock.advance(1499);
  expect(sizes.size).toEqual({ cols: 60, rows: 20 });
  clock.advance(1);
  expect(sizes.size).toEqual({ cols: 120, rows: 40 });
});

test("reports inside the debounce window coalesce into one trailing evaluation", () => {
  const { clock, applied, sizes } = rig();
  sizes.report("a", 100, 30);
  clock.advance(200);
  sizes.report("b", 90, 30);
  const afterB = applied.length;
  sizes.report("b", 80, 30);
  sizes.report("b", 70, 30);
  expect(applied.length).toBe(afterB); // held back
  clock.advance(100);
  expect(applied.at(-1)).toEqual({ cols: 70, rows: 30 });
  expect(applied.length).toBe(afterB + 1);
});

test("a client that isn't counted doesn't hold the size down, unless nobody is counted", () => {
  const { clock, applied, sizes } = rig();
  sizes.report("watching", 100, 30);
  clock.advance(200);
  sizes.report("away", 50, 10, false);
  expect(sizes.size).toEqual({ cols: 100, rows: 30 });
  clock.advance(200);
  sizes.setCounted("watching", false);
  expect(sizes.size).toEqual({ cols: 50, rows: 10 });
  expect(applied.at(-1)).toEqual({ cols: 50, rows: 10 });
});

test("a client that goes quiet past the expiry is swept and its size stops counting", () => {
  const { clock, sizes } = rig();
  sizes.report("big", 120, 40);
  clock.advance(200);
  sizes.report("phone", 40, 20);
  clock.advance(10_000);
  sizes.touch("big");
  clock.advance(5_001);
  expect(sizes.sweep()).toEqual(["phone"]);
  expect(sizes.clientCount).toBe(1);
  clock.advance(1500);
  expect(sizes.size).toEqual({ cols: 120, rows: 40 });
});

test("reports() says who holds the size and how stale each client is", () => {
  const { clock, sizes } = rig();
  sizes.report("a", 100, 30);
  clock.advance(500);
  expect(sizes.reports()).toEqual([{ clientId: "a", cols: 100, rows: 30, ageMs: 500, counted: true }]);
});

test("with nobody attached the last size stays; dispose cancels pending timers", () => {
  const { clock, sizes } = rig();
  sizes.report("a", 100, 30);
  clock.advance(200);
  sizes.remove("a");
  expect(sizes.size).toEqual({ cols: 100, rows: 30 });
  sizes.report("a", 100, 30);
  sizes.dispose();
  expect(clock.pending).toBe(0);
});

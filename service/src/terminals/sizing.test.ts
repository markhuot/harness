import { describe, expect, test } from "bun:test";
import { SizeCoordinator, clampSize } from "./sizing";
import { fakeClock } from "./testing";

function setup(initial = { cols: 100, rows: 40 }) {
  const clock = fakeClock();
  const applied: { cols: number; rows: number }[] = [];
  const size = new SizeCoordinator({ initial, apply: (s) => applied.push(s), now: clock.now, timers: clock.timers });
  return { clock, applied, size };
}

describe("clampSize", () => {
  test("rejects NaN, 0x0, negatives and non-numbers; clamps to the floor", () => {
    expect(clampSize(NaN, 10)).toBeNull();
    expect(clampSize(0, 0)).toBeNull();
    expect(clampSize(-3, 10)).toBeNull();
    expect(clampSize("80", 24)).toBeNull();
    expect(clampSize(5, 2)).toEqual({ cols: 20, rows: 5 });
    expect(clampSize(80.9, 24.2)).toEqual({ cols: 80, rows: 24 });
    expect(clampSize(99999, 99999)).toEqual({ cols: 1000, rows: 1000 });
  });
});

describe("SizeCoordinator", () => {
  test("a bigger client never enlarges a smaller one, in either order", () => {
    for (const order of [["mac", "phone"], ["phone", "mac"]]) {
      const { clock, applied, size } = setup();
      for (const who of order) who === "mac" ? size.report("mac", 150, 50) : size.report("phone", 60, 20);
      clock.advance(5000);
      expect(size.size).toEqual({ cols: 60, rows: 20 });
      expect(applied.at(-1)).toEqual({ cols: 60, rows: 20 });
    }
  });

  test("the size is the componentwise minimum, shrinking at once and growing after a delay", () => {
    const { clock, size } = setup({ cols: 80, rows: 24 });
    size.report("mac", 120, 40);
    clock.advance(200);
    expect(size.size).toEqual({ cols: 80, rows: 24 }); // a grow waits
    size.report("phone", 50, 60);
    clock.advance(200);
    expect(size.size).toEqual({ cols: 50, rows: 24 }); // the shrink was immediate, the rows still wait
    clock.advance(1500);
    expect(size.size).toEqual({ cols: 50, rows: 40 });
    size.remove("phone");
    clock.advance(200);
    expect(size.size).toEqual({ cols: 50, rows: 40 });
    clock.advance(1500);
    expect(size.size).toEqual({ cols: 120, rows: 40 });
  });

  test("a client that goes quiet expires after 15 s and the size returns to what the others fit", () => {
    const { clock, size } = setup();
    size.report("mac", 120, 40);
    size.report("phone", 40, 15);
    clock.advance(200);
    expect(size.size).toEqual({ cols: 40, rows: 15 });
    clock.advance(10_000);
    size.touch("mac");
    expect(size.sweep()).toEqual([]);
    clock.advance(6000);
    size.touch("mac");
    expect(size.sweep()).toEqual(["phone"]);
    clock.advance(2000);
    expect(size.size).toEqual({ cols: 120, rows: 40 });
  });

  test("touching a client keeps it alive", () => {
    const { clock, size } = setup();
    size.report("phone", 40, 15);
    for (let i = 0; i < 10; i++) {
      clock.advance(5000);
      size.touch("phone");
      expect(size.sweep()).toEqual([]);
    }
  });

  test("unusable reports are dropped and the last size is kept with no clients", () => {
    const { clock, applied, size } = setup({ cols: 90, rows: 30 });
    expect(size.report("a", 0, 0)).toBe(false);
    expect(size.report("a", NaN, 20)).toBe(false);
    expect(size.clientCount).toBe(0);
    size.report("a", 70, 20);
    clock.advance(200);
    size.remove("a");
    clock.advance(5000);
    expect(size.size).toEqual({ cols: 70, rows: 20 });
    expect(applied).toEqual([{ cols: 70, rows: 20 }]);
  });

  test("50 reports in 100 ms cause at most two resizes", () => {
    const { clock, applied, size } = setup({ cols: 100, rows: 40 });
    for (let i = 0; i < 50; i++) {
      size.report("phone", 90 - i, 30);
      clock.advance(2);
    }
    clock.advance(500);
    expect(applied.length).toBeLessThanOrEqual(2);
    expect(size.size).toEqual({ cols: 41, rows: 30 });
  });

  test("a report that doesn't change the size never resizes", () => {
    const { clock, applied, size } = setup({ cols: 80, rows: 24 });
    size.report("a", 80, 24);
    size.report("a", 80, 24);
    clock.advance(5000);
    expect(applied).toEqual([]);
  });

  test("rows below the floor clamp: a phone with the keyboard up can't shrink a shell below 5 rows", () => {
    const { clock, size } = setup();
    size.report("phone", 60, 2);
    clock.advance(200);
    expect(size.size).toEqual({ cols: 60, rows: 5 });
  });
});

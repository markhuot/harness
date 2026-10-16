import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { createRepaintTimer, forceRedraw, type RedrawTerm } from "./repaint";

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test("scheduling again before the delay replaces the pending repaint, so it runs once", () => {
  let runs = 0;
  const t = createRepaintTimer(() => runs++, 200);
  t.schedule();
  jest.advanceTimersByTime(150);
  t.schedule();
  jest.advanceTimersByTime(150);
  expect(runs).toBe(0);
  jest.advanceTimersByTime(60);
  expect(runs).toBe(1);
  jest.advanceTimersByTime(1000);
  expect(runs).toBe(1);
});

test("cancel drops the pending repaint", () => {
  let runs = 0;
  const t = createRepaintTimer(() => runs++, 200);
  t.schedule();
  t.cancel();
  jest.advanceTimersByTime(1000);
  expect(runs).toBe(0);
});

test("forceRedraw draws every row through the renderer", () => {
  const calls: unknown[][] = [];
  const term: RedrawTerm = { renderer: { render: (...a) => void calls.push(a) }, wasmTerm: "wasm", viewportY: 3, scrollbarOpacity: 0.5 };
  forceRedraw(term);
  expect(calls).toEqual([["wasm", true, 3, term, 0.5]]);
});

test("forceRedraw warns when ghostty-web's renderer is not where it was", () => {
  const warned: string[] = [];
  forceRedraw({ viewportY: 0, scrollbarOpacity: 0 }, (m) => warned.push(m));
  expect(warned).toHaveLength(1);
});

import { expect, test } from "bun:test";
import { nextPinned } from "./stickToBottom";

const at = (offset: number, contentHeight = 2000, viewportHeight = 500) => ({ offset, contentHeight, viewportHeight });

test("scrolling up away from the bottom unpins, even by less than the re-pin threshold", () => {
  expect(nextPinned(true, 1500, at(1480))).toBe(false);
});

test("content growing under a pinned view keeps it pinned (offset unchanged, now far from the bottom)", () => {
  expect(nextPinned(true, 1500, at(1500, 3000))).toBe(true);
});

test("a programmatic jump that undershoots the real bottom (estimated row heights) stays pinned", () => {
  expect(nextPinned(true, 1000, at(1200, 3000))).toBe(true);
});

test("a clamp after content shrinks moves the offset up but lands on the bottom, so it stays pinned", () => {
  expect(nextPinned(true, 1500, at(1300, 1800))).toBe(true);
});

test("the viewport shrinking (keyboard) leaves the offset alone and keeps the pinned state", () => {
  expect(nextPinned(true, 1500, at(1500, 2000, 200))).toBe(true);
  expect(nextPinned(false, 800, at(800, 2000, 200))).toBe(false);
});

test("scrolled up, content growing or scrolling down short of the bottom stays unpinned", () => {
  expect(nextPinned(false, 800, at(800, 3000))).toBe(false);
  expect(nextPinned(false, 800, at(1200))).toBe(false);
});

test("scrolling back to within the threshold of the bottom re-pins", () => {
  expect(nextPinned(false, 1400, at(1460))).toBe(true);
  expect(nextPinned(false, 1400, at(1451))).toBe(false);
});

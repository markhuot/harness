import { expect, test } from "bun:test";
import { keyboardOverlap } from "./keyboard";

// iPhone 16: 852pt tall, a 336pt keyboard whose top edge sits at 516.
const kb = { screenY: 516, height: 336 };

test("a view under a nav header is padded by the whole keyboard, not the keyboard minus the header", () => {
  // Starts 103pt down (status bar + header) and runs to the bottom of the screen.
  expect(keyboardOverlap({ y: 103, height: 749 }, kb)).toBe(336);
});

test("a view in a page sheet is padded by the whole keyboard", () => {
  expect(keyboardOverlap({ y: 118, height: 734 }, kb)).toBe(336);
});

test("a view that ends above the keyboard isn't padded; one that ends partway in is padded by the overlap", () => {
  expect(keyboardOverlap({ y: 0, height: 400 }, kb)).toBe(0);
  expect(keyboardOverlap({ y: 0, height: 600 }, kb)).toBe(84);
});

test("hidden, zero-height and floating keyboards cover nothing", () => {
  expect(keyboardOverlap({ y: 103, height: 749 }, null)).toBe(0);
  expect(keyboardOverlap({ y: 103, height: 749 }, { screenY: 852, height: 0 })).toBe(0);
  expect(keyboardOverlap({ y: 103, height: 749 }, { screenY: 0, height: 336 })).toBe(0);
});

test("the padding never exceeds the view itself", () => {
  expect(keyboardOverlap({ y: 700, height: 100 }, kb)).toBe(100);
});

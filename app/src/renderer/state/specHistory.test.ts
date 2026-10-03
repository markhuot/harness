import { describe, expect, test } from "bun:test";
import { FOLLOW_LATEST, scrubTo, shownRevision, stepRevision } from "./specHistory";

describe("spec history", () => {
  test("following shows the newest revision, and moves with a new one", () => {
    expect(shownRevision(FOLLOW_LATEST, 7)).toBe(7);
    expect(shownRevision(FOLLOW_LATEST, 8)).toBe(8);
  });

  test("stepping back pins the revision, so a new one doesn't move it", () => {
    const h = stepRevision(FOLLOW_LATEST, 7, -1);
    expect(h).toEqual({ pinned: 6 });
    expect(shownRevision(h, 8)).toBe(6);
  });

  test("stepping forward onto the newest follows live again", () => {
    const h = stepRevision({ pinned: 6 }, 7, 1);
    expect(h).toEqual(FOLLOW_LATEST);
    expect(shownRevision(h, 9)).toBe(9);
  });

  test("steps stop at the first and newest revisions", () => {
    expect(stepRevision({ pinned: 1 }, 7, -1)).toEqual({ pinned: 1 });
    expect(stepRevision(FOLLOW_LATEST, 7, 1)).toEqual(FOLLOW_LATEST);
    expect(stepRevision(FOLLOW_LATEST, 1, -1)).toEqual(FOLLOW_LATEST);
  });

  test("scrubbing clamps, and the slider's end follows", () => {
    expect(scrubTo(0, 5)).toEqual({ pinned: 1 });
    expect(scrubTo(3.4, 5)).toEqual({ pinned: 3 });
    expect(scrubTo(5, 5)).toEqual(FOLLOW_LATEST);
    expect(scrubTo(12, 5)).toEqual(FOLLOW_LATEST);
  });

  test("a pin past the newest (a stale list) shows the newest", () => {
    expect(shownRevision({ pinned: 9 }, 4)).toBe(4);
  });
});

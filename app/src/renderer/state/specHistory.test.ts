import { describe, expect, test } from "bun:test";
import { FOLLOW_LATEST, revisionAt, scrubTo, segmentTone, shownRevision, stepRevision } from "./specHistory";

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

describe("revision timeline", () => {
  test("each revision owns an equal slice of the strip", () => {
    expect(revisionAt(0, 100, 4)).toBe(1);
    expect(revisionAt(24.9, 100, 4)).toBe(1);
    expect(revisionAt(25, 100, 4)).toBe(2);
    expect(revisionAt(74.9, 100, 4)).toBe(3);
    expect(revisionAt(75, 100, 4)).toBe(4);
    expect(revisionAt(99.9, 100, 4)).toBe(4);
  });

  test("off either end clamps to the first and newest", () => {
    expect(revisionAt(-30, 100, 4)).toBe(1);
    expect(revisionAt(100, 100, 4)).toBe(4);
    expect(revisionAt(400, 100, 4)).toBe(4);
  });

  test("two revisions split the strip in half", () => {
    expect(revisionAt(49, 100, 2)).toBe(1);
    expect(revisionAt(50, 100, 2)).toBe(2);
  });

  test("more revisions than pixels still land on one revision", () => {
    expect(revisionAt(0, 120, 500)).toBe(1);
    expect(revisionAt(60, 120, 500)).toBe(251);
    expect(revisionAt(119.99, 120, 500)).toBe(500);
  });

  test("a single revision, or a strip not laid out yet, is the newest", () => {
    expect(revisionAt(50, 100, 1)).toBe(1);
    expect(revisionAt(50, 0, 6)).toBe(6);
    expect(revisionAt(50, 100, 0)).toBe(1);
  });

  test("segments before the one on show are passed, the rest ahead", () => {
    expect([1, 2, 3, 4, 5].map((r) => segmentTone(r, 3, null))).toEqual(["before", "before", "shown", "after", "after"]);
  });

  test("the approved plan is marked on either side of the one on show", () => {
    expect(segmentTone(2, 4, 2)).toBe("baseline");
    expect(segmentTone(5, 4, 5)).toBe("baseline");
  });

  test("the revision on show wins over the approved plan", () => {
    expect(segmentTone(3, 3, 3)).toBe("shown");
  });
});

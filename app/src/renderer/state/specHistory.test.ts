import { describe, expect, test } from "bun:test";
import { FOLLOW_LATEST, revisionAt, scrubTo, segmentTone, shownRevision, wheelScrub } from "./specHistory";

describe("spec history", () => {
  test("following shows the newest revision, and moves with a new one", () => {
    expect(shownRevision(FOLLOW_LATEST, 7)).toBe(7);
    expect(shownRevision(FOLLOW_LATEST, 8)).toBe(8);
  });

  test("scrubbing back pins the revision, so a new one doesn't move it", () => {
    const h = scrubTo(6, 7);
    expect(h).toEqual({ pinned: 6 });
    expect(shownRevision(h, 8)).toBe(6);
  });

  test("scrubbing onto the newest follows live again", () => {
    const h = scrubTo(7, 7);
    expect(h).toEqual(FOLLOW_LATEST);
    expect(shownRevision(h, 9)).toBe(9);
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

describe("scrolling over the history bar", () => {
  test("a trackpad's small deltas add up to one revision per step", () => {
    let r = wheelScrub(0, 0, 15, 3, 7, 40);
    expect(r).toEqual({ rev: 3, carry: 15 });
    r = wheelScrub(r.carry, 0, 15, r.rev, 7, 40);
    expect(r).toEqual({ rev: 3, carry: 30 });
    r = wheelScrub(r.carry, 0, 15, r.rev, 7, 40);
    expect(r).toEqual({ rev: 4, carry: 5 });
  });

  test("down or right is newer, up or left older, along the axis that moved more", () => {
    expect(wheelScrub(0, 0, 90, 3, 7, 40).rev).toBe(5);
    expect(wheelScrub(0, 0, -90, 3, 7, 40).rev).toBe(1);
    expect(wheelScrub(0, 45, 10, 3, 7, 40).rev).toBe(4);
    expect(wheelScrub(0, -45, 10, 3, 7, 40).rev).toBe(2);
  });

  test("turning back unwinds what's carried before moving", () => {
    const r = wheelScrub(30, 0, -20, 4, 7, 40);
    expect(r).toEqual({ rev: 4, carry: 10 });
  });

  test("at either end the extra scroll is dropped, so turning back moves at once", () => {
    const r = wheelScrub(0, 0, 400, 6, 7, 40);
    expect(r).toEqual({ rev: 7, carry: 0 });
    expect(wheelScrub(r.carry, 0, -40, r.rev, 7, 40).rev).toBe(6);
    expect(wheelScrub(0, 0, -400, 2, 7, 40)).toEqual({ rev: 1, carry: 0 });
  });
});

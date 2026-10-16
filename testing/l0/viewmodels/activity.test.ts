import { describe, expect, test } from "bun:test";
import type { ActivityEntry } from "@harness/shared";
import { ACTIVITY_KIND, activityHeading, openQuestionId } from "../../../app/src/renderer/state/activity";

type Head = Parameters<typeof activityHeading>[0];
const head = (kind: Head["kind"], meta: Head["meta"] = {}, author?: Head["author"]) => activityHeading({ kind, meta, author });

describe("activityHeading", () => {
  test("a plain entry is its kind's label; an unknown kind is shown as is", () => {
    expect(head("note")).toBe("Note");
    expect(head("blocked")).toBe("Asked you");
    expect(head("bogus" as never)).toBe("bogus");
  });
  test("a review: round, the commit's first 7 characters, and who decided", () => {
    expect(head("review_approved", { round: 2, commit: "1a2b3c4d5e6f", by: "agent" })).toBe("Review approved · round 2 · 1a2b3c4 · by agent");
    expect(head("changes_requested", { round: 1, by: "human" })).toBe("Changes requested · round 1 · by you");
    expect(head("review_approved", { by: "conductor" })).toBe("Review approved · by conductor");
  });
  test("a null commit and round 0 add nothing", () => {
    expect(head("review_approved", { round: 0, commit: null })).toBe("Review approved");
  });
  test("approved shows who, but not round or commit", () => {
    expect(head("approved", { by: "human", round: 3, commit: "abcdefg123" })).toBe("Approved · by you");
  });
  test("who decided is ignored on kinds that don't decide", () => {
    expect(head("note", { by: "agent", round: 2 })).toBe("Note");
  });
  test("submitted and revised entries name the spec revision", () => {
    expect(head("submitted", { specRevision: 7 })).toBe("Submitted for review · spec rev 7");
    expect(head("spec_revised", { specRevision: 3 }, "agent")).toBe("Spec revised · rev 3");
    expect(head("note", { specRevision: 3 })).toBe("Note");
  });
  test("a human's spec revision says by you, even without a revision number", () => {
    expect(head("spec_revised", { specRevision: 3 }, "human")).toBe("Spec revised · rev 3 · by you");
    expect(head("spec_revised", {}, "human")).toBe("Spec revised · by you");
    expect(head("note", {}, "human")).toBe("Note");
  });
  test("a move ends with the column it went to; an unknown column adds nothing", () => {
    expect(head("submitted", { specRevision: 7, to: "review" })).toBe("Submitted for review · spec rev 7 → Review");
    expect(head("moved", { to: "in_progress" })).toBe("Moved → In progress");
    expect(head("moved", { to: "limbo" as never })).toBe("Moved");
  });
  test("missing meta is fine", () => {
    expect(activityHeading({ kind: "system", meta: undefined as never })).toBe("Harness");
  });
});

describe("ACTIVITY_KIND", () => {
  test("every kind has a distinct label", () => {
    const labels = Object.values(ACTIVITY_KIND).map((k) => k.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("openQuestionId", () => {
  const e = (id: string, kind: ActivityEntry["kind"]) => ({ id, kind });
  test("the newest blocked entry while blocked", () => {
    expect(openQuestionId([e("1", "blocked"), e("2", "unblocked"), e("3", "blocked"), e("4", "note")], "blocked")).toBe("3");
  });
  test("none when the ticket isn't blocked, or no entry asked", () => {
    expect(openQuestionId([e("1", "blocked")], "in_progress")).toBeUndefined();
    expect(openQuestionId([e("1", "note")], "blocked")).toBeUndefined();
    expect(openQuestionId([], "blocked")).toBeUndefined();
  });
});

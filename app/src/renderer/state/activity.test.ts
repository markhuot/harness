import { describe, expect, test } from "bun:test";
import { activityHeading, openQuestionId } from "./activity";

describe("activityHeading", () => {
  test("review decisions show the round, the short commit and who decided", () => {
    expect(activityHeading({ kind: "changes_requested", meta: { round: 2, commit: "1a2b3c4d5e6f", by: "agent" } })).toBe("Changes requested · round 2 · 1a2b3c4 · by agent");
    expect(activityHeading({ kind: "review_approved", meta: { round: 1, commit: null } })).toBe("Review approved · round 1");
  });

  test("a submit shows its spec revision; other kinds ignore review meta", () => {
    expect(activityHeading({ kind: "submitted", meta: { specRevision: 7 } })).toBe("Submitted for review · spec rev 7");
    expect(activityHeading({ kind: "note", meta: { round: 3, commit: "abcdef0" } })).toBe("Note");
  });

  test("a spec revision shows its number, and says so when the human wrote it", () => {
    expect(activityHeading({ kind: "spec_revised", author: "agent", meta: { specRevision: 3 } })).toBe("Spec revised · rev 3");
    expect(activityHeading({ kind: "spec_revised", author: "human", meta: { specRevision: 4 } })).toBe("Spec revised · rev 4 · by you");
    expect(activityHeading({ kind: "note", author: "human", meta: { specRevision: 4 } })).toBe("Note");
  });
});

describe("openQuestionId", () => {
  const list = [
    { id: "a", kind: "blocked" as const },
    { id: "b", kind: "unblocked" as const },
    { id: "c", kind: "blocked" as const },
    { id: "d", kind: "message" as const },
  ];
  test("the newest blocked entry, while the ticket is blocked", () => {
    expect(openQuestionId(list, "blocked")).toBe("c");
  });
  test("none once the ticket moved on, or without a blocked entry", () => {
    expect(openQuestionId(list, "in_progress")).toBeUndefined();
    expect(openQuestionId(list.slice(1, 2), "blocked")).toBeUndefined();
  });
});


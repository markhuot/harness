import { describe, expect, test } from "bun:test";
import { skipReviewHint } from "./newSession";

describe("skipReviewHint", () => {
  test("in review, the switch acts on the agent review right away", () => {
    expect(skipReviewHint({ status: "review", agentReview: "skipped", skipAgentReview: true })).toBe("Off starts the review");
    expect(skipReviewHint({ status: "review", agentReview: "pending", skipAgentReview: false })).toBe("On skips the pending review");
  });
  test("a finished agent review, or a ticket not in review, waits for the next submit", () => {
    expect(skipReviewHint({ status: "review", agentReview: "approved", skipAgentReview: false })).toBe("When it's submitted");
    expect(skipReviewHint({ status: "in_progress", agentReview: "pending", skipAgentReview: false })).toBe("When it's submitted");
    expect(skipReviewHint({ status: "in_progress", agentReview: "skipped", skipAgentReview: true })).toBe("When it's submitted");
  });
});

import { describe, expect, test } from "bun:test";
import { skipReviewHint } from "./newSession";

describe("skipReviewHint", () => {
  test("says what flipping the switch does to a ticket in review", () => {
    expect(skipReviewHint({ status: "review", agentReview: "skipped", skipAgentReview: true })).toMatch(/starts the agent review/);
    expect(skipReviewHint({ status: "review", agentReview: "pending", skipAgentReview: false })).toMatch(/skips the pending/);
  });

  test("otherwise it applies at the next submit", () => {
    // Approved already: turning it on changes nothing now.
    expect(skipReviewHint({ status: "review", agentReview: "approved", skipAgentReview: false })).toMatch(/when it's submitted/);
    expect(skipReviewHint({ status: "in_progress", agentReview: "pending", skipAgentReview: false })).toMatch(/when it's submitted/);
  });
});

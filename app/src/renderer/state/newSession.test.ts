import { describe, expect, test } from "bun:test";
import { skipHumanReviewHint, skipReviewHint } from "./newSession";

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

describe("skipHumanReviewHint", () => {
  const t = { status: "review" as const, agentReview: "pending" as const, humanReview: "pending" as const, skipAgentReview: false, skipHumanReview: false };

  test("in review, says whether turning it on lands the ticket now or after the agent review", () => {
    expect(skipHumanReviewHint(t)).toMatch(/once its agent review passes/);
    expect(skipHumanReviewHint({ ...t, agentReview: "approved" })).toMatch(/lands the ticket now/);
    expect(skipHumanReviewHint({ ...t, agentReview: "skipped" })).toMatch(/lands the ticket now/);
  });

  test("turning it off in review asks for an approval again", () => {
    expect(skipHumanReviewHint({ ...t, skipHumanReview: true, humanReview: "approved" })).toMatch(/waits on your approval/);
  });

  test("otherwise it says when the ticket will land", () => {
    expect(skipHumanReviewHint({ ...t, status: "in_progress" })).toMatch(/as soon as the agent review approves/);
    expect(skipHumanReviewHint({ ...t, status: "in_progress", skipAgentReview: true })).toMatch(/as soon as it's submitted/);
  });
});

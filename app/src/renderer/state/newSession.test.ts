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
  const p = { requireHumanReview: true };

  test("in review, says whether turning it on lands the ticket now or after the agent review", () => {
    expect(skipHumanReviewHint(t, p)).toMatch(/once its agent review passes/);
    expect(skipHumanReviewHint({ ...t, agentReview: "approved" }, p)).toMatch(/lands the ticket now/);
    expect(skipHumanReviewHint({ ...t, agentReview: "skipped" }, p)).toMatch(/lands the ticket now/);
  });

  test("turning it off in review asks for an approval again", () => {
    expect(skipHumanReviewHint({ ...t, skipHumanReview: true, humanReview: "approved" }, p)).toMatch(/waits on your approval/);
  });

  test("otherwise it says when the ticket will land", () => {
    expect(skipHumanReviewHint({ ...t, status: "in_progress" }, p)).toMatch(/as soon as the agent review approves/);
    expect(skipHumanReviewHint({ ...t, status: "in_progress", skipAgentReview: true }, p)).toMatch(/as soon as it's submitted/);
  });

  test("a project without human review has nothing to skip", () => {
    expect(skipHumanReviewHint(t, { requireHumanReview: false })).toMatch(/doesn't ask for a human review/);
    // An unknown project is treated as one that asks.
    expect(skipHumanReviewHint(t, null)).toMatch(/once its agent review passes/);
  });
});

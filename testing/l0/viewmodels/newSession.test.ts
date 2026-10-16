import { describe, expect, test } from "bun:test";
import { skipHumanReviewHint, skipReviewHint } from "../../../app/src/renderer/state/newSession";

type Agent = Parameters<typeof skipReviewHint>[0];
type Human = Parameters<typeof skipHumanReviewHint>[0];
const agent = (o: Partial<Agent>): Agent => ({ status: "review", agentReview: "pending", skipAgentReview: false, ...o });
const human = (o: Partial<Human>): Human => ({ status: "review", agentReview: "pending", humanReview: "pending", skipAgentReview: false, skipHumanReview: false, ...o });

describe("skipReviewHint", () => {
  test("in review, skipped: turning it off starts the review now", () => {
    expect(skipReviewHint(agent({ skipAgentReview: true, agentReview: "skipped" }))).toBe("Turning it off starts the agent review now");
  });
  test("in review, off and pending: turning it on skips the pending review", () => {
    expect(skipReviewHint(agent({}))).toBe("Turning it on skips the pending agent review");
  });
  test("in review with the review already running or done, it only affects the next submit", () => {
    for (const r of ["approved", "changes_requested", "running"] as const) expect(skipReviewHint(agent({ agentReview: r as never }))).toBe("Goes straight to your review when it's submitted");
    expect(skipReviewHint(agent({ skipAgentReview: true, agentReview: "pending" }))).toBe("Goes straight to your review when it's submitted");
  });
  test("outside review it only affects the next submit", () => {
    expect(skipReviewHint(agent({ status: "in_progress", skipAgentReview: true, agentReview: "skipped" }))).toBe("Goes straight to your review when it's submitted");
  });
});

describe("skipHumanReviewHint", () => {
  test("pending human review: turning it on lands now if the agent review passed, else once it does", () => {
    expect(skipHumanReviewHint(human({ agentReview: "approved" }))).toBe("Turning it on lands the ticket now");
    expect(skipHumanReviewHint(human({ agentReview: "skipped" }))).toBe("Turning it on lands the ticket now");
    expect(skipHumanReviewHint(human({ agentReview: "pending" }))).toBe("Turning it on lands the ticket once its agent review passes");
  });
  test("skipped and already approved: turning it off waits on you again", () => {
    expect(skipHumanReviewHint(human({ skipHumanReview: true, humanReview: "approved" }))).toBe("Turning it off waits on your approval again");
  });
  test("otherwise it describes the next submit, by whether the agent review is skipped", () => {
    expect(skipHumanReviewHint(human({ status: "in_progress", skipAgentReview: true }))).toBe("Lands as soon as it's submitted");
    expect(skipHumanReviewHint(human({ status: "in_progress" }))).toBe("Lands as soon as the agent review approves it");
    // in review but human review already approved with the switch off: nothing to flip now
    expect(skipHumanReviewHint(human({ humanReview: "approved" }))).toBe("Lands as soon as the agent review approves it");
  });
});

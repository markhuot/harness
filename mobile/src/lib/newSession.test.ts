import { describe, expect, test } from "bun:test";
import { newSessionBody, skipReviewHint, type NewSessionForm } from "./newSession";

const form = (extra: Partial<NewSessionForm> = {}): NewSessionForm => ({
  projectId: "p1",
  prompt: "  Fix the greeter  ",
  start: true,
  kind: "task",
  driver: "dummy",
  model: null,
  permissionMode: null,
  canWorktree: true,
  worktree: true,
  showBranch: true,
  branch: null,
  isGit: true,
  base: "",
  skipAgentReview: false,
  ...extra,
});

describe("newSessionBody", () => {
  test("skipAgentReview is sent only when the switch is on", () => {
    expect("skipAgentReview" in newSessionBody(form())).toBe(false);
    expect(newSessionBody(form({ skipAgentReview: true })).skipAgentReview).toBe(true);
  });
  test("the prompt and base branch are trimmed; an empty base follows the project", () => {
    expect(newSessionBody(form()).prompt).toBe("Fix the greeter");
    expect(newSessionBody(form()).baseBranch).toBeNull();
    expect(newSessionBody(form({ base: " release/v2 " })).baseBranch).toBe("release/v2");
  });
  test("hidden fields stay out: no worktree choice, branch or base off git", () => {
    const b = newSessionBody(form({ canWorktree: false, showBranch: false, isGit: false, branch: "feature/x", base: "dev" }));
    expect(b.useWorktree).toBeNull();
    expect(b.branch).toBeUndefined();
    expect(b.baseBranch).toBeUndefined();
  });
  test("the branch is sent only while the picker shows (worktree on)", () => {
    expect(newSessionBody(form({ branch: "feature/x" })).branch).toBe("feature/x");
    expect(newSessionBody(form({ worktree: false, showBranch: false, branch: "feature/x" }))).toMatchObject({ useWorktree: false, branch: undefined });
  });
});

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

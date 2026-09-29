import { describe, expect, test } from "bun:test";
import { newSessionBody, skipReviewHint, type NewSessionForm } from "./newSession";

const form = (over: Partial<NewSessionForm> = {}): NewSessionForm => ({
  projectId: "proj_1",
  prompt: "  Fix the thing  ",
  start: true,
  kind: "task",
  driver: "claude-code",
  model: null,
  permissionMode: null,
  canWorktree: true,
  worktree: true,
  showBranches: true,
  branch: null,
  baseBranch: null,
  skipAgentReview: false,
  ...over,
});

describe("newSessionBody", () => {
  test("sends skipAgentReview only when the switch is on", () => {
    expect("skipAgentReview" in newSessionBody(form())).toBe(false);
    expect(newSessionBody(form({ skipAgentReview: true })).skipAgentReview).toBe(true);
  });

  test("leaves the branches out when the pickers are hidden", () => {
    const body = newSessionBody(form({ showBranches: false, branch: "feature/x", baseBranch: "develop" }));
    expect("branch" in body).toBe(false);
    expect("baseBranch" in body).toBe(false);
    expect(newSessionBody(form({ branch: "feature/x", baseBranch: "develop" }))).toMatchObject({ branch: "feature/x", baseBranch: "develop" });
  });

  test("has no worktree choice off git, and trims the prompt", () => {
    const body = newSessionBody(form({ canWorktree: false, worktree: true }));
    expect(body.useWorktree).toBeNull();
    expect(body.prompt).toBe("Fix the thing");
    expect(newSessionBody(form({ worktree: false })).useWorktree).toBe(false);
  });
});

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

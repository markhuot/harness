import { expect, test } from "bun:test";
import { approveLabel, approveMenuActions, completionOptions, offeredCompletionActions, projectCompletionDefault, resolveCompletionAction } from "./completion";

const git = { isGit: true, pullRequestHost: null } as const;
const gh = { isGit: true, pullRequestHost: "github.com" } as const;
const plain = { isGit: false, pullRequestHost: null } as const;

test("offered actions follow the checkout: custom outside git, merge in git, pr with a gh host", () => {
  expect(offeredCompletionActions(plain)).toEqual(["custom"]);
  expect(offeredCompletionActions(git)).toEqual(["merge", "custom"]);
  expect(offeredCompletionActions(gh)).toEqual(["merge", "pr", "custom"]);
  // The service's own list wins over the client's guess.
  expect(offeredCompletionActions({ ...gh, completionActions: ["merge", "custom"] })).toEqual(["merge", "custom"]);
});

test("the project default falls back pr → merge → custom when the project stops offering it", () => {
  expect(projectCompletionDefault({ ...gh, completionAction: "pr" })).toBe("pr");
  expect(projectCompletionDefault({ ...git, completionAction: "pr" })).toBe("merge");
  expect(projectCompletionDefault({ ...plain, completionAction: "pr" })).toBe("custom");
  expect(projectCompletionDefault({ ...plain, completionAction: "merge" })).toBe("custom");
  expect(projectCompletionDefault({ ...git })).toBe("merge");
});

test("preselection: the ticket's earlier choice, then pr for a ticket with a pull request, then the project default", () => {
  const project = { ...gh, completionAction: "merge" } as const;
  expect(completionOptions({ completionAction: "custom", pullRequestUrl: "https://github.com/a/b/pull/1" }, project).defaultAction).toBe("custom");
  expect(completionOptions({ completionAction: null, pullRequestUrl: "https://github.com/a/b/pull/1" }, project).defaultAction).toBe("pr");
  expect(completionOptions({ completionAction: null, pullRequestUrl: null }, project).defaultAction).toBe("merge");
  // An earlier pr choice the project no longer offers doesn't stick.
  expect(completionOptions({ completionAction: "pr", pullRequestUrl: "x" }, { ...git, completionAction: "merge" }).defaultAction).toBe("merge");
});

test("a child of a parent on a branch only merges, into that branch", () => {
  const opts = completionOptions({ completionAction: "pr" }, { ...gh, completionAction: "pr" }, { branch: "harness/web-1" });
  expect(opts).toEqual({ actions: ["merge"], defaultAction: "merge", parentBranch: "harness/web-1" });
  expect(approveLabel(opts)).toBe("Approve and merge into harness/web-1");
  expect(approveMenuActions(opts)).toEqual([]);
  expect(resolveCompletionAction("pr", null, gh, { branch: "harness/web-1" }).error).toContain("harness/web-1");
  expect(resolveCompletionAction("custom", null, gh, { branch: "harness/web-1" }).action).toBeNull();
  // A parent without a branch (it works in the project checkout) changes nothing.
  expect(completionOptions(null, gh, { branch: null }).actions).toEqual(["merge", "pr", "custom"]);
});

test("resolving a requested action: offered ones pass, others are refused with a reason", () => {
  expect(resolveCompletionAction(undefined, null, { ...gh, completionAction: "pr" })).toEqual({ action: "pr", error: null });
  expect(resolveCompletionAction("custom", null, git)).toEqual({ action: "custom", error: null });
  expect(resolveCompletionAction("pr", null, git).error).toContain("gh");
  expect(resolveCompletionAction("merge", null, plain).error).toContain("git");
});

test("labels: plain Approve when custom is the primary choice, the action's label otherwise", () => {
  expect(approveLabel(completionOptions(null, plain))).toBe("Approve");
  expect(approveLabel(completionOptions(null, { ...gh, completionAction: "pr" }))).toBe("Approve and open PR");
  expect(approveMenuActions(completionOptions(null, git))).toEqual(["merge", "custom"]);
});

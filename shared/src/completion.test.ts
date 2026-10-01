import { expect, test } from "bun:test";
import { approveLabel, approveMenuActions, completionOptions, offeredCompletionActions, projectCompletionDefault, resolveCompletionAction, worksOnBase } from "./completion";

const git = { isGit: true, pullRequestHost: null } as const;
const gh = { isGit: true, pullRequestHost: "github.com" } as const;
const plain = { isGit: false, pullRequestHost: null } as const;

test("offered actions follow the checkout: custom outside git, merge and cleanup in git, pr with a gh host", () => {
  expect(offeredCompletionActions(plain)).toEqual(["custom"]);
  expect(offeredCompletionActions(git)).toEqual(["merge", "cleanup", "custom"]);
  expect(offeredCompletionActions(gh)).toEqual(["merge", "pr", "cleanup", "custom"]);
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
  expect(completionOptions(null, gh, { branch: null }).actions).toEqual(["merge", "pr", "cleanup", "custom"]);
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
  expect(approveMenuActions(completionOptions(null, git))).toEqual(["merge", "cleanup", "custom"]);
});

test("a finished parent, or a child with its own base branch, no longer keeps the child on the parent's branch", () => {
  const project = { ...gh, completionAction: "pr" } as const;
  expect(completionOptions(null, project, { branch: "harness/web-1", status: "done" })).toMatchObject({ parentBranch: null, actions: ["merge", "pr", "cleanup", "custom"], defaultAction: "pr" });
  expect(completionOptions({ baseBranch: "release" }, project, { branch: "harness/web-1", status: "in_progress" })).toMatchObject({ parentBranch: null, defaultAction: "pr" });
  expect(completionOptions({ baseBranch: null }, project, { branch: "harness/web-1", status: "in_progress" }).parentBranch).toBe("harness/web-1");
});

test("cleanup is always offered in git, after merge and pr: even a ticket with nothing on its branch can clean up", () => {
  expect(completionOptions({ branch: null }, gh).actions).toEqual(["merge", "pr", "cleanup", "custom"]);
  expect(completionOptions({ branch: "harness/web-1" }, gh, null, "main").actions).toEqual(["merge", "pr", "cleanup", "custom"]);
  expect(completionOptions({ branch: "harness/web-1" }, plain, null, "main").actions).toEqual(["custom"]);
  expect(completionOptions({ branch: "harness/web-1" }, { ...git, completionAction: "cleanup" }, null, "main").defaultAction).toBe("cleanup");
});

test("a ticket on its base branch (an existing PR head) has no merge or pr, and preselects cleanup", () => {
  const ticket = { branch: "feature/pr-head", completionAction: null, pullRequestUrl: "https://github.com/a/b/pull/1" };
  const opts = completionOptions(ticket, { ...gh, completionAction: "merge" }, null, "feature/pr-head");
  expect(opts).toEqual({ actions: ["cleanup", "custom"], defaultAction: "cleanup", parentBranch: null });
  expect(approveLabel(opts)).toBe("Approve and clean up");
  // An earlier merge choice no longer applies; custom still does.
  expect(completionOptions({ ...ticket, completionAction: "merge" }, gh, null, "feature/pr-head").defaultAction).toBe("cleanup");
  expect(completionOptions({ ...ticket, completionAction: "custom" }, gh, null, "feature/pr-head").defaultAction).toBe("custom");
  expect(resolveCompletionAction("merge", ticket, gh, null, "feature/pr-head").error).toBe(
    'this ticket works on its base branch feature/pr-head, so there is nothing to merge: complete it with "cleanup" or "custom"',
  );
  expect(resolveCompletionAction("pr", ticket, gh, null, "feature/pr-head").error).toContain("nothing to open a pull request from");
  // pr the project doesn't offer at all keeps its own reason.
  expect(resolveCompletionAction("pr", ticket, git, null, "feature/pr-head").error).toContain("gh is logged into");
  // Without the base (or with another one) nothing is ruled out.
  expect(completionOptions(ticket, gh).actions).toEqual(["merge", "pr", "cleanup", "custom"]);
  expect(completionOptions(ticket, gh, null, "main").actions).toEqual(["merge", "pr", "cleanup", "custom"]);
});

test("worksOnBase needs both a branch and a base, and the two equal", () => {
  expect(worksOnBase({ branch: "main" }, "main")).toBe(true);
  expect(worksOnBase({ branch: "harness/web-1" }, "main")).toBe(false);
  expect(worksOnBase({ branch: null }, null)).toBe(false);
  expect(worksOnBase({ branch: "main" }, null)).toBe(false);
});

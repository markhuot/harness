import { expect, test } from "bun:test";
import type { BranchInfo } from "../protocol";
import { branchChoice, branchChoiceHint, branchOptions, canChangeBranch, inheritedBaseLabel, predictedBranch, predictedTicketKey, ticketHasBranch } from "./branches";

const b = (name: string, checkedOutAt: string | null = null): BranchInfo => ({ name, lastCommitAt: 0, checkedOutAt });

test("predicted key skips keys already taken, like the service", () => {
  expect(predictedTicketKey({ key: "WEB", nextSeq: 4 })).toBe("WEB-4");
  expect(predictedTicketKey({ key: "WEB", nextSeq: 4 }, ["WEB-4", "WEB-5", "WEB-7"])).toBe("WEB-6");
  expect(predictedBranch({ key: "WEB", nextSeq: 4 }, ["WEB-4"])).toBe("harness/web-5");
});

test("inherited base label names where the value comes from", () => {
  expect(inheritedBaseLabel({ branch: "main", source: "settings" })).toBe("main (app default)");
  expect(inheritedBaseLabel({ branch: "develop", source: "project" })).toBe("develop (project)");
  expect(inheritedBaseLabel({ branch: "release", source: "ticket" })).toBe("release");
});

test("branch choice: blank is the default, a listed name is existing, else new or invalid", () => {
  const known = [b("main", "/Users/me/app"), b("feature/x")];
  expect(branchChoice(null, "harness/web-4", known)).toEqual({ kind: "default", name: "harness/web-4" });
  expect(branchChoice("  ", "harness/web-4", known)).toEqual({ kind: "default", name: "harness/web-4" });
  expect(branchChoice("feature/x", "harness/web-4", known)).toEqual({ kind: "existing", name: "feature/x", checkedOutAt: null });
  expect(branchChoice("main", "harness/web-4", known)).toEqual({ kind: "existing", name: "main", checkedOutAt: "/Users/me/app" });
  expect(branchChoice(" feature/y ", "harness/web-4", known)).toEqual({ kind: "new", name: "feature/y" });
  expect(branchChoice("bad name", "harness/web-4", known).kind).toBe("invalid");
  // A stale harness/<key> branch left by a deleted ticket is checked out as is, not recreated.
  expect(branchChoice(null, "harness/web-4", [b("harness/web-4")]).kind).toBe("existing");
});

test("branch hints say what happens, including checked-out elsewhere", () => {
  expect(branchChoiceHint({ kind: "default", name: "harness/web-4" }, "develop")).toBe("A new branch from develop.");
  expect(branchChoiceHint({ kind: "new", name: "feature/y" }, "main")).toBe("feature/y doesn't exist yet. It will be created from main.");
  expect(branchChoiceHint({ kind: "existing", name: "x", checkedOutAt: "/Users/me/wt/x" }, "main")).toContain("Checked out in ~/wt/x");
  expect(branchChoiceHint({ kind: "existing", name: "x", checkedOutAt: null }, "main")).toBe("Works on the existing branch and merges it into main.");
  expect(branchChoiceHint({ kind: "invalid", name: "a b", error: "no spaces" }, "main")).toBe("Not a valid branch name: no spaces.");
});

test("picker rows: default first, then Create for a new valid name, then matches", () => {
  const matches = [b("feature/login"), b("feature/logout", "/wt")];
  expect(branchOptions("", "harness/web-4", matches).map((r) => [r.kind, r.value])).toEqual([
    ["default", null],
    ["existing", "feature/login"],
    ["existing", "feature/logout"],
  ]);
  // The query doesn't match the default row's label, and names no listed branch: offer to create it.
  expect(branchOptions("feature/log", "harness/web-4", matches).map((r) => r.label)).toEqual(["Create feature/log", "feature/login", "feature/logout"]);
  // An exact match isn't offered twice; an invalid name gets no Create row.
  expect(branchOptions("feature/login", "harness/web-4", [b("feature/login")]).map((r) => r.kind)).toEqual(["existing"]);
  expect(branchOptions("a b", "harness/web-4", []).length).toBe(0);
  // Typing the default name (or part of its label) keeps the default row, without a Create twin.
  expect(branchOptions("harness/web-4", "harness/web-4", []).map((r) => r.kind)).toEqual(["default"]);
  expect(branchOptions("new", "harness/web-4", []).map((r) => r.kind)).toEqual(["default", "new"]);
  // A leftover branch with the default's name is listed as existing instead of "New branch".
  expect(branchOptions("", "harness/web-4", [b("harness/web-4")]).map((r) => r.kind)).toEqual(["existing"]);
});

test("branch is editable only before the worktree exists, for worktree tickets", () => {
  const git = { isGit: true, useWorktrees: true };
  const fresh = { branch: null, useWorktree: null, workdir: null, status: "planning" as const };
  expect(canChangeBranch(fresh, git)).toBe(true);
  expect(canChangeBranch({ ...fresh, workdir: "/wt/WEB-4", branch: "harness/web-4", status: "in_progress" }, git)).toBe(false);
  expect(canChangeBranch({ ...fresh, status: "done" }, git)).toBe(false);
  expect(canChangeBranch({ ...fresh, useWorktree: false }, git)).toBe(false);
  expect(canChangeBranch(fresh, { isGit: false, useWorktrees: true })).toBe(false);
  expect(canChangeBranch(fresh, { isGit: true, useWorktrees: false })).toBe(false);
  expect(canChangeBranch({ ...fresh, useWorktree: true }, { isGit: true, useWorktrees: false })).toBe(true);
  // Once it has a branch it keeps showing it, even if the project stopped using worktrees.
  expect(ticketHasBranch({ branch: "x", useWorktree: null }, { isGit: true, useWorktrees: false })).toBe(true);
  expect(ticketHasBranch({ branch: null, useWorktree: null }, null)).toBe(false);
});

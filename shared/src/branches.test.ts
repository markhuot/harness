import { expect, test } from "bun:test";
import { branchNameError, plannedBranch, resolveBaseBranch } from "./branches";

test("base branch: ticket beats project, project beats settings; null and empty inherit", () => {
  const settings = { baseBranch: "develop" };
  expect(resolveBaseBranch({ baseBranch: "release" }, { baseBranch: "staging" }, settings)).toEqual({ branch: "release", source: "ticket" });
  expect(resolveBaseBranch({ baseBranch: null }, { baseBranch: "staging" }, settings)).toEqual({ branch: "staging", source: "project" });
  expect(resolveBaseBranch({ baseBranch: "" }, { baseBranch: "" }, settings)).toEqual({ branch: "develop", source: "settings" });
  // Older services and fixtures don't send settings.baseBranch: the built-in default applies.
  expect(resolveBaseBranch(null, undefined, {})).toEqual({ branch: "main", source: "settings" });
});

test("planned branch: the worktree's branch, else the requested one, else harness/<key>", () => {
  expect(plannedBranch({ key: "WEB-3", branch: "feature/x", requestedBranch: "other" })).toBe("feature/x");
  expect(plannedBranch({ key: "WEB-3", branch: null, requestedBranch: "medl-1223-ai-app" })).toBe("medl-1223-ai-app");
  expect(plannedBranch({ key: "WEB-3", branch: null, requestedBranch: null })).toBe("harness/web-3");
});

test("branch names follow git check-ref-format --branch", () => {
  for (const ok of ["main", "feature/login", "medl-1223-ai-app", "harness/web-3", "v1.2", "a@b", "x.locked"]) expect(branchNameError(ok)).toBeNull();
  for (const bad of ["", "@", "HEAD", "-x", "/x", "x/", "x.", "a//b", "a..b", "a@{1}", "a b", "a~1", "a^", "a:b", "a?", "a*", "a[b", "a\\b", "a\tb", ".hidden", "x/.y", "x.lock", "x.lock/y"]) {
    expect(branchNameError(bad)).not.toBeNull();
  }
});

test("base branch: a child lands on its parent's branch unless it sets its own", () => {
  const parent = { branch: "harness/web-1" };
  expect(resolveBaseBranch({ baseBranch: null }, { baseBranch: "develop" }, {}, parent)).toEqual({ branch: "harness/web-1", source: "parent" });
  expect(resolveBaseBranch({ baseBranch: "release" }, { baseBranch: "develop" }, {}, parent)).toEqual({ branch: "release", source: "ticket" });
  // A parent without a worktree branch is skipped.
  expect(resolveBaseBranch({ baseBranch: null }, { baseBranch: "develop" }, {}, { branch: null })).toEqual({ branch: "develop", source: "project" });
});

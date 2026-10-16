import { expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { branchExists, checkedOutElsewhere, commitsNotIn, currentBranch, ensureWorktree, hasChangesToLand, headCommit, isAncestor, isGitRepo, isInside, listBranches, listWorktrees, samePath, switchBranch } from "../../../service/src/orchestrator/worktree";
import { tempDir } from "../../builders/tmp";
import { git, gitRepo } from "../git";

const worktrees = () => join(tempDir(), "worktrees");

test("a folder is a repo only when git says it's inside a work tree", async () => {
  expect(await isGitRepo(gitRepo())).toBe(true);
  expect(await isGitRepo(tempDir())).toBe(false);
  expect(await isGitRepo("/does/not/exist")).toBe(false);
});

test("headCommit and currentBranch read the checkout; both are null where there's nothing", async () => {
  const repo = gitRepo();
  expect(await headCommit(repo)).toBe(git(repo, "rev-parse", "HEAD"));
  expect(await currentBranch(repo)).toBe("main");
  git(repo, "checkout", "-q", "--detach");
  expect(await currentBranch(repo)).toBeNull();
  expect(await headCommit(tempDir())).toBeNull();
  expect(await headCommit("/does/not/exist")).toBeNull();
});

test("a new ticket's worktree is created at <worktrees>/<KEY> on harness/<key> from the base branch", async () => {
  const repo = gitRepo();
  const dir = worktrees();
  const out = await ensureWorktree({ repo, worktreesDir: dir, key: "ACME-1", base: "main" });
  expect(out).toEqual({ workdir: join(dir, "ACME-1"), branch: "harness/acme-1" });
  expect(await currentBranch(out.workdir)).toBe("harness/acme-1");
  expect(await headCommit(out.workdir)).toBe(await headCommit(repo));
  expect((await listWorktrees(repo)).map((w) => w.branch).sort()).toEqual(["harness/acme-1", "main"]);
});

test("asking again reuses the worktree, and a chosen branch that exists is checked out as it is", async () => {
  const repo = gitRepo();
  const dir = worktrees();
  const first = await ensureWorktree({ repo, worktreesDir: dir, key: "ACME-1", base: "main" });
  expect(await ensureWorktree({ repo, worktreesDir: dir, key: "ACME-1", base: "main" })).toEqual(first);
  git(repo, "branch", "feature/x");
  const chosen = await ensureWorktree({ repo, worktreesDir: dir, key: "ACME-2", branch: "feature/x", base: "main" });
  expect(chosen.branch).toBe("feature/x");
  expect(await currentBranch(chosen.workdir)).toBe("feature/x");
});

test("a missing base branch is a message that says what to do", async () => {
  await expect(ensureWorktree({ repo: gitRepo(), worktreesDir: worktrees(), key: "ACME-1", base: "develop" })).rejects.toThrow(/base branch develop doesn't exist/);
});

test("a branch checked out in another worktree can't be taken, and the message names where it is", async () => {
  const repo = gitRepo();
  const dir = worktrees();
  await ensureWorktree({ repo, worktreesDir: dir, key: "ACME-1", branch: "shared", base: "main" });
  await expect(ensureWorktree({ repo, worktreesDir: dir, key: "ACME-2", branch: "shared", base: "main" })).rejects.toThrow(/already checked out in the worktree at .*ACME-1/);
  const holder = await checkedOutElsewhere(repo, "shared", join(dir, "ACME-1"));
  expect(holder).toBeNull();
  expect((await checkedOutElsewhere(repo, "shared"))!.branch).toBe("shared");
});

test("a worktree left on another branch is put back on the ticket's branch", async () => {
  const repo = gitRepo();
  const dir = worktrees();
  const wt = await ensureWorktree({ repo, worktreesDir: dir, key: "ACME-1", branch: "mine", base: "main" });
  await switchBranch(wt.workdir, "elsewhere");
  const again = await ensureWorktree({ repo, worktreesDir: dir, key: "ACME-1", branch: "mine", base: "main" });
  expect(again.branch).toBe("mine");
  expect(await currentBranch(wt.workdir)).toBe("mine");
});

test("switchBranch creates the branch when it's new and says so; git's refusal comes back as the message", async () => {
  const repo = gitRepo({ "a.txt": "1\n" });
  expect(await switchBranch(repo, "new")).toEqual({ created: true });
  expect(await switchBranch(repo, "main")).toEqual({ created: false });
  writeFileSync(join(repo, "a.txt"), "2\n");
  git(repo, "commit", "-qam", "on main");
  git(repo, "switch", "-q", "new");
  writeFileSync(join(repo, "a.txt"), "dirty\n");
  await expect(switchBranch(repo, "main")).rejects.toThrow(/git switch main failed/);
});

test("there's something to land when the worktree is dirty or the branch is ahead of base, and nothing otherwise", async () => {
  const repo = gitRepo();
  expect(await hasChangesToLand(repo, "main", "main")).toBe(false);
  git(repo, "switch", "-q", "-c", "work");
  expect(await hasChangesToLand(repo, "work", "main")).toBe(false);
  writeFileSync(join(repo, "n.txt"), "x");
  expect(await hasChangesToLand(repo, "work", "main")).toBe(true);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "work");
  expect(await hasChangesToLand(repo, "work", "main")).toBe(true);
  expect(await hasChangesToLand(repo, "work", "gone")).toBeNull();
  expect(await hasChangesToLand("/does/not/exist", "work", "main")).toBeNull();
});

test("isAncestor and commitsNotIn count what's already in the target", async () => {
  const repo = gitRepo();
  git(repo, "switch", "-q", "-c", "work");
  writeFileSync(join(repo, "n.txt"), "x");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "one");
  expect(await isAncestor(repo, "main", "work")).toBe(true);
  expect(await isAncestor(repo, "work", "main")).toBe(false);
  expect(await isAncestor(repo, "nope", "main")).toBe(false);
  expect(await commitsNotIn(repo, "work", "main")).toBe(1);
  expect(await commitsNotIn(repo, "main", "work")).toBe(0);
  expect(await commitsNotIn(repo, "missing", "main")).toBe(0);
  git(repo, "switch", "-q", "main");
  git(repo, "merge", "-q", "--no-ff", "-m", "merge", "work");
  expect(await commitsNotIn(repo, "work", "main")).toBe(0);
});

test("branches list newest commit first with where each is checked out, and filter by substring before fuzzy matches", async () => {
  const repo = gitRepo();
  for (const name of ["feature/login", "fix-lo-gin", "other"]) git(repo, "branch", name);
  const dir = worktrees();
  await ensureWorktree({ repo, worktreesDir: dir, key: "ACME-1", branch: "other", base: "main" });
  const all = await listBranches(repo, "", 10);
  expect(all.map((b) => b.name).sort()).toEqual(["feature/login", "fix-lo-gin", "main", "other"]);
  expect(all.find((b) => b.name === "other")!.checkedOutAt).toBe(realpathSync(join(dir, "ACME-1")));
  expect(all.find((b) => b.name === "main")!.checkedOutAt).toBe(realpathSync(repo));
  // "login" is a substring of one name and a subsequence (l-o-g-i-n) of the other: substring first.
  expect((await listBranches(repo, "login", 10)).map((b) => b.name)).toEqual(["feature/login", "fix-lo-gin"]);
  expect((await listBranches(repo, "zzz", 10))).toEqual([]);
  expect(await listBranches(repo, "", 2)).toHaveLength(2);
  expect(await listBranches(tempDir(), "", 5)).toEqual([]);
  expect(await branchExists(repo, "other")).toBe(true);
  expect(await branchExists(repo, "nope")).toBe(false);
});

test("samePath and isInside compare real locations, so a symlinked path matches its target", () => {
  const dir = tempDir();
  mkdirSync(join(dir, "a", "b"), { recursive: true });
  expect(samePath(dir, realpathSync(dir))).toBe(true);
  expect(samePath(dir, join(dir, "x"))).toBe(false);
  expect(isInside(join(dir, "a", "b"), dir)).toBe(true);
  expect(isInside(dir, `${dir}/`)).toBe(true);
  expect(isInside(`${dir}-sibling`, dir)).toBe(false);
  expect(existsSync(dir)).toBe(true);
});

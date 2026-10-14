import { describe, expect, test } from "bun:test";
import type { GitPort } from "../../service/src/orchestrator/git-port";

/** What the contract needs from an implementation: a port, plus the few things a test does to git around it. */
export interface GitFixture {
  port: GitPort;
  /** A repository on `main` with one commit, and a directory that holds worktrees. */
  repo(): Promise<{ repo: string; worktrees: string }>;
  /** An existing directory that isn't a repository. */
  plainDir(): Promise<string>;
  /** A commit on whatever is checked out at `dir`, adding `file` when given. */
  commit(dir: string, file?: string): Promise<void>;
  /** Uncommitted changes in the checkout at `dir` (a new `file`, by default dirty.txt). */
  dirty(dir: string, file?: string): Promise<void>;
  /** A commit on `branch` that leaves every checkout alone. */
  commitOnBranch(repo: string, branch: string): Promise<void>;
  /** `git worktree add` from outside harness: `path` on `branch`, created at HEAD when `create`. */
  addWorktree(repo: string, path: string, branch: string, create?: boolean): Promise<void>;
  /** `git worktree remove --force`. */
  removeWorktree(repo: string, path: string): Promise<void>;
  /** `git branch -D`. */
  deleteBranch(repo: string, branch: string): Promise<void>;
  /** A branch at the tip of main, checked out nowhere. */
  branch(repo: string, name: string): Promise<void>;
  /** Merge `branch` into the branch checked out at `repo`. */
  merge(repo: string, branch: string): Promise<void>;
}

/**
 * The assertions every GitPort must satisfy. They run against the in-memory port (next/git) on every
 * run and against real git (next/contract), so the fake can't drift from what git does.
 */
export function gitPortContract(label: string, make: () => GitFixture) {
  describe(`GitPort contract: ${label}`, () => {
    test("a repository is a repo; a plain or missing directory is not", async () => {
      const f = make();
      const { repo } = await f.repo();
      expect(await f.port.isRepo(repo)).toBe(true);
      expect(await f.port.isRepo(await f.plainDir())).toBe(false);
      expect(await f.port.isRepo(`${repo}/missing`)).toBe(false);
    });

    test("heads: the repo is on main with a commit; outside git there's nothing", async () => {
      const f = make();
      const { repo } = await f.repo();
      expect(await f.port.currentBranch(repo)).toBe("main");
      const head = await f.port.headCommit(repo);
      expect(head).toBeTruthy();
      expect(await f.port.resolveCommit(repo, "main")).toBe(head);
      expect(await f.port.resolveCommit(repo, "nope")).toBeNull();
      const plain = await f.plainDir();
      expect(await f.port.headCommit(plain)).toBeNull();
      expect(await f.port.currentBranch(plain)).toBeNull();
    });

    test("ensureWorktree starts harness/<key> from the base, and is the same on a second call", async () => {
      const f = make();
      const { repo, worktrees } = await f.repo();
      const first = await f.port.ensureWorktree({ repo, worktreesDir: worktrees, key: "WEB-1", base: "main" });
      expect(first.branch).toBe("harness/web-1");
      expect(await f.port.currentBranch(first.workdir)).toBe("harness/web-1");
      expect(await f.port.headCommit(first.workdir)).toBe(await f.port.headCommit(repo));
      expect(await f.port.checkedOutElsewhere(repo, "harness/web-1")).toMatchObject({ branch: "harness/web-1" });
      expect(await f.port.ensureWorktree({ repo, worktreesDir: worktrees, key: "WEB-1", base: "main" })).toEqual(first);
    });

    test("ensureWorktree refuses a base that doesn't exist and a branch another worktree holds", async () => {
      const f = make();
      const { repo, worktrees } = await f.repo();
      await expect(f.port.ensureWorktree({ repo, worktreesDir: worktrees, key: "WEB-1", base: "develop" })).rejects.toThrow(/base branch develop doesn't exist/);
      await f.port.ensureWorktree({ repo, worktreesDir: worktrees, key: "WEB-1", base: "main" });
      await expect(f.port.ensureWorktree({ repo, worktreesDir: worktrees, key: "WEB-2", branch: "harness/web-1", base: "main" })).rejects.toThrow(/already checked out/);
      // The main checkout holds main, so a ticket can't take it either.
      await expect(f.port.ensureWorktree({ repo, worktreesDir: worktrees, key: "WEB-3", branch: "main", base: "main" })).rejects.toThrow(/already checked out/);
    });

    test("switchBranch creates a missing branch at HEAD and reports whether it did", async () => {
      const f = make();
      const { repo, worktrees } = await f.repo();
      const { workdir } = await f.port.ensureWorktree({ repo, worktreesDir: worktrees, key: "WEB-1", base: "main" });
      expect(await f.port.switchBranch(workdir, "topic")).toEqual({ created: true });
      expect(await f.port.currentBranch(workdir)).toBe("topic");
      expect(await f.port.switchBranch(workdir, "harness/web-1")).toEqual({ created: false });
      expect(await f.port.currentBranch(workdir)).toBe("harness/web-1");
    });

    test("hasChangesToLand: clean is false, a commit or a dirty tree is true, a missing worktree is unknown", async () => {
      const f = make();
      const { repo, worktrees } = await f.repo();
      const { workdir } = await f.port.ensureWorktree({ repo, worktreesDir: worktrees, key: "WEB-1", base: "main" });
      expect(await f.port.hasChangesToLand(workdir, "harness/web-1", "main")).toBe(false);
      await f.commit(workdir);
      expect(await f.port.hasChangesToLand(workdir, "harness/web-1", "main")).toBe(true);
      await f.merge(repo, "harness/web-1");
      expect(await f.port.hasChangesToLand(workdir, "harness/web-1", "main")).toBe(false);
      await f.dirty(workdir);
      expect(await f.port.hasChangesToLand(workdir, "harness/web-1", "main")).toBe(true);
      expect(await f.port.hasChangesToLand(`${worktrees}/gone`, "harness/web-1", "main")).toBeNull();
      expect(await f.port.hasChangesToLand(repo, "harness/web-1", "no-such-base")).toBeNull();
    });

    test("isMerged and aheadCount follow the commits, and count nothing for a missing branch", async () => {
      const f = make();
      const { repo, worktrees } = await f.repo();
      const { workdir } = await f.port.ensureWorktree({ repo, worktreesDir: worktrees, key: "WEB-1", base: "main" });
      expect(await f.port.isMerged(repo, "harness/web-1", "main")).toBe(true);
      await f.commit(workdir);
      await f.commit(workdir);
      expect(await f.port.aheadCount(repo, "harness/web-1", "main")).toBe(2);
      expect(await f.port.isMerged(repo, "harness/web-1", "main")).toBe(false);
      // A commit the base already has doesn't count: it arrives with the merge anyway.
      const parent = await f.port.ensureWorktree({ repo, worktreesDir: worktrees, key: "WEB-2", base: "main" });
      await f.commit(parent.workdir);
      const child = await f.port.ensureWorktree({ repo, worktreesDir: worktrees, key: "WEB-3", base: "harness/web-2" });
      await f.commit(child.workdir);
      expect(await f.port.aheadCount(repo, "harness/web-3", "main")).toBe(2);
      expect(await f.port.aheadCount(repo, "harness/web-3", "main", "harness/web-2")).toBe(1);
      await f.merge(repo, "harness/web-1");
      expect(await f.port.aheadCount(repo, "harness/web-1", "main")).toBe(0);
      expect(await f.port.isMerged(repo, "harness/web-1", "main")).toBe(true);
      expect(await f.port.aheadCount(repo, "nope", "main")).toBe(0);
      expect(await f.port.isMerged(repo, "nope", "main")).toBe(false);
    });

    test("commitOnBranch moves a branch nobody has checked out, and leaves the checkout where it was", async () => {
      const f = make();
      const { repo } = await f.repo();
      const head = await f.port.headCommit(repo);
      await f.branch(repo, "topic");
      await f.commitOnBranch(repo, "topic");
      expect(await f.port.resolveCommit(repo, "topic")).not.toBe(head);
      expect(await f.port.headCommit(repo)).toBe(head);
      expect(await f.port.aheadCount(repo, "topic", "main")).toBe(1);
      expect(await f.port.hasChangesToLand(repo, "main", "main")).toBe(false);
    });

    test("a worktree added outside harness holds its branch until it's removed; then the branch can go", async () => {
      const f = make();
      const { repo, worktrees } = await f.repo();
      const herdr = `${worktrees}/herdr`;
      await f.addWorktree(repo, herdr, "medl", true);
      expect(await f.port.currentBranch(herdr)).toBe("medl");
      expect(await f.port.headCommit(herdr)).toBe(await f.port.headCommit(repo));
      const held = await f.port.checkedOutElsewhere(repo, "medl");
      expect(held?.branch).toBe("medl");
      expect(held?.path.endsWith("/herdr")).toBe(true);
      expect(await f.port.checkedOutElsewhere(repo, "medl", held!.path)).toBeNull();
      await expect(f.port.ensureWorktree({ repo, worktreesDir: worktrees, key: "WEB-1", branch: "medl", base: "main" })).rejects.toThrow(/branch medl is already checked out in the worktree at .*herdr/);
      await expect(f.deleteBranch(repo, "medl")).rejects.toThrow();
      await f.removeWorktree(repo, herdr);
      expect(await f.port.isRepo(herdr)).toBe(false);
      expect(await f.port.checkedOutElsewhere(repo, "medl")).toBeNull();
      expect(await f.port.branchExists(repo, "medl")).toBe(true);
      // An existing branch goes into a worktree as is.
      await f.commitOnBranch(repo, "medl");
      const elsewhere = `${worktrees}/elsewhere`;
      await f.addWorktree(repo, elsewhere, "medl");
      expect(await f.port.headCommit(elsewhere)).toBe(await f.port.resolveCommit(repo, "medl"));
      await f.removeWorktree(repo, elsewhere);
      await f.deleteBranch(repo, "medl");
      expect(await f.port.branchExists(repo, "medl")).toBe(false);
      expect(await f.port.resolveCommit(repo, "medl")).toBeNull();
    });

    test("switchBranch refuses when local changes would be overwritten, and carries the others along", async () => {
      const f = make();
      const { repo, worktrees } = await f.repo();
      const { workdir } = await f.port.ensureWorktree({ repo, worktreesDir: worktrees, key: "WEB-1", base: "main" });
      const { workdir: second } = await f.port.ensureWorktree({ repo, worktreesDir: worktrees, key: "WEB-2", base: "main" });
      // main moves on with f.txt, and other starts there.
      await f.commit(repo, "f.txt");
      await f.branch(repo, "other");
      await f.dirty(workdir, "f.txt");
      await expect(f.port.switchBranch(workdir, "other")).rejects.toThrow(/git switch other failed/);
      expect(await f.port.currentBranch(workdir)).toBe("harness/web-1");
      // A change to a file the switch doesn't touch doesn't stand in the way.
      await f.dirty(second, "g.txt");
      expect(await f.port.switchBranch(second, "other")).toEqual({ created: false });
      expect(await f.port.currentBranch(second)).toBe("other");
      expect(await f.port.hasChangesToLand(second, "other", "main")).toBe(true);
    });

    test("listBranches: newest first, where each is checked out, substring before fuzzy", async () => {
      const f = make();
      const { repo, worktrees } = await f.repo();
      await f.branch(repo, "feature/login");
      const { workdir } = await f.port.ensureWorktree({ repo, worktreesDir: worktrees, key: "WEB-1", base: "main" });
      await f.commit(workdir);
      const all = await f.port.listBranches(repo, "", 10);
      expect(all.map((b) => b.name)).toEqual(["harness/web-1", ...all.slice(1).map((b) => b.name)]);
      expect(all.map((b) => b.name).sort()).toEqual(["feature/login", "harness/web-1", "main"]);
      expect(all.find((b) => b.name === "main")!.checkedOutAt).toBe(repo);
      expect(all.find((b) => b.name === "feature/login")!.checkedOutAt).toBeNull();
      expect((await f.port.listBranches(repo, "log", 10)).map((b) => b.name)).toEqual(["feature/login"]);
      // "flg" is no substring of anything, but its letters appear in order in feature/login.
      expect((await f.port.listBranches(repo, "flg", 10)).map((b) => b.name)).toEqual(["feature/login"]);
      expect(await f.port.listBranches(repo, "", 1)).toHaveLength(1);
      expect(await f.port.listBranches(await f.plainDir(), "", 10)).toEqual([]);
    });
  });
}

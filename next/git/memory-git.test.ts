import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@harness/shared/testing";
import { gitPortContract } from "../support/git-contract";
import { createMemoryGit } from "../support/memory-git";

gitPortContract("in memory", () => {
  const mem = createMemoryGit();
  const root = tempDir("next-memory-git-");
  let n = 0;
  const fresh = (name: string) => {
    const dir = join(root, `${name}-${++n}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  return {
    port: mem.port,
    async repo() {
      const repo = fresh("repo");
      mem.initRepo(repo);
      return { repo, worktrees: fresh("worktrees") };
    },
    async plainDir() {
      return fresh("plain");
    },
    commit: (dir, file) => mem.commitAt(dir, file),
    async dirty(dir, file) {
      mem.makeDirty(dir, file);
    },
    async commitOnBranch(repo, branch) {
      mem.commitOnBranch(repo, branch);
    },
    async addWorktree(repo, path, branch, create) {
      mem.addWorktree(repo, path, branch, create);
    },
    async removeWorktree(_repo, path) {
      mem.removeWorktree(path);
    },
    async deleteBranch(repo, branch) {
      mem.deleteBranch(repo, branch);
    },
    async branch(repo, name) {
      mem.createBranch(repo, name);
    },
    async merge(repo, branch) {
      mem.mergeInto(repo, branch);
    },
  };
});

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
    commit: (dir) => mem.commitAt(dir),
    async dirty(dir) {
      mem.makeDirty(dir);
    },
    async branch(repo, name) {
      mem.createBranch(repo, name);
    },
    async merge(repo, branch) {
      mem.mergeInto(repo, branch);
    },
  };
});

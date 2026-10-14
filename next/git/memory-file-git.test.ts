import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@harness/shared/testing";
import { fileGitContract } from "../support/git-contract";
import { createMemoryGit } from "../support/memory-git";

fileGitContract("in memory", () => {
  const mem = createMemoryGit();
  const root = tempDir("next-memory-file-git-");
  let n = 0;
  return {
    git: mem.files,
    dir() {
      const dir = join(root, `dir-${++n}`);
      mkdirSync(dir, { recursive: true });
      return dir;
    },
    async init(dir) {
      mem.initEmptyRepo(dir);
    },
    async stage(dir, ...paths) {
      mem.stage(dir, ...paths);
    },
    async commit(dir) {
      mem.commitStaged(dir);
    },
  };
});

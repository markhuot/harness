// The real-git half of the FileGit contract: the assertions the in-memory file model passes, against
// the git binary (realFileGit). This tier is allowed to spawn.

import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@harness/shared/testing";
import { realFileGit } from "../../service/src/orchestrator/file-git";
import { git } from "../../service/src/orchestrator/worktree";
import { fileGitContract } from "../support/git-contract";

Object.assign(process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });

const run = async (args: string[], cwd: string) => {
  const r = await git(args, cwd);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
};

const root = realpathSync(tempDir("next-real-file-git-"));
let n = 0;
fileGitContract("real git", () => ({
  git: realFileGit,
  dir() {
    const dir = join(root, `dir-${++n}`);
    mkdirSync(dir);
    return dir;
  },
  init: (dir) => run(["init", "-q", "-b", "main"], dir),
  stage: (dir, ...paths) => run(["add", "--", ...(paths.length ? paths : ["."])], dir),
  commit: (dir) => run(["commit", "-q", "-m", "c"], dir),
}));

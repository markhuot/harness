// The real-git half of the GitPort contract: the same assertions the in-memory port passes, against
// the git binary. Repos come from a template made once and cloned with `cp -Rc` (copy-on-write on
// APFS; measured ~17 ms against ~60 ms for init plus a commit). This tier is allowed to spawn.

import { appendFileSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@harness/shared/testing";
import { realGit } from "../../service/src/orchestrator/git-port";
import { git } from "../../service/src/orchestrator/worktree";
import { gitPortContract } from "../support/git-contract";

const ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
Object.assign(process.env, ENV);

let tick = 0;
/** Each commit a second after the last, so "newest first" has no ties to break. */
const stamp = () => {
  process.env.GIT_COMMITTER_DATE = `${1_700_000_000 + ++tick * 10} +0000`;
};
const run = async (args: string[], cwd: string) => {
  const r = await git(args, cwd);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
};

const root = realpathSync(tempDir("next-real-git-"));
let template: string | null = null;
async function templateRepo() {
  if (template) return template;
  template = join(root, "template");
  mkdirSync(template);
  await run(["init", "-q", "-b", "main"], template);
  stamp();
  await run(["commit", "-q", "--allow-empty", "-m", "init"], template);
  return template;
}

let n = 0;
gitPortContract("real git", () => ({
  port: realGit,
  async repo() {
    const repo = join(root, `repo-${++n}`);
    const proc = Bun.spawn(["cp", "-Rc", await templateRepo(), repo]);
    if ((await proc.exited) !== 0) throw new Error("cp -Rc failed");
    const worktrees = join(root, `worktrees-${n}`);
    mkdirSync(worktrees);
    return { repo, worktrees };
  },
  async plainDir() {
    const dir = join(root, `plain-${++n}`);
    mkdirSync(dir);
    return dir;
  },
  async commit(dir) {
    appendFileSync(join(dir, `work-${++tick}.txt`), "x\n");
    await run(["add", "-A"], dir);
    stamp();
    await run(["commit", "-q", "-m", "work"], dir);
  },
  async dirty(dir) {
    appendFileSync(join(dir, "dirty.txt"), "x\n");
  },
  async branch(repo, name) {
    await run(["branch", name, "main"], repo);
  },
  async merge(repo, branch) {
    stamp();
    await run(["merge", "-q", "--no-edit", branch], repo);
  },
}));

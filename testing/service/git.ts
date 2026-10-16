import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../builders/tmp";

/** `git <args>` in `cwd`, failing loudly, with an identity and none of the machine's git config. */
export function git(cwd: string, ...args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: cwd,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "T",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "T",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
  return proc.stdout.toString().trim();
}

/** A repository in a fresh temp dir on branch `main`, with `files` committed as its first commit. */
export function gitRepo(files: Record<string, string> = { "README.md": "hello\n" }): string {
  const dir = tempDir("h-git-");
  git(dir, "init", "-q", "-b", "main");
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "first");
  return dir;
}

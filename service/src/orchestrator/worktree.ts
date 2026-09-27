// Git worktrees: one per ticket, at <HARNESS_HOME>/worktrees/<KEY> on branch harness/<key>.

import { existsSync } from "node:fs";
import { join } from "node:path";

export async function git(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err) {
    return { code: -1, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
  }
}

export async function isGitRepo(path: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  const r = await git(["rev-parse", "--is-inside-work-tree"], path);
  return r.code === 0 && r.stdout === "true";
}

export function branchForKey(key: string) {
  return `harness/${key.toLowerCase()}`;
}

/**
 * Create (or reuse) the ticket's worktree. Throws with git's stderr on failure.
 */
export async function ensureWorktree(opts: { repo: string; worktreesDir: string; key: string }): Promise<{ workdir: string; branch: string }> {
  const workdir = join(opts.worktreesDir, opts.key);
  const branch = branchForKey(opts.key);
  if (existsSync(workdir) && (await isGitRepo(workdir))) return { workdir, branch };
  const hasBranch = (await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], opts.repo)).code === 0;
  const args = hasBranch ? ["worktree", "add", workdir, branch] : ["worktree", "add", workdir, "-b", branch];
  const r = await git(args, opts.repo);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout || `exit ${r.code}`}`);
  return { workdir, branch };
}

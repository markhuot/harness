// Git worktrees and branches (DESIGN.md "Branches"): one worktree per ticket, at
// <HARNESS_HOME>/worktrees/<KEY>, on the ticket's chosen branch or harness/<key>.

import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import type { BranchInfo } from "@harness/shared";
import { harnessBranch } from "@harness/shared";

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

/** The branch the harness creates for a ticket that didn't choose one: harness/<key>. */
export function branchForKey(key: string) {
  return harnessBranch(key);
}

export async function branchExists(repo: string, branch: string): Promise<boolean> {
  return (await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repo)).code === 0;
}

/** The branch checked out at `dir`, or null (detached HEAD, not a repo). */
/** The commit checked out in `dir` (git rev-parse HEAD), or null outside git / with no commits. */
export async function headCommit(dir: string): Promise<string | null> {
  if (!existsSync(dir)) return null;
  const r = await git(["rev-parse", "HEAD"], dir).catch(() => null);
  return r && r.code === 0 ? r.stdout.trim() || null : null;
}

export async function currentBranch(dir: string): Promise<string | null> {
  const r = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], dir);
  return r.code === 0 && r.stdout ? r.stdout : null;
}

export interface WorktreeEntry {
  path: string;
  /** Short branch name, null when detached */
  branch: string | null;
}

/** Every worktree of the repository `dir` belongs to (the main checkout first). */
export async function listWorktrees(dir: string): Promise<WorktreeEntry[]> {
  const r = await git(["worktree", "list", "--porcelain"], dir);
  if (r.code !== 0) return [];
  const out: WorktreeEntry[] = [];
  let cur: WorktreeEntry | null = null;
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      cur = { path: line.slice("worktree ".length), branch: null };
      out.push(cur);
    } else if (cur && line.startsWith("branch ")) {
      cur.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    }
  }
  return out;
}

/** Paths compare by their real location (macOS /var → /private/var, symlinked homes). */
export function samePath(a: string, b: string): boolean {
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  return real(a) === real(b);
}

/** Whether `path` is `dir` or inside it. */
export function isInside(path: string, dir: string): boolean {
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  const p = real(path);
  const d = real(dir).replace(/\/+$/, "");
  return p === d || p.startsWith(`${d}/`);
}

/** A worktree other than `except` that has `branch` checked out. */
export async function checkedOutElsewhere(repo: string, branch: string, except?: string | null): Promise<WorktreeEntry | null> {
  const list = await listWorktrees(repo);
  return list.find((w) => w.branch === branch && !(except && samePath(w.path, except))) ?? null;
}

/**
 * Create (or reuse) the ticket's worktree at <worktreesDir>/<KEY>. The branch is `branch` (the
 * ticket's chosen one) or harness/<key>: checked out as is when it exists, otherwise created from
 * `base`. An existing worktree directory is reused on whatever branch it has checked out.
 * Throws a message naming the branch or path when the branch is checked out in another worktree,
 * the base branch doesn't exist, or git fails.
 */
export async function ensureWorktree(opts: {
  repo: string;
  worktreesDir: string;
  key: string;
  branch?: string | null;
  base: string;
}): Promise<{ workdir: string; branch: string }> {
  const workdir = join(opts.worktreesDir, opts.key);
  const branch = opts.branch || branchForKey(opts.key);
  if (existsSync(workdir) && (await isGitRepo(workdir))) {
    const current = await currentBranch(workdir);
    if (current === branch || !opts.branch) return { workdir, branch: current ?? branch };
    // A worktree left on another branch (update_branch moved the ticket elsewhere, and that
    // worktree is gone now): put it back on the ticket's branch rather than quietly dropping it.
    const holder = await checkedOutElsewhere(opts.repo, branch, workdir);
    if (holder) {
      throw new Error(
        `branch ${branch} is already checked out in the worktree at ${holder.path}, and this ticket's worktree at ${workdir} is on ${current ?? "a detached HEAD"}. Switch that worktree off ${branch}, then start the ticket again.`,
      );
    }
    try {
      await switchBranch(workdir, branch);
    } catch (err) {
      throw new Error(`the worktree at ${workdir} is on ${current ?? "a detached HEAD"}, not this ticket's branch ${branch}, and switching failed: ${err instanceof Error ? err.message : err}`);
    }
    return { workdir, branch };
  }
  let args: string[];
  if (await branchExists(opts.repo, branch)) {
    // Only an existing branch can be checked out somewhere else already.
    const holder = await checkedOutElsewhere(opts.repo, branch, workdir);
    if (holder) {
      throw new Error(
        `branch ${branch} is already checked out in the worktree at ${holder.path}. A branch can be checked out in one worktree at a time: choose another branch for this ticket, or switch that worktree off ${branch}, then start the ticket again.`,
      );
    }
    args = ["worktree", "add", workdir, branch];
  } else {
    if (!(await branchExists(opts.repo, opts.base))) {
      throw new Error(
        `the base branch ${opts.base} doesn't exist in ${opts.repo}, so there is nothing to start ${branch} from. Create ${opts.base}, or set the ticket's or project's base branch to one that exists, then start the ticket again.`,
      );
    }
    args = ["worktree", "add", "-b", branch, workdir, opts.base];
  }
  const r = await git(args, opts.repo);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout || `exit ${r.code}`}`);
  return { workdir, branch };
}

/**
 * Switch the worktree at `workdir` to `branch` (created at its HEAD when it doesn't exist).
 * Throws git's message when it refuses (uncommitted changes that would be overwritten, ...).
 */
export async function switchBranch(workdir: string, branch: string): Promise<{ created: boolean }> {
  const created = !(await branchExists(workdir, branch));
  const args = created ? ["switch", "-c", branch] : ["switch", branch];
  const r = await git(args, workdir);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout || `exit ${r.code}`}`);
  return { created };
}

/**
 * Whether a ticket's worktree has anything to land on `base`: uncommitted changes (untracked files
 * included), or commits on `branch` that `base` doesn't have. null when git can't say (the worktree
 * is gone, a branch is missing, it isn't a repo), so the apps keep every Approve choice.
 */
export async function hasChangesToLand(workdir: string, branch: string, base: string): Promise<boolean | null> {
  if (!existsSync(workdir)) return null;
  const status = await git(["status", "--porcelain"], workdir);
  if (status.code !== 0) return null;
  if (status.stdout) return true;
  if (!(await branchExists(workdir, branch)) || !(await branchExists(workdir, base))) return null;
  const r = await git(["rev-list", "--count", `refs/heads/${branch}`, `^refs/heads/${base}`], workdir);
  return r.code === 0 ? Number(r.stdout) > 0 : null;
}

/**
 * How many of the ticket's commits on `from` aren't on `into` (0 when either is missing). With
 * `base`, commits the base branch already has don't count: they arrive with the merge anyway.
 */
export async function commitsNotIn(repo: string, from: string, into: string, base?: string | null): Promise<number> {
  const args = ["rev-list", "--count", `refs/heads/${from}`, `^refs/heads/${into}`];
  if (base && base !== into && (await branchExists(repo, base))) args.push(`^refs/heads/${base}`);
  const r = await git(args, repo);
  return r.code === 0 ? Number(r.stdout) || 0 : 0;
}

/**
 * Local branches, most recent commit first, with the worktree each is checked out in. `q`
 * filters case-insensitively: substring matches first, then names containing q's characters
 * in order. [] outside a git repo.
 */
export async function listBranches(repo: string, q: string, limit: number): Promise<BranchInfo[]> {
  if (!(await isGitRepo(repo))) return [];
  const r = await git(["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)%09%(committerdate:unix)", "refs/heads"], repo);
  if (r.code !== 0 || !r.stdout) return [];
  const worktrees = await listWorktrees(repo);
  const all: BranchInfo[] = r.stdout.split("\n").map((line) => {
    const [name = "", unix = "0"] = line.split("\t");
    return { name, lastCommitAt: Number(unix) * 1000, checkedOutAt: worktrees.find((w) => w.branch === name)?.path ?? null };
  });
  const needle = q.trim().toLowerCase();
  if (!needle) return all.slice(0, limit);
  const substring = all.filter((b) => b.name.toLowerCase().includes(needle));
  const fuzzy = all.filter((b) => !b.name.toLowerCase().includes(needle) && subsequence(needle, b.name.toLowerCase()));
  return [...substring, ...fuzzy].slice(0, limit);
}

function subsequence(needle: string, hay: string): boolean {
  let i = 0;
  for (const ch of hay) if (ch === needle[i] && ++i === needle.length) return true;
  return false;
}

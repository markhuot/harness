// The git questions the orchestrator asks, as a domain-level interface. Production answers them
// with the git binary (worktree.ts); tests can answer them from memory. Each method is a question
// ("is this commit on the base branch?"), never a git command line.

import type { BranchInfo } from "@harness/shared";
import {
  branchExists,
  checkedOutElsewhere,
  commitsNotIn,
  currentBranch,
  ensureWorktree,
  git,
  hasChangesToLand,
  headCommit,
  isAncestor,
  isGitRepo,
  listBranches,
  switchBranch,
  type WorktreeEntry,
} from "./worktree";

export interface GitPort {
  isRepo(path: string): Promise<boolean>;
  branchExists(repo: string, branch: string): Promise<boolean>;
  /** The branch checked out at `dir`, or null (detached HEAD, not a repo). */
  currentBranch(dir: string): Promise<string | null>;
  /** The commit checked out in `dir`, or null outside git / with no commits. */
  headCommit(dir: string): Promise<string | null>;
  /** The full sha `ref` (a branch, tag or sha) names in `cwd`, or null when it names no commit. */
  resolveCommit(cwd: string, ref: string): Promise<string | null>;
  /** A worktree other than `except` that has `branch` checked out. */
  checkedOutElsewhere(repo: string, branch: string, except?: string | null): Promise<WorktreeEntry | null>;
  ensureWorktree(opts: { repo: string; worktreesDir: string; key: string; branch?: string | null; base: string }): Promise<{ workdir: string; branch: string }>;
  switchBranch(workdir: string, branch: string): Promise<{ created: boolean }>;
  /** Uncommitted changes or commits `base` lacks; null when git can't say. */
  hasChangesToLand(workdir: string, branch: string, base: string): Promise<boolean | null>;
  /** Whether `commit` (a branch or sha) is already in `into`. */
  isMerged(repo: string, commit: string, into: string): Promise<boolean>;
  /** How many commits on `from` aren't on `into` (nor on `base`, when given). */
  aheadCount(repo: string, from: string, into: string, base?: string | null): Promise<number>;
  listBranches(repo: string, q: string, limit: number): Promise<BranchInfo[]>;
}

export const realGit: GitPort = {
  isRepo: isGitRepo,
  branchExists,
  currentBranch,
  headCommit,
  async resolveCommit(cwd, ref) {
    const r = await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd);
    return r.code === 0 && r.stdout ? r.stdout : null;
  },
  checkedOutElsewhere,
  ensureWorktree,
  switchBranch,
  hasChangesToLand,
  isMerged: isAncestor,
  aheadCount: commitsNotIn,
  listBranches,
};

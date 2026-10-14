import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { BranchInfo } from "@harness/shared";
import { harnessBranch } from "@harness/shared";
import type { GitPort } from "../../service/src/orchestrator/git-port";
import type { WorktreeEntry } from "../../service/src/orchestrator/worktree";
import type { WorkGit } from "../../service/src/testing/fakes";
import { createMemoryFileGit } from "./memory-file-git";

interface Commit {
  parents: string[];
  at: number;
  /** The files it changed, so a switch can tell which local changes it would overwrite. */
  files?: string[];
}

interface Repo {
  root: string;
  commits: Map<string, Commit>;
  branches: Map<string, string>;
  /** Checkout path -> branch (null: detached at `detached`). The root is the first entry. */
  worktrees: Map<string, { branch: string | null; detached?: string; dirty: boolean; dirtyFiles?: Set<string> }>;
}

/**
 * Git held in memory: the answers GitPort gives, without a process. Repos live in the maps; the
 * directories they claim are real (an empty dir under the test's temp home) because the orchestrator
 * checks the disk before asking. It models what the orchestrator reads (branches, worktrees, ancestry,
 * dirty trees), not git's whole surface. next/contract runs the same assertions against real git, so
 * a wrong assumption here fails there.
 */
export function createMemoryGit() {
  const repos: Repo[] = [];
  let clock = 0;
  let counter = 0;

  const norm = (p: string) => resolve(p);
  const repoOf = (path: string) => repos.find((r) => r.worktrees.has(norm(path)));
  const sha = () => (++counter).toString(16).padStart(40, "0");

  function commit(repo: Repo, parents: string[], files?: string[]): string {
    const id = sha();
    repo.commits.set(id, { parents, at: ++clock, files });
    return id;
  }
  function reachable(repo: Repo, from: string): Set<string> {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length) {
      const c = stack.pop()!;
      if (seen.has(c)) continue;
      seen.add(c);
      stack.push(...(repo.commits.get(c)?.parents ?? []));
    }
    return seen;
  }
  const headOf = (repo: Repo, path: string) => {
    const w = repo.worktrees.get(norm(path));
    return w ? (w.branch ? repo.branches.get(w.branch) ?? null : w.detached ?? null) : null;
  };
  const tipOf = (repo: Repo, ref: string) => repo.branches.get(ref) ?? (repo.commits.has(ref) ? ref : null);

  /** Turn an existing directory into a repository on `branch` with one commit, like `git init` plus a commit. */
  function initRepo(dir: string, branch = "main"): string {
    // An empty .git on disk too: the project store decides isGit by looking for one (insideGitCheckout).
    mkdirSync(join(dir, ".git"), { recursive: true });
    const repo: Repo = { root: norm(dir), commits: new Map(), branches: new Map(), worktrees: new Map() };
    const first = commit(repo, []);
    repo.branches.set(branch, first);
    repo.worktrees.set(repo.root, { branch, dirty: false });
    repos.push(repo);
    return first;
  }

  const requireRepo = (path: string) => {
    const r = repoOf(path);
    if (!r) throw new Error(`fatal: not a git repository: ${path}`);
    return r;
  };

  function listWorktrees(repo: Repo): WorktreeEntry[] {
    return [...repo.worktrees].map(([path, w]) => ({ path, branch: w.branch }));
  }
  function holder(repo: Repo, branch: string, except?: string | null) {
    return listWorktrees(repo).find((w) => w.branch === branch && !(except && norm(except) === w.path)) ?? null;
  }
  const ahead = (repo: Repo, from: string, into: string, base?: string | null) => {
    const f = repo.branches.get(from);
    const i = repo.branches.get(into);
    if (!f || !i) return 0;
    const exclude = reachable(repo, i);
    const b = base && base !== into ? repo.branches.get(base) : undefined;
    if (b) for (const c of reachable(repo, b)) exclude.add(c);
    return [...reachable(repo, f)].filter((c) => !exclude.has(c)).length;
  };

  const port: GitPort = {
    async isRepo(path) {
      return existsSync(path) && !!repoOf(path);
    },
    async branchExists(repo, branch) {
      return !!repoOf(repo)?.branches.has(branch);
    },
    async currentBranch(dir) {
      const r = repoOf(dir);
      return r?.worktrees.get(norm(dir))?.branch ?? null;
    },
    async headCommit(dir) {
      if (!existsSync(dir)) return null;
      const r = repoOf(dir);
      return r ? headOf(r, dir) : null;
    },
    async resolveCommit(cwd, ref) {
      const r = repoOf(cwd);
      return r ? tipOf(r, ref) : null;
    },
    async checkedOutElsewhere(repo, branch, except) {
      const r = repoOf(repo);
      return r ? holder(r, branch, except) : null;
    },
    async ensureWorktree(opts) {
      const workdir = join(opts.worktreesDir, opts.key);
      const branch = opts.branch || harnessBranch(opts.key);
      const repo = requireRepo(opts.repo);
      const existing = repo.worktrees.get(norm(workdir));
      if (existing && existsSync(workdir)) {
        if (existing.branch === branch || !opts.branch) return { workdir, branch: existing.branch ?? branch };
        const other = holder(repo, branch, workdir);
        if (other) {
          throw new Error(
            `branch ${branch} is already checked out in the worktree at ${other.path}, and this ticket's worktree at ${workdir} is on ${existing.branch ?? "a detached HEAD"}. Switch that worktree off ${branch}, then start the ticket again.`,
          );
        }
        await port.switchBranch(workdir, branch);
        return { workdir, branch };
      }
      if (repo.branches.has(branch)) {
        const other = holder(repo, branch, workdir);
        if (other) {
          throw new Error(
            `branch ${branch} is already checked out in the worktree at ${other.path}. A branch can be checked out in one worktree at a time: choose another branch for this ticket, or switch that worktree off ${branch}, then start the ticket again.`,
          );
        }
      } else {
        const from = repo.branches.get(opts.base);
        if (!from) {
          throw new Error(
            `the base branch ${opts.base} doesn't exist in ${opts.repo}, so there is nothing to start ${branch} from. Create ${opts.base}, or set the ticket's or project's base branch to one that exists, then start the ticket again.`,
          );
        }
        repo.branches.set(branch, from);
      }
      mkdirSync(workdir, { recursive: true });
      repo.worktrees.set(norm(workdir), { branch, dirty: false });
      return { workdir, branch };
    },
    async switchBranch(workdir, branch) {
      const repo = requireRepo(workdir);
      const w = repo.worktrees.get(norm(workdir))!;
      const created = !repo.branches.has(branch);
      if (!created) {
        const other = holder(repo, branch, workdir);
        if (other) throw new Error(`git switch ${branch} failed: '${branch}' is already used by worktree at '${other.path}'`);
        // Like git: local changes to a file the two commits disagree on would be overwritten, so it refuses.
        const head = headOf(repo, workdir);
        const target = repo.branches.get(branch)!;
        if (head && w.dirtyFiles?.size) {
          const a = reachable(repo, head);
          const b = reachable(repo, target);
          const differ = new Set([...a, ...b].filter((c) => a.has(c) !== b.has(c)).flatMap((c) => repo.commits.get(c)?.files ?? []));
          const lost = [...w.dirtyFiles].filter((f) => differ.has(f));
          if (lost.length) throw new Error(`git switch ${branch} failed: error: Your local changes to the following files would be overwritten by checkout:\n\t${lost.join("\n\t")}`);
        }
      } else {
        const head = headOf(repo, workdir);
        if (!head) throw new Error(`git switch -c ${branch} failed: nothing to branch from`);
        repo.branches.set(branch, head);
      }
      w.branch = branch;
      return { created };
    },
    async hasChangesToLand(workdir, branch, base) {
      if (!existsSync(workdir)) return null;
      const repo = repoOf(workdir);
      const w = repo?.worktrees.get(norm(workdir));
      if (!repo || !w) return null;
      if (w.dirty) return true;
      if (!repo.branches.has(branch) || !repo.branches.has(base)) return null;
      return ahead(repo, branch, base) > 0;
    },
    async isMerged(repo, commitOrBranch, into) {
      const r = repoOf(repo);
      const c = r && tipOf(r, commitOrBranch);
      const i = r?.branches.get(into);
      return !!(r && c && i && reachable(r, i).has(c));
    },
    async aheadCount(repo, from, into, base) {
      const r = repoOf(repo);
      return r ? ahead(r, from, into, base) : 0;
    },
    async listBranches(repo, q, limit) {
      const r = repoOf(repo);
      if (!r || !existsSync(repo)) return [];
      const all: BranchInfo[] = [...r.branches]
        .map(([name, tip]) => ({ name, lastCommitAt: (r.commits.get(tip)?.at ?? 0) * 1000, checkedOutAt: holder(r, name)?.path ?? null }))
        .sort((a, b) => b.lastCommitAt - a.lastCommitAt);
      const needle = q.trim().toLowerCase();
      if (!needle) return all.slice(0, limit);
      const has = (b: BranchInfo) => b.name.toLowerCase().includes(needle);
      const subsequence = (hay: string) => {
        let i = 0;
        for (const ch of hay) if (ch === needle[i] && ++i === needle.length) return true;
        return false;
      };
      return [...all.filter(has), ...all.filter((b) => !has(b) && subsequence(b.name.toLowerCase()))].slice(0, limit);
    },
  };

  // The files half (FileGit, next/support/memory-file-git.ts): trees and indexes here, the working tree on disk.
  const fileModel = createMemoryFileGit({
    checkoutOf(path) {
      for (let dir = norm(path); ; dir = dirname(dir)) {
        const r = repos.find((x) => x.worktrees.has(dir));
        if (r) return { root: dir, head: headOf(r, dir) };
        if (dirname(dir) === dir) return null;
      }
    },
    parentOf: (c) => repos.find((r) => r.commits.has(c))?.commits.get(c)?.parents[0] ?? null,
  });

  /** What the scripted agent does to git, against the same memory. */
  const work: WorkGit = {
    async commitWork(cwd) {
      const repo = repoOf(cwd);
      const w = repo?.worktrees.get(norm(cwd));
      const head = repo && headOf(repo, cwd);
      if (!repo || !w || !head) return;
      const id = commit(repo, [head]);
      if (w.branch) repo.branches.set(w.branch, id);
      else w.detached = id;
    },
    async mergeTicketBranch(cwd, branch, baseBranch) {
      const repo = repoOf(cwd);
      if (!branch || !repo) return;
      const list = listWorktrees(repo);
      const base = baseBranch ?? list[0]?.branch;
      const target = list.find((w) => w.branch === base);
      if (!base || base === branch || !target) return;
      const theirs = repo.branches.get(branch);
      const ours = repo.branches.get(base);
      if (!theirs || !ours) return;
      if (!reachable(repo, ours).has(theirs)) repo.branches.set(base, reachable(repo, theirs).has(ours) ? theirs : commit(repo, [ours, theirs]));
      repo.worktrees.delete(norm(cwd));
      rmSync(cwd, { recursive: true, force: true });
      repo.branches.delete(branch);
    },
    async headCommit(cwd) {
      const r = repoOf(cwd);
      return (r && headOf(r, cwd)) ?? "";
    },
  };

  return {
    port,
    work,
    initRepo,
    /** The file list's and viewer's git (FileGit), over the same repositories. */
    files: fileModel.port,
    /** `git init` with no commit yet: HEAD names `branch`, which doesn't exist. */
    initEmptyRepo(dir: string, branch = "main") {
      mkdirSync(join(dir, ".git"), { recursive: true });
      const repo: Repo = { root: norm(dir), commits: new Map(), branches: new Map(), worktrees: new Map() };
      repo.worktrees.set(repo.root, { branch, dirty: false });
      repos.push(repo);
    },
    /** `git add` of `paths` relative to `dir` (`git add .` when none). */
    stage(dir: string, ...paths: string[]) {
      fileModel.stage(dir, paths);
    },
    /** `git commit` of what's staged in the checkout at `dir`. */
    commitStaged(dir: string) {
      const repo = requireRepo(dir);
      const w = repo.worktrees.get(norm(dir))!;
      const head = headOf(repo, dir);
      const id = commit(repo, head ? [head] : []);
      if (w.branch) repo.branches.set(w.branch, id);
      else w.detached = id;
      fileModel.commitIndex(norm(dir), head, id);
    },
    /** A commit on whatever is checked out at `dir` (the test's stand-in for `git commit`), changing `file` when given. */
    async commitAt(dir: string, file?: string) {
      const repo = requireRepo(dir);
      const w = repo.worktrees.get(norm(dir))!;
      const head = headOf(repo, dir);
      if (!head) return;
      const id = commit(repo, [head], file ? [file] : undefined);
      if (w.branch) repo.branches.set(w.branch, id);
      else w.detached = id;
      // Like `git add -A && git commit`: the uncommitted changes go into the commit.
      w.dirty = false;
      w.dirtyFiles?.clear();
    },
    /** Leave uncommitted changes in the checkout at `dir` (to `file`, by default dirty.txt). */
    makeDirty(dir: string, file = "dirty.txt") {
      const w = requireRepo(dir).worktrees.get(norm(dir))!;
      w.dirty = true;
      (w.dirtyFiles ??= new Set()).add(file);
    },
    /** A commit on `branch` without touching any checkout (git commit-tree plus update-ref). */
    commitOnBranch(repo: string, branch: string) {
      const r = requireRepo(repo);
      r.branches.set(branch, commit(r, [r.branches.get(branch)!]));
    },
    /** A worktree made outside harness (`git worktree add`), on `branch`; `create` makes the branch at the repo's HEAD. */
    addWorktree(repo: string, path: string, branch: string, create = false) {
      const r = requireRepo(repo);
      if (create) {
        if (r.branches.has(branch)) throw new Error(`fatal: a branch named '${branch}' already exists`);
        r.branches.set(branch, headOf(r, repo)!);
      } else if (!r.branches.has(branch)) throw new Error(`fatal: invalid reference: ${branch}`);
      else if (holder(r, branch)) throw new Error(`fatal: '${branch}' is already used by worktree`);
      mkdirSync(path, { recursive: true });
      r.worktrees.set(norm(path), { branch, dirty: false });
    },
    /** `git worktree remove --force`: the checkout and its directory go; the branch stays. */
    removeWorktree(path: string) {
      const r = requireRepo(path);
      if (norm(path) === r.root) throw new Error("fatal: the main worktree can't be removed");
      r.worktrees.delete(norm(path));
      rmSync(path, { recursive: true, force: true });
    },
    /** `git branch -D`: refused while a worktree has it checked out. */
    deleteBranch(repo: string, branch: string) {
      const r = requireRepo(repo);
      if (holder(r, branch)) throw new Error(`error: cannot delete branch '${branch}' used by worktree`);
      r.branches.delete(branch);
    },
    /** A branch at the tip of `from`, not checked out anywhere. */
    createBranch(repo: string, name: string, from = "main") {
      const r = requireRepo(repo);
      r.branches.set(name, r.branches.get(from)!);
    },
    /** Merge `branch` into the branch checked out at `repo` (no worktree is removed). */
    mergeInto(repo: string, branch: string) {
      const r = requireRepo(repo);
      const into = r.worktrees.get(norm(repo))!.branch!;
      const ours = r.branches.get(into)!;
      const theirs = r.branches.get(branch)!;
      if (!reachable(r, ours).has(theirs)) r.branches.set(into, reachable(r, theirs).has(ours) ? theirs : commit(r, [ours, theirs]));
    },
  };
}

export type MemoryGit = ReturnType<typeof createMemoryGit>;

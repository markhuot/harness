// Git plumbing for the Changes tab. Never touches the user's index or worktree: untracked and
// unstaged files are staged into a throwaway copy of the index (GIT_INDEX_FILE) and diffed from there.
// A ticket branch's diff is also pinned as hidden refs (refs/harness/changes/<ticket id>/*), so the
// tab still works once the worktree is removed and the branch deleted.

import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { PluginExecOptions, PluginExecResult } from "@harness/plugin-sdk/server";
import type { ChangedFile, Changes, Commit, FileStatus } from "@harness/shared/state";

// The payloads the routes return (shared, since the apps' Changes tabs read them too).
export type { ChangedFile, Changes, Commit, FileStatus };

export type Exec = (cmd: string, args: string[], opts?: PluginExecOptions) => Promise<PluginExecResult>;

/** A ticket's pinned diff: base..(worktree ?? head). All commit shas. */
export interface Pin {
  base: string;
  head: string;
  /** Snapshot commit (parent: head) of changes that were never committed; null when the tree was clean */
  worktree: string | null;
}

export class GitError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
export const DEFAULT_MAX_PATCH_BYTES = 4 * 1024 * 1024;

/** Flags that make diff output independent of the user's git config. */
const DIFF_FLAGS = ["--no-color", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/", "-M"];
const BASE_CONFIG = ["-c", "core.quotePath=false", "-c", "diff.renames=true", "-c", "core.fsmonitor=false"];

export class Repo {
  private constructor(
    private exec: Exec,
    readonly root: string,
  ) {}

  static async open(exec: Exec, dir: string): Promise<Repo> {
    if (!existsSync(dir)) throw new GitError(404, `Workdir ${dir} does not exist`);
    const r = await exec("git", [...BASE_CONFIG, "rev-parse", "--show-toplevel"], { cwd: dir });
    if (r.code !== 0) throw new GitError(409, `${dir} is not a git repository`);
    return new Repo(exec, r.stdout.trim());
  }

  async git(args: string[], opts: PluginExecOptions = {}): Promise<PluginExecResult> {
    return this.exec("git", [...BASE_CONFIG, ...args], { cwd: this.root, timeoutMs: 60_000, ...opts });
  }

  async ok(args: string[], opts: PluginExecOptions = {}): Promise<string> {
    const r = await this.git(args, opts);
    if (r.code !== 0) throw new GitError(500, `git ${args.join(" ")} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
    return r.stdout;
  }

  async revParse(ref: string): Promise<string | null> {
    const r = await this.git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return r.code === 0 ? r.stdout.trim() : null;
  }

  async currentBranch(): Promise<string | null> {
    const r = await this.git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
    return r.code === 0 ? r.stdout.trim() : null;
  }

  /** Run fn with GIT_INDEX_FILE pointing at a copy of the real index with every worktree change staged. */
  async withWorkingTreeIndex<T>(fn: (env: Record<string, string>) => Promise<T>): Promise<T> {
    const tmp = mkdtempSync(join(tmpdir(), "harness-git-index-"));
    try {
      const indexFile = join(tmp, "index");
      const real = (await this.ok(["rev-parse", "--git-path", "index"])).trim();
      const realPath = isAbsolute(real) ? real : resolve(this.root, real);
      if (existsSync(realPath)) {
        // Copying keeps the stat cache (no full rehash). Keep the index's own mtime too: git compares
        // it with each entry's mtime to spot "racily clean" files, and a fresh mtime would hide
        // same-size edits made in the same timestamp tick as the last index write.
        copyFileSync(realPath, indexFile);
        const st = statSync(realPath);
        utimesSync(indexFile, st.atime, st.mtime);
      }
      const env = { GIT_INDEX_FILE: indexFile, GIT_OPTIONAL_LOCKS: "0" };
      await this.ok(["add", "-A", "--", "."], { env });
      return await fn(env);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}

/**
 * Base branch for a ticket branch: `preferred` (the ticket's or project's base branch override)
 * when the repo has it, else the project's checked-out branch, else main/master.
 */
export async function resolveBase(repo: Repo, exec: Exec, projectPath: string | null, ticketBranch: string, preferred?: string | null): Promise<string | null> {
  if (preferred && preferred !== ticketBranch && (await repo.revParse(`refs/heads/${preferred}`))) return preferred;
  if (projectPath && existsSync(projectPath)) {
    const r = await exec("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: projectPath });
    const b = r.code === 0 ? r.stdout.trim() : "";
    if (b && b !== ticketBranch && (await repo.revParse(`refs/heads/${b}`))) return b;
  }
  for (const b of ["main", "master"]) if (b !== ticketBranch && (await repo.revParse(`refs/heads/${b}`))) return b;
  return null;
}

export function parseNameStatus(z: string): { status: string; path: string; oldPath?: string }[] {
  const parts = z.split("\0");
  const out: { status: string; path: string; oldPath?: string }[] = [];
  for (let i = 0; i < parts.length; ) {
    const code = parts[i++];
    if (!code) continue;
    const letter = code[0]!;
    if (letter === "R" || letter === "C") {
      const oldPath = parts[i++]!;
      const path = parts[i++]!;
      out.push({ status: letter, path, oldPath });
    } else {
      out.push({ status: letter, path: parts[i++]! });
    }
  }
  return out;
}

export function parseNumstat(z: string): Map<string, { additions: number; deletions: number; binary: boolean }> {
  const out = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  const parts = z.split("\0");
  for (let i = 0; i < parts.length; ) {
    const rec = parts[i++];
    if (!rec) continue;
    const [a, d, p] = rec.split("\t");
    let path = p ?? "";
    if (!path) {
      i++; // old path of a rename
      path = parts[i++] ?? "";
    }
    const binary = a === "-" && d === "-";
    out.set(path, { additions: binary ? 0 : Number(a), deletions: binary ? 0 : Number(d), binary });
  }
  return out;
}

/** Cut a patch at the last whole file that fits in maxBytes. */
export function truncatePatch(patch: string, maxBytes: number): { patch: string; truncated: boolean } {
  if (Buffer.byteLength(patch) <= maxBytes) return { patch, truncated: false };
  // Char length of the longest prefix that fits in maxBytes, then the last file header that starts inside it.
  const limit = Buffer.from(patch).subarray(0, maxBytes).toString("utf8").replace(/\uFFFD$/, "").length;
  const cut = patch.lastIndexOf("\ndiff --git ", limit - 1);
  return { patch: cut >= 0 ? patch.slice(0, cut + 1) : "", truncated: true };
}

export async function computeChanges(
  exec: Exec,
  opts: { workdir: string; branch: string | null; projectPath: string | null; base?: string | null; maxPatchBytes?: number },
): Promise<Changes> {
  const repo = await Repo.open(exec, opts.workdir);
  const head = await repo.revParse("HEAD");

  let mode: Changes["mode"] = "workdir";
  let base: string | null = "HEAD";
  let baseSha: string | null = head;
  let branch = await repo.currentBranch();
  if (opts.branch) {
    mode = "branch";
    branch = opts.branch;
    base = await resolveBase(repo, exec, opts.projectPath, opts.branch, opts.base);
    baseSha = base && head ? await mergeBase(repo, base) : null; // unrelated histories: diff against the empty tree
  }
  const from = baseSha ?? EMPTY_TREE;

  const untracked = new Set((await repo.ok(["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean));

  return repo.withWorkingTreeIndex(async (env) => ({
    mode,
    base,
    baseSha,
    head,
    branch,
    ...(await diff(repo, ["--cached", from], { env, untracked, maxBytes: opts.maxPatchBytes })),
  }));
}

async function mergeBase(repo: Repo, base: string): Promise<string | null> {
  const mb = await repo.git(["merge-base", base, "HEAD"]);
  return mb.code === 0 ? mb.stdout.trim() : null;
}

/** Files, patch and totals for `git diff <range>` (`["--cached", from]` or `[from, to]`). */
async function diff(repo: Repo, range: string[], opts: { env?: Record<string, string>; untracked?: Set<string>; maxBytes?: number }) {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_PATCH_BYTES;
  const env = opts.env;
  const [nameStatus, numstat, rawPatch] = await Promise.all([
    repo.ok(["diff", ...DIFF_FLAGS, "-z", "--name-status", ...range], { env }),
    repo.ok(["diff", ...DIFF_FLAGS, "-z", "--numstat", ...range], { env }),
    repo.git(["diff", ...DIFF_FLAGS, ...range], { env, maxBytes: maxBytes + 1 }),
  ]);
  if (rawPatch.code !== 0 && !rawPatch.truncated) throw new GitError(500, `git diff failed: ${rawPatch.stderr.trim()}`);
  const stats = parseNumstat(numstat);
  const files: ChangedFile[] = parseNameStatus(nameStatus).map((e) => {
    const s = stats.get(e.path) ?? { additions: 0, deletions: 0, binary: false };
    const status: FileStatus =
      e.status === "A" || e.status === "C" ? (opts.untracked?.has(e.path) ? "untracked" : "added") : e.status === "D" ? "deleted" : e.status === "R" ? "renamed" : "modified";
    return { path: e.path, ...(e.status === "R" ? { oldPath: e.oldPath } : {}), status, ...s };
  });
  files.sort((a, b) => a.path.localeCompare(b.path));
  const { patch, truncated } = truncatePatch(rawPatch.stdout, maxBytes);
  return {
    files,
    patch,
    truncated: truncated || rawPatch.truncated,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
  };
}

// --- pinned diffs -------------------------------------------------------------------------

const PIN_NAMES = ["base", "head", "worktree"] as const;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function pinRef(ticketId: string, name: (typeof PIN_NAMES)[number]): string {
  if (!ID_RE.test(ticketId)) throw new GitError(400, `Invalid ticket id ${ticketId}`);
  return `refs/harness/changes/${ticketId}/${name}`;
}

/** The ticket's pinned diff in the repo at dir, or null when there is none (or dir isn't a repo). */
export async function readPin(exec: Exec, dir: string, ticketId: string): Promise<Pin | null> {
  if (!ID_RE.test(ticketId) || !existsSync(dir)) return null;
  const r = await exec("git", [...BASE_CONFIG, "for-each-ref", "--format=%(refname) %(objectname)", `refs/harness/changes/${ticketId}/`], { cwd: dir });
  if (r.code !== 0) return null;
  const got = new Map(
    r.stdout
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split(" ") as [string, string]),
  );
  const base = got.get(pinRef(ticketId, "base"));
  const head = got.get(pinRef(ticketId, "head"));
  if (!base || !head) return null;
  return { base, head, worktree: got.get(pinRef(ticketId, "worktree")) ?? null };
}

const SNAPSHOT_ENV = {
  GIT_AUTHOR_NAME: "Harness",
  GIT_AUTHOR_EMAIL: "harness@localhost",
  GIT_COMMITTER_NAME: "Harness",
  GIT_COMMITTER_EMAIL: "harness@localhost",
};

/**
 * Pin the ticket branch's current diff (merge-base..worktree as on disk) as refs, so it can be shown
 * after the worktree and branch are gone. The refs also keep the commits reachable after a squash
 * merge. An empty diff never replaces an existing pin: once the branch is merged, merge-base == HEAD
 * and the live diff is empty, but the pin should keep showing what the ticket changed.
 * Returns the pin written, or null when nothing was written.
 */
export async function pinChanges(exec: Exec, opts: { workdir: string; branch: string; projectPath: string | null; base?: string | null; ticketId: string }): Promise<Pin | null> {
  const repo = await Repo.open(exec, opts.workdir);
  const head = await repo.revParse("HEAD");
  const base = await resolveBase(repo, exec, opts.projectPath, opts.branch, opts.base);
  const baseSha = head && base ? await mergeBase(repo, base) : null;
  if (!head || !baseSha) return null;
  const tree = await repo.withWorkingTreeIndex(async (env) => (await repo.ok(["write-tree"], { env })).trim());
  const [baseTree, headTree] = await Promise.all([repo.ok(["rev-parse", `${baseSha}^{tree}`]), repo.ok(["rev-parse", `${head}^{tree}`])]);
  if (tree === baseTree.trim()) return null;
  const worktree =
    tree === headTree.trim()
      ? null
      : (await repo.ok(["commit-tree", "--no-gpg-sign", "-p", head, "-m", `Harness: uncommitted changes on ${opts.branch}`, tree], { env: SNAPSHOT_ENV })).trim();
  const pin: Pin = { base: baseSha, head, worktree };
  await writePin(repo, opts.ticketId, pin);
  return pin;
}

async function writePin(repo: Repo, ticketId: string, pin: Pin) {
  const lines = PIN_NAMES.map((n) => (pin[n] ? `update ${pinRef(ticketId, n)} ${pin[n]}` : `delete ${pinRef(ticketId, n)}`));
  await repo.ok(["update-ref", "--stdin"], { stdin: lines.join("\n") + "\n" });
}

/**
 * Pin a commit the completion agent recorded (the head it pushed to the pull request) as the
 * ticket's diff: merge-base(base, commit)..commit, with no worktree snapshot. Works from the project
 * repo, so it doesn't need the worktree, which the completion may be removing. Like pinChanges, an
 * empty diff never replaces an existing pin. Returns the pin written, or null when nothing changed.
 */
export async function pinCommit(exec: Exec, opts: { repoPath: string; commit: string; branch: string; base?: string | null; ticketId: string }): Promise<Pin | null> {
  const current = await readPin(exec, opts.repoPath, opts.ticketId);
  const repo = await Repo.open(exec, opts.repoPath);
  const head = await repo.revParse(opts.commit);
  if (!head || (current?.head === head && !current.worktree)) return null;
  const base = await resolveBase(repo, exec, opts.repoPath, opts.branch, opts.base);
  const mb = base ? await repo.git(["merge-base", base, head]) : null;
  const baseSha = mb?.code === 0 ? mb.stdout.trim() : null;
  if (!baseSha) return null;
  const [baseTree, headTree] = await Promise.all([repo.ok(["rev-parse", `${baseSha}^{tree}`]), repo.ok(["rev-parse", `${head}^{tree}`])]);
  if (baseTree.trim() === headTree.trim()) return null;
  const pin: Pin = { base: baseSha, head, worktree: null };
  await writePin(repo, opts.ticketId, pin);
  return pin;
}

/** Remove a ticket's pinned refs (the ticket was deleted). */
export async function unpinChanges(exec: Exec, dir: string, ticketId: string): Promise<void> {
  if (!existsSync(dir)) return;
  const lines = PIN_NAMES.map((n) => `delete ${pinRef(ticketId, n)}`);
  await exec("git", [...BASE_CONFIG, "update-ref", "--stdin"], { cwd: dir, stdin: lines.join("\n") + "\n" });
}

/** The pinned diff, read from the project repo (the worktree is gone). */
export async function pinnedChanges(exec: Exec, opts: { repoPath: string; pin: Pin; branch: string | null; base?: string | null; maxPatchBytes?: number }): Promise<Changes> {
  const repo = await Repo.open(exec, opts.repoPath);
  const base = opts.branch ? await resolveBase(repo, exec, opts.repoPath, opts.branch, opts.base) : null;
  const to = opts.pin.worktree ?? opts.pin.head;
  return {
    mode: "pinned",
    base,
    baseSha: opts.pin.base,
    head: opts.pin.head,
    branch: opts.branch,
    worktree: opts.pin.worktree,
    ...(await diff(repo, [opts.pin.base, to], { maxBytes: opts.maxPatchBytes })),
  };
}

export async function commitLog(exec: Exec, opts: { workdir: string; branch: string | null; projectPath: string | null; base?: string | null; limit?: number }) {
  const repo = await Repo.open(exec, opts.workdir);
  const head = await repo.revParse("HEAD");
  if (!opts.branch || !head) return { mode: opts.branch ? ("branch" as const) : ("workdir" as const), base: null, commits: [] as Commit[] };
  const base = await resolveBase(repo, exec, opts.projectPath, opts.branch, opts.base);
  const mb = base ? await mergeBase(repo, base) : null;
  return { mode: "branch" as const, base, commits: await log(repo, mb ? [`${mb}..HEAD`] : ["HEAD"], opts.limit) };
}

/** The pinned branch's commits (base..head), read from the project repo. */
export async function pinnedLog(exec: Exec, opts: { repoPath: string; pin: Pin; branch: string | null; base?: string | null; limit?: number }) {
  const repo = await Repo.open(exec, opts.repoPath);
  const base = opts.branch ? await resolveBase(repo, exec, opts.repoPath, opts.branch, opts.base) : null;
  return { mode: "pinned" as const, base, commits: await log(repo, [`${opts.pin.base}..${opts.pin.head}`], opts.limit) };
}

async function log(repo: Repo, range: string[], limit = 200): Promise<Commit[]> {
  const out = await repo.ok(["log", `--max-count=${limit}`, "--format=%H%x1f%h%x1f%s%x1f%an%x1f%ae%x1f%at%x1e", ...range, "--"]);
  return out
    .split("\x1e")
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [sha, shortSha, subject, author, email, at] = r.split("\x1f");
      return { sha: sha!, shortSha: shortSha!, subject: subject ?? "", author: author ?? "", email: email ?? "", date: Number(at) * 1000 };
    });
}

/** One side of a changed file, for expanding unchanged context in the UI. */
/** `newRef` reads the new side from that commit instead of the worktree on disk (pinned mode). */
export async function fileContents(exec: Exec, opts: { workdir: string; path: string; side: "old" | "new"; ref: string | null; newRef?: string | null; maxBytes?: number }) {
  const repo = await Repo.open(exec, opts.workdir);
  const segments = opts.path.split("/");
  if (!opts.path || opts.path.includes("\0") || isAbsolute(opts.path) || segments.some((s) => s === ".." || s === "" || s === ".git")) {
    throw new GitError(400, "Invalid path");
  }
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
  if (opts.side === "new" && !opts.newRef) {
    const file = resolve(repo.root, ...segments);
    if (!file.startsWith(repo.root + sep) || !existsSync(file) || !statSync(file).isFile()) return null;
    if (statSync(file).size > maxBytes) throw new GitError(413, "File too large");
    return readFileSync(file, "utf8");
  }
  const ref = opts.side === "new" ? opts.newRef : opts.ref;
  if (!ref || !/^[0-9a-f]{7,64}$/.test(ref)) throw new GitError(400, "ref must be a commit sha");
  const r = await repo.git(["cat-file", "blob", `${ref}:${opts.path}`], { maxBytes: maxBytes + 1 });
  if (r.code !== 0) return null;
  if (r.truncated) throw new GitError(413, "File too large");
  return r.stdout;
}

// Git plumbing for the Changes tab. Never touches the user's index or worktree: untracked and
// unstaged files are staged into a throwaway copy of the index (GIT_INDEX_FILE) and diffed from there.

import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { PluginExecOptions, PluginExecResult } from "@harness/plugin-sdk/server";

export type Exec = (cmd: string, args: string[], opts?: PluginExecOptions) => Promise<PluginExecResult>;

export type FileStatus = "added" | "modified" | "deleted" | "renamed" | "untracked";

export interface ChangedFile {
  path: string;
  oldPath?: string;
  status: FileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface Changes {
  /** "branch": ticket branch vs the base branch; "workdir": uncommitted changes vs HEAD */
  mode: "branch" | "workdir";
  /** Base ref name ("main", or "HEAD" in workdir mode); null when no base branch could be found */
  base: string | null;
  /** The commit the diff starts from (merge-base in branch mode, HEAD in workdir mode); null for an empty repo */
  baseSha: string | null;
  /** HEAD of the workdir; null for an unborn branch */
  head: string | null;
  /** The ticket's branch, or the workdir's current branch in workdir mode */
  branch: string | null;
  files: ChangedFile[];
  /** Unified diff (git format), cut at a file boundary when truncated */
  patch: string;
  truncated: boolean;
  additions: number;
  deletions: number;
}

export interface Commit {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  email: string;
  /** epoch ms */
  date: number;
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

/** Base branch for a ticket branch: the project's checked-out branch, else main/master. */
export async function resolveBase(repo: Repo, exec: Exec, projectPath: string | null, ticketBranch: string): Promise<string | null> {
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
  opts: { workdir: string; branch: string | null; projectPath: string | null; maxPatchBytes?: number },
): Promise<Changes> {
  const repo = await Repo.open(exec, opts.workdir);
  const maxBytes = opts.maxPatchBytes ?? DEFAULT_MAX_PATCH_BYTES;
  const head = await repo.revParse("HEAD");

  let mode: Changes["mode"] = "workdir";
  let base: string | null = "HEAD";
  let baseSha: string | null = head;
  let branch = await repo.currentBranch();
  if (opts.branch) {
    mode = "branch";
    branch = opts.branch;
    base = await resolveBase(repo, exec, opts.projectPath, opts.branch);
    if (base && head) {
      const mb = await repo.git(["merge-base", base, "HEAD"]);
      baseSha = mb.code === 0 ? mb.stdout.trim() : null; // unrelated histories: diff against the empty tree
    }
  }
  const from = baseSha ?? EMPTY_TREE;

  const untracked = new Set((await repo.ok(["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean));

  return repo.withWorkingTreeIndex(async (env) => {
    const [nameStatus, numstat, rawPatch] = await Promise.all([
      repo.ok(["diff", "--cached", ...DIFF_FLAGS, "-z", "--name-status", from], { env }),
      repo.ok(["diff", "--cached", ...DIFF_FLAGS, "-z", "--numstat", from], { env }),
      repo.git(["diff", "--cached", ...DIFF_FLAGS, from], { env, maxBytes: maxBytes + 1 }),
    ]);
    if (rawPatch.code !== 0 && !rawPatch.truncated) throw new GitError(500, `git diff failed: ${rawPatch.stderr.trim()}`);
    const stats = parseNumstat(numstat);
    const files: ChangedFile[] = parseNameStatus(nameStatus).map((e) => {
      const s = stats.get(e.path) ?? { additions: 0, deletions: 0, binary: false };
      const status: FileStatus =
        e.status === "A" || e.status === "C" ? (untracked.has(e.path) ? "untracked" : "added") : e.status === "D" ? "deleted" : e.status === "R" ? "renamed" : "modified";
      return { path: e.path, ...(e.status === "R" ? { oldPath: e.oldPath } : {}), status, ...s };
    });
    files.sort((a, b) => a.path.localeCompare(b.path));
    const { patch, truncated } = truncatePatch(rawPatch.stdout, maxBytes);
    return {
      mode,
      base,
      baseSha,
      head,
      branch,
      files,
      patch,
      truncated: truncated || rawPatch.truncated,
      additions: files.reduce((n, f) => n + f.additions, 0),
      deletions: files.reduce((n, f) => n + f.deletions, 0),
    };
  });
}

export async function commitLog(exec: Exec, opts: { workdir: string; branch: string | null; projectPath: string | null; limit?: number }) {
  const repo = await Repo.open(exec, opts.workdir);
  const head = await repo.revParse("HEAD");
  if (!opts.branch || !head) return { mode: opts.branch ? ("branch" as const) : ("workdir" as const), base: null, commits: [] as Commit[] };
  const base = await resolveBase(repo, exec, opts.projectPath, opts.branch);
  const mb = base ? await repo.git(["merge-base", base, "HEAD"]) : null;
  const range = mb?.code === 0 ? [`${mb.stdout.trim()}..HEAD`] : ["HEAD"];
  const out = await repo.ok(["log", `--max-count=${opts.limit ?? 200}`, "--format=%H%x1f%h%x1f%s%x1f%an%x1f%ae%x1f%at%x1e", ...range, "--"]);
  const commits = out
    .split("\x1e")
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [sha, shortSha, subject, author, email, at] = r.split("\x1f");
      return { sha: sha!, shortSha: shortSha!, subject: subject ?? "", author: author ?? "", email: email ?? "", date: Number(at) * 1000 };
    });
  return { mode: "branch" as const, base, commits };
}

/** One side of a changed file, for expanding unchanged context in the UI. */
export async function fileContents(exec: Exec, opts: { workdir: string; path: string; side: "old" | "new"; ref: string | null; maxBytes?: number }) {
  const repo = await Repo.open(exec, opts.workdir);
  const segments = opts.path.split("/");
  if (!opts.path || opts.path.includes("\0") || isAbsolute(opts.path) || segments.some((s) => s === ".." || s === "" || s === ".git")) {
    throw new GitError(400, "Invalid path");
  }
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
  if (opts.side === "new") {
    const file = resolve(repo.root, ...segments);
    if (!file.startsWith(repo.root + sep) || !existsSync(file) || !statSync(file).isFile()) return null;
    if (statSync(file).size > maxBytes) throw new GitError(413, "File too large");
    return readFileSync(file, "utf8");
  }
  if (!opts.ref || !/^[0-9a-f]{7,64}$/.test(opts.ref)) throw new GitError(400, "ref must be a commit sha");
  const r = await repo.git(["cat-file", "blob", `${opts.ref}:${opts.path}`], { maxBytes: maxBytes + 1 });
  if (r.code !== 0) return null;
  if (r.truncated) throw new GitError(413, "File too large");
  return r.stdout;
}

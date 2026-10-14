// The git questions the file list (files.ts) and the file viewer (file-view.ts) ask, as a port
// beside GitPort: production answers them with the git binary, tests from memory
// (next/support/memory-git.ts). next/support/git-contract.ts holds both to the same answers.

import { git as gitText, isGitRepo } from "./worktree";

/** Paths are literal (no globs), and read-only commands don't take the index lock. */
const GIT_GLOBAL = ["--literal-pathspecs", "-c", "core.quotePath=false", "-c", "core.fsmonitor=false"];
/** The git plugin's flags (without -M: one path, so renames aren't followed): output independent of the user's config. */
const DIFF_FLAGS = ["--no-color", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/"];
/** The cap on what a command without its own prints (the viewer's 2 MiB, as before the port). */
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** What a file's diff is taken against: HEAD, the empty tree (a repository with no commits), or nothing (an untracked file). */
export type DiffBase = "head" | "empty" | "untracked";

export interface FileGit {
  /** Whether `path` is inside a git working tree (a folder inside one counts). */
  isRepo(path: string): Promise<boolean>;
  /**
   * The files under `root`, relative and "/"-separated: `files` are tracked or untracked but not
   * ignored; `ignored` are the ignored ones, an ignored folder once as "dir/". Null when git can't list.
   */
  listFiles(root: string): Promise<{ files: string[]; ignored: string[] } | null>;
  /**
   * The two-letter `git status --porcelain` codes for `rel` under `root` ("??" untracked, "!!"
   * ignored, " M", "A ", …); empty when it's tracked and unchanged, unknown to git, or outside a repository.
   */
  status(root: string, rel: string): Promise<string[]>;
  /** Whether the checkout at `root` has a commit. */
  hasHead(root: string): Promise<boolean>;
  /** HEAD's bytes for `rel` under `root`, or null when HEAD doesn't have it or it's over `maxBytes`. */
  headFile(root: string, rel: string, maxBytes: number): Promise<Uint8Array | null>;
  /**
   * The patch from `base` to the working tree's `rel` (staged and unstaged together), paths relative
   * to `root`; `tooLarge` past `maxBytes`. Throws when git fails.
   */
  diff(root: string, rel: string, base: DiffBase, maxBytes: number): Promise<{ patch: Uint8Array; tooLarge: boolean }>;
}

export const realFileGit: FileGit = {
  isRepo: isGitRepo,
  async listFiles(root) {
    const [listed, ignoredList] = await Promise.all([
      gitText(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], root),
      // --directory reports an ignored folder once ("dist/") instead of every file in it.
      gitText(["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"], root),
    ]);
    if (listed.code !== 0) return null;
    return {
      files: listed.stdout.split("\0").filter(Boolean),
      ignored: ignoredList.code === 0 ? ignoredList.stdout.split("\0").filter(Boolean) : [],
    };
  },
  async status(root, rel) {
    const r = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching", "--no-renames", "--", rel], root);
    if (r.code !== 0) return [];
    return decode(r.stdout)
      .split("\0")
      .filter((e) => e.length > 3)
      .map((e) => e.slice(0, 2));
  },
  async hasHead(root) {
    return (await git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], root)).code === 0;
  },
  async headFile(root, rel, maxBytes) {
    // "./" makes the path relative to `root`, which may be a folder inside the repository.
    const spec = `HEAD:./${rel}`;
    const size = await git(["cat-file", "-s", spec], root);
    if (size.code !== 0 || Number(decode(size.stdout).trim()) > maxBytes) return null;
    const blob = await git(["cat-file", "blob", spec], root, maxBytes);
    if (blob.code !== 0 || blob.over) return null;
    return blob.stdout;
  },
  async diff(root, rel, base, maxBytes) {
    const untracked = base === "untracked";
    // An untracked file is all additions: diff it against nothing (exit 1 means "they differ").
    const args = untracked ? ["diff", ...DIFF_FLAGS, "--no-index", "--", "/dev/null", rel] : ["diff", ...DIFF_FLAGS, "--relative", base === "head" ? "HEAD" : EMPTY_TREE, "--", rel];
    const r = await git(args, root, maxBytes);
    if (r.over) return { patch: new Uint8Array(0), tooLarge: true };
    if (r.code !== 0 && !(untracked && r.code === 1)) throw new Error(`git diff failed: ${r.stderr.trim()}`);
    return { patch: r.stdout, tooLarge: false };
  },
};

/** Run git without a shell, keeping stdout's bytes as they are (the worktree helper trims). */
async function git(args: string[], cwd: string, maxBytes = DEFAULT_MAX_BYTES): Promise<{ code: number; stdout: Uint8Array; stderr: string; over: boolean }> {
  const proc = Bun.spawn(["git", ...GIT_GLOBAL, ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
  });
  const chunks: Uint8Array[] = [];
  let total = 0;
  let over = false;
  const reader = proc.stdout.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      over = true;
      proc.kill();
      break;
    }
    chunks.push(value);
  }
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  const stdout = new Uint8Array(over ? 0 : total);
  if (!over) {
    let at = 0;
    for (const c of chunks) {
      stdout.set(c, at);
      at += c.length;
    }
  }
  return { code, stdout, stderr, over };
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

// The file viewer (DESIGN.md "File viewer"): one project or ticket file read from disk (gitignored
// ones included), where it stands in git, and its uncommitted diff against HEAD.

import { realpathSync, statSync, type Stats } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import type { FileDiff, FileGitState, FileView } from "@harness/shared";
import { safeJoin } from "../safe-path";
import { badRequest, conflict, notFound } from "./errors";
import { readHead } from "./files";
import { isGitRepo } from "./worktree";

/** Largest file (either side of a diff, too) whose text is returned. */
export const MAX_VIEW_BYTES = 2 * 1024 * 1024;
/** Largest patch returned; past it the diff comes back empty with `tooLarge`. */
export const MAX_PATCH_BYTES = 4 * 1024 * 1024;
/** A NUL in this much of the start of a file makes it binary, like git's own check. */
const SNIFF_BYTES = 8192;
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
/** The git plugin's flags (without -M: one path, so renames aren't followed): output independent of the user's config. */
const DIFF_FLAGS = ["--no-color", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/"];
/** Paths are literal (no globs), and read-only commands don't take the index lock. */
const GIT_GLOBAL = ["--literal-pathspecs", "-c", "core.quotePath=false", "-c", "core.fsmonitor=false"];

/**
 * `path` (relative to `root`, or absolute inside it) as a "/"-separated relative path and its
 * absolute location. 400 when it leaves `root` (.., a symlink out, an absolute path elsewhere),
 * names `root` itself, or reaches into `.git`.
 */
export function resolveFile(root: string, path: string): { rel: string; abs: string } {
  if (!path) throw badRequest("path is required");
  let rel = path;
  if (isAbsolute(path)) {
    const inRoot = relativeInside(root, path);
    if (inRoot === null) throw badRequest(`${path} is outside ${root}`);
    rel = inRoot;
  }
  if (rel.split(/[\\/]+/).includes(".git")) throw badRequest("Files inside .git can't be viewed");
  const abs = safeJoin(root, rel);
  if (!abs) throw badRequest(`${path} is outside ${root}`);
  const clean = relative(root, abs).split(sep).join("/");
  if (!clean) throw badRequest(`${path} is a folder`);
  return { rel: clean, abs };
}

/** `abs` relative to `root` (or to its real path, as macOS's /var → /private/var), or null when it's elsewhere. */
function relativeInside(root: string, abs: string): string | null {
  const roots = [root];
  try {
    roots.push(realpathSync(root));
  } catch {}
  for (const r of roots) {
    const rel = relative(r, abs);
    if (!rel.startsWith("..") && !isAbsolute(rel)) return rel;
  }
  return null;
}

/** The file at `path` under `root` for the viewer. 404 when it's missing, 400 for a folder. */
export async function readFileView(root: string, path: string): Promise<FileView> {
  const { rel, abs } = resolveFile(root, path);
  const st = statFile(abs, rel);
  if (!st) throw notFound(`No such file: ${rel}`);
  const text = await readText(abs, st.size);
  return { path: rel, root, size: st.size, ...text, git: await gitState(root, rel) };
}

/** The file's working-tree changes against HEAD. 409 when `root` isn't in a git repository. */
export async function readFileDiff(root: string, path: string): Promise<FileDiff> {
  const { rel, abs } = resolveFile(root, path);
  if (!(await isGitRepo(root))) throw conflict(`${root} isn't in a git repository, so its files have no diff`);
  const st = statFile(abs, rel);
  const status = await gitStatus(root, rel);
  // A file deleted from the working tree still has a diff; one git never knew doesn't exist.
  if (!st && !status.length) throw notFound(`No such file: ${rel}`);
  const newContents = st ? (await readText(abs, st.size)).contents : null;
  const untracked = status.includes("??");
  const ignored = status.includes("!!");

  let base = EMPTY_TREE;
  if ((await git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], root)).code === 0) base = "HEAD";
  const oldContents = untracked || ignored || base !== "HEAD" ? null : await blobText(root, rel);

  if (ignored || !status.length) return { path: rel, patch: "", oldContents, newContents, tooLarge: false };
  // An untracked file is all additions: diff it against nothing (exit 1 means "they differ").
  const args = untracked ? ["diff", ...DIFF_FLAGS, "--no-index", "--", "/dev/null", rel] : ["diff", ...DIFF_FLAGS, "--relative", base, "--", rel];
  const r = await git(args, root, MAX_PATCH_BYTES);
  if (r.over) return { path: rel, patch: "", oldContents, newContents, tooLarge: true };
  if (r.code !== 0 && !(untracked && r.code === 1)) throw new Error(`git diff failed: ${r.stderr.trim()}`);
  return { path: rel, patch: decode(r.stdout), oldContents, newContents, tooLarge: false };
}

/** The stat of a regular file, null when nothing is there; 400 for a folder or anything else. */
function statFile(abs: string, rel: string): Stats | null {
  let st: Stats;
  try {
    st = statSync(abs);
  } catch {
    return null;
  }
  if (st.isDirectory()) throw badRequest(`${rel} is a folder`);
  if (!st.isFile()) throw badRequest(`${rel} isn't a regular file`);
  return st;
}

async function readText(abs: string, size: number): Promise<Pick<FileView, "contents" | "binary" | "truncated" | "tooLarge">> {
  const tooLarge = size > MAX_VIEW_BYTES;
  // One byte past the cap tells a file that grew while being read.
  const bytes = await readHead(abs, tooLarge ? SNIFF_BYTES : MAX_VIEW_BYTES + 1);
  const binary = bytes.subarray(0, SNIFF_BYTES).includes(0);
  const truncated = !tooLarge && !binary && bytes.length > MAX_VIEW_BYTES;
  const contents = tooLarge || binary ? null : decode(bytes.subarray(0, MAX_VIEW_BYTES));
  return { contents, binary, truncated, tooLarge };
}

/** HEAD's copy of `rel` as text, or null when HEAD doesn't have it, or it's binary or too large. */
async function blobText(root: string, rel: string): Promise<string | null> {
  // "./" makes the path relative to `root`, which may be a folder inside the repository.
  const spec = `HEAD:./${rel}`;
  const size = await git(["cat-file", "-s", spec], root);
  if (size.code !== 0 || Number(decode(size.stdout).trim()) > MAX_VIEW_BYTES) return null;
  const blob = await git(["cat-file", "blob", spec], root, MAX_VIEW_BYTES);
  if (blob.code !== 0 || blob.over || blob.stdout.subarray(0, SNIFF_BYTES).includes(0)) return null;
  return decode(blob.stdout);
}

/**
 * The two-letter `git status --porcelain` codes for `rel` ("??" untracked, "!!" ignored, " M",
 * "A ", …); empty when it's tracked and unchanged, or unknown to git. Empty outside a repository.
 */
async function gitStatus(root: string, rel: string): Promise<string[]> {
  const r = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching", "--no-renames", "--", rel], root);
  if (r.code !== 0) return [];
  return decode(r.stdout)
    .split("\0")
    .filter((e) => e.length > 3)
    .map((e) => e.slice(0, 2));
}

async function gitState(root: string, rel: string): Promise<FileGitState> {
  if (!(await isGitRepo(root))) return { repo: false, tracked: false, dirty: false, untracked: false, ignored: false };
  const status = await gitStatus(root, rel);
  const untracked = status.includes("??");
  const ignored = status.includes("!!");
  return { repo: true, tracked: !untracked && !ignored, dirty: !ignored && status.length > 0, untracked, ignored };
}

/** Run git without a shell, keeping stdout's bytes as they are (the worktree helper trims). */
async function git(args: string[], cwd: string, maxBytes = MAX_VIEW_BYTES): Promise<{ code: number; stdout: Uint8Array; stderr: string; over: boolean }> {
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

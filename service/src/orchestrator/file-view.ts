// The file viewer (DESIGN.md "File viewer"): one project or ticket file read from disk (gitignored
// ones included), where it stands in git, and its uncommitted diff against HEAD.

import { chmodSync, constants as fsConstants, realpathSync, statSync, type Stats } from "node:fs";
import { access, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import type { FileDiff, FileGitState, FileView, FileWriteResult } from "@harness/shared";
import { inside, safeJoin } from "../safe-path";
import { badRequest, conflict, HarnessError, notFound } from "./errors";
import { invalidatePaths, readHead } from "./files";
import type { FileGit } from "./file-git";

/** Largest file (either side of a diff, too) whose text is returned. */
export const MAX_VIEW_BYTES = 2 * 1024 * 1024;
/** Largest patch returned; past it the diff comes back empty with `tooLarge`. */
export const MAX_PATCH_BYTES = 4 * 1024 * 1024;
/** A NUL in this much of the start of a file makes it binary, like git's own check. */
const SNIFF_BYTES = 8192;
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
  if (rel.split(/[\\/]+/).some((s) => s.toLowerCase() === ".git")) throw badRequest("Files inside .git can't be viewed");
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
export async function readFileView(git: FileGit, root: string, path: string): Promise<FileView> {
  const { rel, abs } = resolveFile(root, path);
  const st = statFile(abs, rel);
  if (!st) throw notFound(`No such file: ${rel}`);
  const text = await readText(abs, st.size);
  return { path: rel, root, size: st.size, ...text, git: await gitState(git, root, rel) };
}

/**
 * Replace the file at `path` under `root` with `contents` (the viewer's editor saving): last write
 * wins, with no check against what's on disk. The file keeps what the editor's text can't carry:
 * its BOM, its line endings (CRLF when most of its breaks were; a mixed file is rewritten to the
 * majority), whether it ends in a newline (the editor can't add or drop the final one), and its mode.
 * Hard links, xattrs and ACLs aren't kept, since the file is replaced. The bytes land in a temp file beside it and are renamed over it, so a reader
 * never sees half a file. A missing file is created (its folder must exist). 400 for a path
 * outside `root` or `.git`, a folder, or text with a NUL; 413 over the 2 MiB cap; 409 when the
 * file on disk is binary, too large to have been shown, or not valid UTF-8; 403 for a read-only
 * file or filesystem; 507 when the disk is full.
 */
export async function writeFileContents(root: string, path: unknown, contents: unknown): Promise<FileWriteResult> {
  if (typeof path !== "string") throw badRequest("path is required");
  if (typeof contents !== "string") throw badRequest("contents must be a string");
  if (contents.includes("\0")) throw badRequest("contents has a NUL byte, so it isn't text");
  const tooBig = () => new HarnessError(413, `contents is over ${MAX_VIEW_BYTES / 1024 / 1024} MiB`);
  if (Buffer.byteLength(contents) > MAX_VIEW_BYTES) throw tooBig();
  const { rel, abs } = resolveFile(root, path);
  const st = statFile(abs, rel);
  // Write through a symlink to its target (safeJoin kept that inside `root`) rather than replacing the link.
  const target = st ? realpathSync(abs) : abs;
  const realRoot = realpathSync(root);
  let realParent: string;
  try {
    realParent = realpathSync(dirname(target));
  } catch {
    throw notFound(`No such folder for ${rel}`);
  }
  if (!inside(realParent, realRoot)) throw badRequest(`${path} is outside ${root}`);
  const dest = join(realParent, basename(target));
  // A symlink into .git (or .GIT on a case-insensitive disk) would let a save rewrite a hook or the config.
  if (relative(realRoot, dest).split(sep).some((s) => s.toLowerCase() === ".git")) throw badRequest("Files inside .git can't be edited");

  let bytes: Uint8Array;
  if (st) {
    if (st.size > MAX_VIEW_BYTES) throw conflict(`${rel} is binary or too large to edit`);
    // One capped read feeds the checks and the line-ending/BOM match.
    const old = await readHead(dest, MAX_VIEW_BYTES + 1);
    if (old.length > MAX_VIEW_BYTES || old.subarray(0, SNIFF_BYTES).includes(0)) throw conflict(`${rel} is binary or too large to edit`);
    let oldText: string;
    try {
      oldText = new TextDecoder("utf-8", { fatal: true }).decode(old);
    } catch {
      throw conflict(`${rel} isn't valid UTF-8, so saving would corrupt it`);
    }
    bytes = encodeLike(contents, old, oldText);
    try {
      await access(dest, fsConstants.W_OK);
    } catch (e) {
      throw fsError(e, rel);
    }
  } else {
    bytes = new TextEncoder().encode(contents);
  }
  // The cap is on what lands on disk: CRs and a BOM can grow what the client sent.
  if (bytes.length > MAX_VIEW_BYTES) throw tooBig();

  const tmp = join(realParent, `.${basename(target)}.harness-${process.pid}-${Math.random().toString(36).slice(2, 10)}.tmp`);
  try {
    const f = await open(tmp, "wx", st ? st.mode & 0o7777 : 0o644);
    try {
      await f.writeFile(bytes);
      await f.sync();
    } finally {
      await f.close();
    }
    // open()'s mode goes through the umask; the file's own mode must survive exactly.
    if (st) chmodSync(tmp, st.mode & 0o7777);
    await rename(tmp, dest);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw fsError(e, rel);
  }
  if (!st) invalidatePaths(root);
  return { path: rel, size: bytes.length };
}

/** A filesystem failure the user can act on as a HarnessError (403, 507, 409); anything else as it is. */
function fsError(e: unknown, rel: string): unknown {
  switch ((e as NodeJS.ErrnoException)?.code) {
    case "EACCES":
    case "EPERM":
      return new HarnessError(403, `${rel} isn't writable`);
    case "EROFS":
      return new HarnessError(403, `${rel} is on a read-only filesystem`);
    case "ENOSPC":
      return new HarnessError(507, `No space left to save ${rel}`);
    case "EEXIST":
      return conflict(`${rel} changed while it was being saved`);
    default:
      return e;
  }
}

/** `contents` as bytes, in `old`'s BOM, line endings and trailing-newline state (an empty `old` has none to keep). */
function encodeLike(contents: string, old: Uint8Array, oldText: string): Uint8Array {
  let text = contents;
  if (old.length) {
    const crlf = (oldText.match(/\r\n/g) ?? []).length;
    const lf = (oldText.match(/(?<!\r)\n/g) ?? []).length;
    const eol = crlf > lf ? "\r\n" : "\n";
    if (eol === "\r\n") text = text.replace(/(?<!\r)\n/g, "\r\n");
    const hadNewline = oldText.endsWith("\n");
    const hasNewline = text.endsWith("\n");
    if (hadNewline && !hasNewline && text) text += eol;
    if (!hadNewline && hasNewline) text = text.slice(0, text.endsWith("\r\n") ? -2 : -1);
  }
  const body = new TextEncoder().encode(text);
  const bom = old.length >= 3 && old[0] === 0xef && old[1] === 0xbb && old[2] === 0xbf && !text.startsWith("\uFEFF");
  if (!bom) return body;
  const out = new Uint8Array(body.length + 3);
  out.set([0xef, 0xbb, 0xbf]);
  out.set(body, 3);
  return out;
}

/** The file's working-tree changes against HEAD. 409 when `root` isn't in a git repository. */
export async function readFileDiff(git: FileGit, root: string, path: string): Promise<FileDiff> {
  const { rel, abs } = resolveFile(root, path);
  if (!(await git.isRepo(root))) throw conflict(`${root} isn't in a git repository, so its files have no diff`);
  const st = statFile(abs, rel);
  const status = await git.status(root, rel);
  // A file deleted from the working tree still has a diff; one git never knew doesn't exist.
  if (!st && !status.length) throw notFound(`No such file: ${rel}`);
  const newContents = st ? (await readText(abs, st.size)).contents : null;
  const untracked = status.includes("??");
  const ignored = status.includes("!!");

  const hasHead = await git.hasHead(root);
  const oldContents = untracked || ignored || !hasHead ? null : await blobText(git, root, rel);

  if (ignored || !status.length) return { path: rel, patch: "", oldContents, newContents, tooLarge: false };
  const r = await git.diff(root, rel, untracked ? "untracked" : hasHead ? "head" : "empty", MAX_PATCH_BYTES);
  if (r.tooLarge) return { path: rel, patch: "", oldContents, newContents, tooLarge: true };
  return { path: rel, patch: decode(r.patch), oldContents, newContents, tooLarge: false };
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
async function blobText(git: FileGit, root: string, rel: string): Promise<string | null> {
  const blob = await git.headFile(root, rel, MAX_VIEW_BYTES);
  if (!blob || blob.subarray(0, SNIFF_BYTES).includes(0)) return null;
  return decode(blob);
}

async function gitState(git: FileGit, root: string, rel: string): Promise<FileGitState> {
  if (!(await git.isRepo(root))) return { repo: false, tracked: false, dirty: false, untracked: false, ignored: false };
  const status = await git.status(root, rel);
  const untracked = status.includes("??");
  const ignored = status.includes("!!");
  return { repo: true, tracked: !untracked && !ignored, dirty: !ignored && status.length > 0, untracked, ignored };
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

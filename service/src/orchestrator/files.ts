// Project files for @-mentions (DESIGN.md "File mentions"): the autocomplete's file list, and the
// mentioned files' contents attached to a run's prompt so the agent doesn't have to read them.

import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseMentions, rankPaths, type FileMatch } from "@harness/shared";
import { git, isGitRepo } from "./worktree";

/** Version-control internals: never listed. */
const VCS_DIRS = new Set([".git", ".hg", ".svn"]);
/**
 * Folders listed but not indexed: dependency trees can hold hundreds of thousands of files.
 * Typing into one (`@node_modules/react/`) still lists what's in it.
 */
const SKIP_DIRS = new Set(["node_modules"]);
/** Finder litter, never worth a mention. */
const JUNK_FILES = new Set([".DS_Store"]);
/** Most files a walk collects (in a git repo, on top of git's list), so a huge folder stays fast. */
const WALK_LIMIT = 20_000;
/** How long a directory's listing is reused, so each keystroke doesn't re-run git. */
const LIST_TTL_MS = 5_000;

export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_ATTACH_BYTES = 1024 * 1024;
const MAX_DIR_ENTRIES = 500;

const cache = new Map<string, { at: number; paths: Promise<string[]> }>();

/**
 * Every file under `root` (relative, "/"-separated) plus every folder that holds one ("src/"),
 * gitignored ones included: build output, local specs and .env files are worth mentioning too.
 * A git repo lists its tracked and untracked files, then its ignored folders are walked; other
 * folders are walked from the top. Either way SKIP_DIRS show up as folders but aren't walked,
 * and VCS_DIRS and JUNK_FILES are left out.
 */
export function listPaths(root: string, now = Date.now()): Promise<string[]> {
  const hit = cache.get(root);
  if (hit && now - hit.at < LIST_TTL_MS) return hit.paths;
  const paths = collect(root).then(withDirs);
  cache.set(root, { at: now, paths });
  paths.catch(() => cache.delete(root));
  return paths;
}

async function collect(root: string): Promise<string[]> {
  if (!existsSync(root)) return [];
  if (await isGitRepo(root)) {
    const [listed, ignored] = await Promise.all([
      git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], root),
      // --directory reports an ignored folder once ("dist/") instead of every file in it.
      git(["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"], root),
    ]);
    if (listed.code === 0) {
      const out = new Set(listed.stdout.split("\0").filter((p) => p && !JUNK_FILES.has(basename(p))));
      const dirs: string[] = [];
      for (const p of ignored.code === 0 ? ignored.stdout.split("\0").filter(Boolean) : []) {
        if (!p.endsWith("/")) {
          if (!JUNK_FILES.has(basename(p))) out.add(p);
        } else if (VCS_DIRS.has(basename(p))) continue;
        else if (SKIP_DIRS.has(basename(p))) out.add(p);
        else {
          out.add(p);
          dirs.push(p.slice(0, -1));
        }
      }
      // Its own budget: a big repo's tracked files shouldn't crowd out its ignored ones.
      walk(root, dirs, out, out.size + WALK_LIMIT);
      return [...out];
    }
  }
  const out = new Set<string>();
  walk(root, [""], out, WALK_LIMIT);
  return [...out];
}

/**
 * Add the files under each of `starts` (relative to `root`) to `out` until it holds `limit`
 * entries, breadth first so shallow files make the cut. A SKIP_DIRS folder is added as "name/",
 * unwalked.
 */
function walk(root: string, starts: string[], out: Set<string>, limit: number) {
  const queue = [...starts];
  for (let i = 0; i < queue.length && out.size < limit; i++) {
    const rel = queue[i]!;
    let entries;
    try {
      entries = readdirSync(join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    if (rel && !entries.length) out.add(`${rel}/`);
    for (const e of entries) {
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (!e.isDirectory()) {
        if (!JUNK_FILES.has(e.name)) out.add(path);
      } else if (VCS_DIRS.has(e.name)) continue;
      else if (SKIP_DIRS.has(e.name)) out.add(`${path}/`);
      else queue.push(path);
      if (out.size >= limit) break;
    }
  }
}

/** Files and folders ("a/"), plus every folder that holds one. */
function withDirs(entries: string[]): string[] {
  const dirs = new Set<string>();
  const files: string[] = [];
  for (const e of entries) {
    if (e.endsWith("/")) dirs.add(e);
    else files.push(e);
    for (let i = e.indexOf("/"); i !== -1 && i < e.length - 1; i = e.indexOf("/", i + 1)) dirs.add(e.slice(0, i + 1));
  }
  return [...dirs, ...files];
}

/**
 * The folder a query is inside ("node_modules/react/" for "node_modules/react/in"), listed from
 * disk, so folders the index skips or cut short can still be browsed one level at a time.
 */
function browse(root: string, query: string): string[] {
  const slash = query.lastIndexOf("/");
  if (slash === -1) return [];
  const dir = query.slice(0, slash + 1);
  const abs = resolve(root, dir);
  const rel = relative(root, abs);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return [];
  try {
    return readdirSync(abs, { withFileTypes: true }).map((e) => `${dir}${e.name}${e.isDirectory() ? "/" : ""}`);
  } catch {
    return [];
  }
}

/** The autocomplete: files and folders under `root` matching `query`, best first. */
export async function searchPaths(root: string, query: string, limit = 50): Promise<FileMatch[]> {
  const q = query.trim();
  const indexed = await listPaths(root);
  const browsed = browse(root, q);
  let paths = indexed;
  if (browsed.length) {
    const have = new Set(indexed);
    paths = [...indexed, ...browsed.filter((p) => !have.has(p))];
  }
  return rankPaths(paths, q, limit).map((path) => ({ path, kind: path.endsWith("/") ? "dir" : "file" }));
}

export interface Attachments {
  /** The prompt with the mentioned files appended (unchanged when nothing was attached). */
  prompt: string;
  /** Paths attached, as mentioned. */
  attached: string[];
  /** Mentioned paths that exist but weren't attached, and why. */
  skipped: { path: string; reason: string }[];
}

/**
 * Append the contents of every file (and the listing of every folder) mentioned in `prompt` that
 * exists inside `cwd`. Mentions that aren't files, like `@someone`, are left alone. Paths that
 * resolve outside `cwd` (`@../secret`, a symlink out) are skipped, as are binary files; big files
 * are cut at MAX_FILE_BYTES and the whole attachment at MAX_ATTACH_BYTES.
 */
export async function attachMentions(prompt: string, cwd: string): Promise<Attachments> {
  const result: Attachments = { prompt, attached: [], skipped: [] };
  const mentions = parseMentions(prompt);
  if (!mentions.length) return result;
  let root: string;
  try {
    root = realpathSync(cwd);
  } catch {
    return result;
  }
  const blocks: string[] = [];
  let budget = MAX_ATTACH_BYTES;
  for (const mention of mentions) {
    const abs = resolve(cwd, mention);
    if (!existsSync(abs)) continue;
    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      continue;
    }
    const rel = relative(root, real);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      result.skipped.push({ path: mention, reason: "outside the working directory" });
      continue;
    }
    const st = statSync(real);
    const shown = rel.split(sep).join("/") || ".";
    if (st.isDirectory()) {
      const entries = readdirSync(real, { withFileTypes: true })
        .filter((e) => !VCS_DIRS.has(e.name) && !JUNK_FILES.has(e.name))
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort();
      const listed = entries.slice(0, MAX_DIR_ENTRIES);
      const more = entries.length - listed.length;
      const block = `<directory path="${shown}/">\n${listed.join("\n")}${more > 0 ? `\n… ${more} more` : ""}\n</directory>`;
      if (block.length > budget) {
        result.skipped.push({ path: mention, reason: "over the attachment limit" });
        continue;
      }
      budget -= block.length;
      blocks.push(block);
      result.attached.push(mention);
      continue;
    }
    if (!st.isFile()) continue;
    if (budget <= 0) {
      result.skipped.push({ path: mention, reason: "over the attachment limit" });
      continue;
    }
    const cap = Math.min(MAX_FILE_BYTES, budget);
    const bytes = await readHead(real, cap);
    if (bytes.subarray(0, 8192).includes(0)) {
      result.skipped.push({ path: mention, reason: "binary file" });
      continue;
    }
    const truncated = st.size > bytes.length;
    const text = new TextDecoder().decode(bytes);
    budget -= bytes.length;
    const attrs = truncated ? ` truncated="first ${bytes.length} of ${st.size} bytes"` : "";
    blocks.push(`<file path="${shown}"${attrs}>\n${text}${text.endsWith("\n") ? "" : "\n"}</file>`);
    result.attached.push(mention);
  }
  if (blocks.length) {
    result.prompt = `${prompt}\n\n<mentioned-files>\nThe user mentioned these files with @. Their contents at the start of this run are below, so you don't need to read them again.\n\n${blocks.join("\n\n")}\n</mentioned-files>`;
  }
  return result;
}

async function readHead(path: string, max: number): Promise<Uint8Array> {
  const fh = await open(path, "r");
  try {
    const buf = new Uint8Array(max);
    const { bytesRead } = await fh.read(buf, 0, max, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

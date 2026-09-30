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
/**
 * The deep index (`ignored`, for the file browser) also walks SKIP_DIRS, after everything else,
 * with its own budget of entries and time so a huge node_modules can't hang the search.
 */
const DEEP_WALK_LIMIT = 200_000;
const DEEP_WALK_MS = 1_500;
/** How long a directory's listing is reused, so each keystroke doesn't re-run git. */
const LIST_TTL_MS = 5_000;
/** The deep index costs up to DEEP_WALK_MS to build, so it's kept longer. */
const DEEP_LIST_TTL_MS = 30_000;

export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_ATTACH_BYTES = 1024 * 1024;
const MAX_DIR_ENTRIES = 500;

/** A folder's index: its paths, and which of them git ignores (or sit inside SKIP_DIRS). */
export interface PathIndex {
  paths: string[];
  ignored: Set<string>;
}

const cache = new Map<string, { at: number; index: Promise<PathIndex> }>();

/**
 * Every file under `root` (relative, "/"-separated) plus every folder that holds one ("src/"),
 * gitignored ones included: build output, local specs and .env files are worth mentioning too.
 * A git repo lists its tracked and untracked files, then its ignored folders are walked; other
 * folders are walked from the top. Either way SKIP_DIRS show up as folders but aren't walked
 * (unless `deep`, which walks them last), and VCS_DIRS and JUNK_FILES are left out.
 */
export function indexPaths(root: string, opts: { now?: number; deep?: boolean } = {}): Promise<PathIndex> {
  const now = opts.now ?? Date.now();
  const deep = !!opts.deep;
  const key = `${deep ? "deep" : "std"}\0${root}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < (deep ? DEEP_LIST_TTL_MS : LIST_TTL_MS)) return hit.index;
  const index = collect(root, deep).then(({ paths, ignored }) => ({ paths: withDirs(paths), ignored }));
  cache.set(key, { at: now, index });
  index.catch(() => cache.delete(key));
  return index;
}

export async function listPaths(root: string, now = Date.now(), opts: { deep?: boolean } = {}): Promise<string[]> {
  return (await indexPaths(root, { now, deep: opts.deep })).paths;
}

async function collect(root: string, deep: boolean): Promise<{ paths: string[]; ignored: Set<string> }> {
  const ignored = new Set<string>();
  if (!existsSync(root)) return { paths: [], ignored };
  const deferred: Dir[] = [];
  const finish = async (out: Set<string>) => {
    if (deep && deferred.length) await walk(root, deferred, out, ignored, { limit: out.size + DEEP_WALK_LIMIT, descend: true, deadline: Date.now() + DEEP_WALK_MS });
    return { paths: [...out], ignored };
  };
  if (await isGitRepo(root)) {
    const [listed, ignoredList] = await Promise.all([
      git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], root),
      // --directory reports an ignored folder once ("dist/") instead of every file in it.
      git(["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"], root),
    ]);
    if (listed.code === 0) {
      const out = new Set(listed.stdout.split("\0").filter((p) => p && !JUNK_FILES.has(basename(p))));
      const dirs: Dir[] = [];
      for (const p of ignoredList.code === 0 ? ignoredList.stdout.split("\0").filter(Boolean) : []) {
        if (!p.endsWith("/")) {
          if (JUNK_FILES.has(basename(p))) continue;
        } else if (VCS_DIRS.has(basename(p))) continue;
        else if (SKIP_DIRS.has(basename(p))) deferred.push({ rel: p.slice(0, -1), ignored: true });
        else dirs.push({ rel: p.slice(0, -1), ignored: true });
        out.add(p);
        ignored.add(p);
      }
      // Its own budget: a big repo's tracked files shouldn't crowd out its ignored ones.
      await walk(root, dirs, out, ignored, { limit: out.size + WALK_LIMIT, deferred });
      return finish(out);
    }
  }
  const out = new Set<string>();
  await walk(root, [{ rel: "", ignored: false }], out, ignored, { limit: WALK_LIMIT, deferred });
  return finish(out);
}

/** A folder to walk, relative to the root, and whether what's in it counts as ignored. */
interface Dir {
  rel: string;
  ignored: boolean;
}

/**
 * Add the files under each of `starts` (relative to `root`) to `out` until it holds `limit`
 * entries (or `deadline` passes), breadth first so shallow files make the cut. A SKIP_DIRS folder
 * is added as "name/" and, unless `descend`, left unwalked (queued on `deferred`); everything in
 * one counts as ignored. Yields to the event loop now and then, since a deep walk can be long.
 */
async function walk(root: string, starts: Dir[], out: Set<string>, ignored: Set<string>, opts: { limit: number; descend?: boolean; deferred?: Dir[]; deadline?: number }) {
  const add = (path: string, ign: boolean) => {
    out.add(path);
    if (ign) ignored.add(path);
  };
  const queue = [...starts];
  for (let i = 0; i < queue.length && out.size < opts.limit; i++) {
    if (i && i % 200 === 0) {
      if (opts.deadline && Date.now() > opts.deadline) break;
      await new Promise((r) => setImmediate(r));
    }
    const dir = queue[i]!;
    let entries;
    try {
      entries = readdirSync(join(root, dir.rel), { withFileTypes: true });
    } catch {
      continue;
    }
    if (dir.rel && !entries.length) add(`${dir.rel}/`, dir.ignored);
    for (const e of entries) {
      const path = dir.rel ? `${dir.rel}/${e.name}` : e.name;
      if (!e.isDirectory()) {
        if (!JUNK_FILES.has(e.name)) add(path, dir.ignored);
      } else if (VCS_DIRS.has(e.name)) continue;
      else if (SKIP_DIRS.has(e.name)) {
        add(`${path}/`, true);
        (opts.descend ? queue : opts.deferred)?.push({ rel: path, ignored: true });
      } else {
        if (dir.ignored) ignored.add(`${path}/`);
        queue.push({ rel: path, ignored: dir.ignored });
      }
      if (out.size >= opts.limit) break;
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
 * disk, so folders the index skips or cut short can still be browsed one level at a time. Like
 * the index it stays inside `root` (symlinks resolved, as attachMentions does) and out of
 * VCS_DIRS, and leaves out JUNK_FILES.
 */
function browse(root: string, query: string): string[] {
  const slash = query.lastIndexOf("/");
  if (slash === -1) return [];
  const dir = query.slice(0, slash + 1);
  if (dir.split("/").some((seg) => VCS_DIRS.has(seg))) return [];
  let abs: string;
  try {
    const real = realpathSync(resolve(root, dir));
    const rel = relative(realpathSync(root), real);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return [];
    abs = real;
  } catch {
    return [];
  }
  try {
    return readdirSync(abs, { withFileTypes: true })
      .filter((e) => (e.isDirectory() ? !VCS_DIRS.has(e.name) : !JUNK_FILES.has(e.name)))
      .map((e) => `${dir}${e.name}${e.isDirectory() ? "/" : ""}`);
  } catch {
    return [];
  }
}

export interface SearchOptions {
  /**
   * The file browser's search: also index SKIP_DIRS (node_modules), and rank ignored paths after
   * the rest when they match equally well, marked `ignored: true`. The @-mention autocomplete leaves it off.
   */
  ignored?: boolean;
  /** Only files, or only folders. */
  kind?: FileMatch["kind"];
}

/** The autocomplete: files and folders under `root` matching `query`, best first. */
export async function searchPaths(root: string, query: string, limit = 50, opts: SearchOptions = {}): Promise<FileMatch[]> {
  const q = query.trim();
  const { paths: indexed, ignored } = await indexPaths(root, { deep: opts.ignored });
  const browsed = browse(root, q);
  let paths = indexed;
  if (browsed.length) {
    const have = new Set(indexed);
    paths = [...indexed, ...browsed.filter((p) => !have.has(p))];
  }
  if (opts.kind) paths = paths.filter((p) => p.endsWith("/") === (opts.kind === "dir"));
  const ranked = rankPaths(paths, q, limit, opts.ignored ? { demote: (p) => ignored.has(p) } : {});
  return ranked.map((path): FileMatch => {
    const m: FileMatch = { path, kind: path.endsWith("/") ? "dir" : "file" };
    // The browser marks ignored paths; the autocomplete's shape stays { path, kind }.
    if (opts.ignored && ignored.has(path)) m.ignored = true;
    return m;
  });
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

/** Up to the first `max` bytes of the file at `path`. */
export async function readHead(path: string, max: number): Promise<Uint8Array> {
  const fh = await open(path, "r");
  try {
    const buf = new Uint8Array(max);
    const { bytesRead } = await fh.read(buf, 0, max, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

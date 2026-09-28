// Project files for @-mentions (DESIGN.md "File mentions"): the autocomplete's file list, and the
// mentioned files' contents attached to a run's prompt so the agent doesn't have to read them.

import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseMentions, rankPaths, type FileMatch } from "@harness/shared";
import { git, isGitRepo } from "./worktree";

/** Folders a non-git walk skips (git repos use .gitignore instead). */
const SKIP_DIRS = new Set([".git", "node_modules", ".hg", ".svn", ".DS_Store"]);
/** Most entries a non-git walk collects, so a mention in a huge folder (a home directory) stays fast. */
const WALK_LIMIT = 20_000;
/** How long a directory's listing is reused, so each keystroke doesn't re-run git. */
const LIST_TTL_MS = 5_000;

export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_ATTACH_BYTES = 1024 * 1024;
const MAX_DIR_ENTRIES = 500;

const cache = new Map<string, { at: number; paths: Promise<string[]> }>();

/**
 * Every file under `root` (relative, "/"-separated) plus every folder that holds one ("src/").
 * Git repos list tracked and untracked-but-not-ignored files; other folders are walked.
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
    const r = await git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], root);
    if (r.code === 0) return [...new Set(r.stdout.split("\0").filter(Boolean))];
  }
  return walk(root);
}

function walk(root: string): string[] {
  const out: string[] = [];
  const stack = [""];
  while (stack.length && out.length < WALK_LIMIT) {
    const rel = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) stack.push(path);
      else out.push(path);
      if (out.length >= WALK_LIMIT) break;
    }
  }
  return out;
}

function withDirs(files: string[]): string[] {
  const dirs = new Set<string>();
  for (const f of files) {
    for (let i = f.indexOf("/"); i !== -1; i = f.indexOf("/", i + 1)) dirs.add(f.slice(0, i + 1));
  }
  return [...dirs, ...files];
}

/** The autocomplete: files and folders under `root` matching `query`, best first. */
export async function searchPaths(root: string, query: string, limit = 50): Promise<FileMatch[]> {
  const paths = await listPaths(root);
  return rankPaths(paths, query.trim(), limit).map((path) => ({ path, kind: path.endsWith("/") ? "dir" : "file" }));
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
        .filter((e) => !SKIP_DIRS.has(e.name))
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

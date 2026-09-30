// The file viewer's pure parts: where a file link in chat opens (route params for app/file.tsx,
// and the rewrite that sends an OS-level harness://file/… URL there), reading those params back,
// which lines of a long file to syntax highlight, and a unified patch as numbered rows.

import { parseFileLink, type FileLink } from "@harness/shared";
import { parseDiff } from "@harness/shared/diff";

/** The ticket (or project) a piece of markdown belongs to, which a link's relative path resolves in. */
export interface FileLinkContext {
  ticketKey?: string;
  projectId?: string;
}

/** app/file.tsx's params. Strings, because that's what the router hands back. */
export interface FileRouteParams {
  path: string;
  ticket?: string;
  project?: string;
  start?: string;
  end?: string;
}

/**
 * Where a file link opens: the link's own `?ticket=`/`?project=` wins, then the markdown's ticket,
 * then its project. Null when nothing names a root to resolve the path in.
 */
export function fileRouteFor(link: FileLink, ctx: FileLinkContext = {}): FileRouteParams | null {
  const root: Pick<FileRouteParams, "ticket" | "project"> | null = link.ticketKey
    ? { ticket: link.ticketKey }
    : link.projectId
      ? { project: link.projectId }
      : ctx.ticketKey
        ? { ticket: ctx.ticketKey }
        : ctx.projectId
          ? { project: ctx.projectId }
          : null;
  if (!root) return null;
  const params: FileRouteParams = { path: link.path, ...root };
  if (link.startLine) params.start = String(link.startLine);
  if (link.startLine && link.endLine) params.end = String(link.endLine);
  return params;
}

const PREFIX = "harness://file/";

/**
 * expo-router's redirectSystemPath for a harness://file/… URL opened from outside the app (Safari,
 * Notes, a QR code): the path-based router would read it as /file/<segments> and drop the #L
 * range, so it's rewritten to the viewer's query form. Anything else comes back null (left alone).
 * A link without `?ticket=`/`?project=` still opens the viewer, which says it can't tell where.
 */
export function fileScreenHref(url: string): string | null {
  if (url.slice(0, PREFIX.length).toLowerCase() !== PREFIX) return null;
  const link = parseFileLink(url);
  if (!link) return null;
  const params = fileRouteFor(link) ?? { path: link.path };
  const query = Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`)
    .join("&");
  return `/file?${query}`;
}

export type FileRoot = { kind: "ticket"; key: string } | { kind: "project"; id: string };

export interface FileTarget {
  root: FileRoot | null;
  path: string;
  /** 1-based, inclusive; start === end for a single line */
  range: [start: number, end: number] | null;
}

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;
const lineNumber = (v: string | undefined) => {
  const n = v === undefined ? NaN : Number(v);
  return Number.isInteger(n) && n >= 1 ? n : null;
};

/** app/file.tsx's params, checked: a missing path is null, and a bad or reversed range is fixed or dropped. */
export function readFileParams(params: Record<string, string | string[] | undefined>): FileTarget | null {
  const path = one(params.path);
  if (!path) return null;
  const ticket = one(params.ticket);
  const project = one(params.project);
  const root: FileRoot | null = ticket ? { kind: "ticket", key: ticket } : project ? { kind: "project", id: project } : null;
  const start = lineNumber(one(params.start));
  const end = lineNumber(one(params.end));
  let range: FileTarget["range"] = null;
  if (start) range = end ? [Math.min(start, end), Math.max(start, end)] : [start, start];
  return { root, path, range };
}

/** A file's lines as the viewer lists them: a trailing newline doesn't add an empty last line. */
export function fileLines(contents: string): string[] {
  const lines = contents.replace(/\r\n/g, "\n").split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** The row to open at for a range starting on `start` (1-based): a few lines above it for context. */
export function initialScrollIndex(start: number | undefined, total: number, context = 3): number {
  if (!start || total <= 0) return 0;
  return Math.max(0, Math.min(total - 1, start - 1 - context));
}

/**
 * Which lines of a long file to syntax highlight: tokenizing runs on the JS thread and the
 * highlighter caps a block's size, so a big file is colored a window at a time. The window grows
 * from `center` (0-based) one line either way, alternately, while its text (newlines included)
 * fits in `maxChars`; a line that alone is over budget still makes a window of one. [from, to).
 */
export function highlightWindow(lengths: number[], center: number, maxChars: number): [from: number, to: number] {
  const n = lengths.length;
  if (!n) return [0, 0];
  const size = (i: number) => lengths[i]! + 1;
  const mid = Math.max(0, Math.min(n - 1, center));
  let from = mid;
  let to = mid + 1;
  let used = size(mid);
  let grew = true;
  while (grew) {
    grew = false;
    if (to < n && used + size(to) <= maxChars) {
      used += size(to++);
      grew = true;
    }
    if (from > 0 && used + size(from - 1) <= maxChars) {
      used += size(--from);
      grew = true;
    }
  }
  return [from, to];
}

export type PatchRowKind = "add" | "del" | "ctx" | "hunk";

export interface PatchRow {
  kind: PatchRowKind;
  /** Code without its +/-/space sign; a hunk row keeps its whole `@@ … @@` header */
  text: string;
  oldLine: number | null;
  newLine: number | null;
  /** The line's index in parseDiff(patch).lines, whose highlight colors it */
  source: number;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * A one-file unified patch (GET …/file/diff) as rows to draw: hunk headers and code lines, each
 * code line numbered on the side(s) it's on. File headers (`diff --git`, `index`, `---`/`+++`) and
 * `\ No newline at end of file` markers are left out; so is everything when the patch has no hunk
 * (a binary change).
 */
export function patchRows(patch: string): PatchRow[] {
  if (!patch) return [];
  const rows: PatchRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  const lines = parseDiff(patch).lines;
  lines.forEach((l, source) => {
    // The patch's final newline leaves an empty last line; it isn't a context line.
    if (l.kind === "meta" || (l.text === "" && source === lines.length - 1)) return;
    if (l.kind === "hunk") {
      const m = HUNK.exec(l.text);
      oldLine = m ? Number(m[1]) : oldLine;
      newLine = m ? Number(m[2]) : newLine;
      rows.push({ kind: "hunk", text: l.text, oldLine: null, newLine: null, source });
      return;
    }
    // Lines before the first hunk (none in git's output) aren't code.
    if (!rows.length) return;
    const text = l.text.slice(1);
    if (l.kind === "add") rows.push({ kind: "add", text, oldLine: null, newLine: newLine++, source });
    else if (l.kind === "del") rows.push({ kind: "del", text, oldLine: oldLine++, newLine: null, source });
    else rows.push({ kind: "ctx", text, oldLine: oldLine++, newLine: newLine++, source });
  });
  return rows;
}

/** "1.2 KB" style size for the header. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let v = bytes / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}

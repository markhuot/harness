// The command palette's pure parts: fuzzy ranking, the ">" / "#" / "@" prefixes, file queries
// (`path:12`, `path#L12-L20`), which root the file browser searches, and the recents lists.
// views/CommandPalette.tsx builds the items (commands, navigation, tickets, files) and renders them.
//
// Ranking is a case-insensitive subsequence match on the label, scored in tiers: the label starts
// with the query, then the query starts a word ("sess" in "New Session") or picks out word
// initials ("ns"), then it's a run inside a word, then scattered letters. Ties go to the more
// recently run item, then to the order the items came in.

export interface PaletteItem {
  id: string;
  label: string;
  group?: string;
  /** Other words it answers to (a project's key). A keyword match ranks below a label match of the same tier. */
  keywords?: string[];
  /** 0 = run most recently; undefined = not recent. */
  recentRank?: number;
}

/** [start, end) character ranges of the label that matched. */
export type MatchRange = [number, number];

export interface Ranked<T extends PaletteItem> {
  item: T;
  ranges: MatchRange[];
  score: number;
}

const TIER_PREFIX = 4;
const TIER_WORD = 3;
const TIER_RUN = 2;
const TIER_SCATTERED = 1;

const isWordChar = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c);

/** A word starts at i: the label's start, after a non-word character, or a camelCase hump. */
function wordStart(s: string, i: number): boolean {
  if (i === 0) return true;
  const prev = s[i - 1]!;
  const cur = s[i]!;
  if (!isWordChar(prev)) return isWordChar(cur);
  return prev === prev.toLowerCase() && cur !== cur.toLowerCase();
}

/** Merge adjacent single-character matches into runs. */
function toRanges(indices: number[]): MatchRange[] {
  const out: MatchRange[] = [];
  for (const i of indices) {
    const last = out[out.length - 1];
    if (last && last[1] === i) last[1] = i + 1;
    else out.push([i, i + 1]);
  }
  return out;
}

/** The best match of `q` (lower-cased, non-empty) in `text`, or null. */
export function matchLabel(q: string, text: string): { tier: number; ranges: MatchRange[] } | null {
  const lower = text.toLowerCase();
  if (lower.startsWith(q)) return { tier: TIER_PREFIX, ranges: [[0, q.length]] };
  // The query as a run that starts a word.
  for (let i = lower.indexOf(q); i !== -1; i = lower.indexOf(q, i + 1)) {
    if (wordStart(text, i)) return { tier: TIER_WORD, ranges: [[i, i + q.length]] };
  }
  // Letters (spaces in the query are ignored from here on) that are word initials: "ns" → New Session.
  const letters = q.replace(/\s+/g, "");
  if (!letters) return null;
  const initials: number[] = [];
  for (let i = 0; i < lower.length && initials.length < letters.length; i++) {
    if (lower[i] === letters[initials.length] && wordStart(text, i)) initials.push(i);
  }
  if (initials.length === letters.length) return { tier: TIER_WORD, ranges: toRanges(initials) };
  const run = lower.indexOf(q);
  if (run !== -1) return { tier: TIER_RUN, ranges: [[run, run + q.length]] };
  // Scattered letters, leftmost first.
  const hits: number[] = [];
  for (let i = 0; i < lower.length && hits.length < letters.length; i++) if (lower[i] === letters[hits.length]) hits.push(i);
  if (hits.length < letters.length) return null;
  return { tier: TIER_SCATTERED, ranges: toRanges(hits) };
}

/**
 * The items matching `query`, best first, with the label's matched ranges. An empty query keeps
 * every item: the recent ones first (most recent first), then the rest in order.
 */
export function rankCommands<T extends PaletteItem>(query: string, items: readonly T[]): Ranked<T>[] {
  const q = query.trim().toLowerCase();
  const recency = (it: T) => it.recentRank ?? Infinity;
  const indexed = items.map((item, i) => ({ item, i }));
  if (!q) {
    return indexed
      .sort((a, b) => recency(a.item) - recency(b.item) || a.i - b.i)
      .map(({ item }) => ({ item, ranges: [], score: 0 }));
  }
  const scored: (Ranked<T> & { i: number })[] = [];
  for (const { item, i } of indexed) {
    const m = matchLabel(q, item.label);
    if (m) {
      // Within a tier, fewer separate pieces read as a better match.
      scored.push({ item, i, ranges: m.ranges, score: m.tier * 100 - Math.min(m.ranges.length, 50) });
      continue;
    }
    const kw = (item.keywords ?? []).map((k) => matchLabel(q, k)).filter((x) => !!x);
    if (kw.length) scored.push({ item, i, ranges: [], score: Math.max(...kw.map((x) => x.tier)) * 100 - 50 });
  }
  return scored.sort((a, b) => b.score - a.score || recency(a.item) - recency(b.item) || a.i - b.i).map(({ item, ranges, score }) => ({ item, ranges, score }));
}

export type PaletteKind = "all" | "commands" | "tickets" | "files";

/** A leading ">" limits the palette to commands, "#" to tickets, "@" to files; the rest is the query. */
export function parsePaletteQuery(raw: string): { kind: PaletteKind; q: string } {
  const s = raw.trimStart();
  if (s.startsWith(">")) return { kind: "commands", q: s.slice(1).trim() };
  if (s.startsWith("#")) return { kind: "tickets", q: s.slice(1).trim() };
  if (s.startsWith("@")) return { kind: "files", q: s.slice(1).trim() };
  return { kind: "all", q: s.trim() };
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/** A file query: the text to search for, and the lines to open at. */
export interface FileQuery {
  search: string;
  startLine?: number;
  endLine?: number;
}

// `path:12`, `path:12-20`, `path:12:3` (a column, dropped), `path#L12`, `path#L12-L20`, `path#L12-20`.
const LINE_SUFFIX = /^(.*?)(?::(\d+)(?:-(\d+)|:\d+)?|#L(\d+)(?:-L?(\d+))?)$/;

/**
 * Split a trailing line or range off a file query, as editors and agents write them. The range is
 * put in order and a one-line range is just its start; line 0 isn't a line.
 */
export function parseFileQuery(q: string): FileQuery {
  const s = q.trim();
  const m = LINE_SUFFIX.exec(s);
  if (!m) return { search: s };
  let start = Number(m[2] ?? m[4]);
  let end = m[3] ?? m[5];
  let last = end === undefined ? undefined : Number(end);
  if (last !== undefined && last < start) [start, last] = [last, start];
  const search = m[1]!.trim();
  if (start < 1) return { search };
  return last !== undefined && last !== start ? { search, startLine: start, endLine: last } : { search, startLine: start };
}

/**
 * A query that reads as a path ("src/app", "app.ts"), so the unprefixed palette shows a few
 * matching files too. Words alone ("settings", "new session") don't.
 */
export const looksLikePath = (q: string): boolean => /[/.]/.test(q) && !/\s/.test(q.trim()) && /[\p{L}\p{N}]/u.test(q);

/** The folder a file browser searches: a ticket's (where its agent works) or a project's. */
export type PaletteFileRoot = { ticketKey: string } | { projectId: string };

/** What the focused pane shows, as far as picking a root cares. */
export type FocusedContent = { kind: "ticket"; ticketKey: string } | { kind: "file"; root: PaletteFileRoot } | { kind: string };

/**
 * The root the palette's file browser searches: the focused ticket pane's ticket, else the root of
 * the focused file pane, else the board's project. Null on the All projects board with neither
 * focused, where there's no one folder to search.
 */
export function paletteFileRoot(focused: FocusedContent | null | undefined, projectId: string | null | undefined): PaletteFileRoot | null {
  if (focused?.kind === "ticket" && "ticketKey" in focused) return { ticketKey: focused.ticketKey };
  if (focused?.kind === "file" && "root" in focused) return focused.root;
  return projectId ? { projectId } : null;
}

const rootPrefix = (root: PaletteFileRoot) => ("ticketKey" in root ? `file:t:${root.ticketKey}\u0000` : `file:p:${root.projectId}\u0000`);

/** A file's id in the palette and its recents: its root plus its path. */
export const fileItemId = (root: PaletteFileRoot, path: string): string => rootPrefix(root) + path;

/** The paths among `recents` (fileItemIds) that belong to `root`, most recent first. */
export function recentFilePaths(recents: readonly string[], root: PaletteFileRoot): string[] {
  const prefix = rootPrefix(root);
  return recents.filter((id) => id.startsWith(prefix) && id.length > prefix.length).map((id) => id.slice(prefix.length));
}

// ---------------------------------------------------------------------------
// Recents
// ---------------------------------------------------------------------------

export const RECENT_KEY = "harness.palette.recent";
export const RECENT_MAX = 8;
/** Files opened from the palette, every root's in one list (recentFilePaths picks a root's). */
export const RECENT_FILES_KEY = "harness.palette.recentFiles";
export const RECENT_FILES_MAX = 30;

type RecentStorage = Pick<Storage, "getItem" | "setItem">;
const defaultStorage = (): RecentStorage | null => (typeof localStorage === "undefined" ? null : localStorage);

/** Item ids run most recently first. Missing, corrupt or unreadable storage is an empty list. */
export function readRecents(storage: RecentStorage | null = defaultStorage(), key = RECENT_KEY, max = RECENT_MAX): string[] {
  try {
    const v: unknown = JSON.parse(storage?.getItem(key) ?? "[]");
    if (!Array.isArray(v)) return [];
    return [...new Set(v.filter((x): x is string => typeof x === "string"))].slice(0, max);
  } catch {
    return [];
  }
}

/** Put `id` at the front of the recents (once), keeping the last `max`. Returns the new list. */
export function pushRecent(id: string, storage: RecentStorage | null = defaultStorage(), key = RECENT_KEY, max = RECENT_MAX): string[] {
  const next = [id, ...readRecents(storage, key, max).filter((x) => x !== id)].slice(0, max);
  try {
    storage?.setItem(key, JSON.stringify(next));
  } catch {}
  return next;
}

/** id → recentRank, for the items' recentRank. */
export const recentRanks = (recents: readonly string[]): Map<string, number> => new Map(recents.map((id, i) => [id, i]));

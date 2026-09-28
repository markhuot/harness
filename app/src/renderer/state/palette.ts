// The command palette's pure parts: fuzzy ranking, the ">" / "#" prefixes and the recents list.
// views/CommandPalette.tsx builds the items (commands, navigation, tickets) and renders them.
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

export type PaletteKind = "all" | "commands" | "tickets";

/** A leading ">" limits the palette to commands, "#" to tickets; the rest is the query. */
export function parsePaletteQuery(raw: string): { kind: PaletteKind; q: string } {
  const s = raw.trimStart();
  if (s.startsWith(">")) return { kind: "commands", q: s.slice(1).trim() };
  if (s.startsWith("#")) return { kind: "tickets", q: s.slice(1).trim() };
  return { kind: "all", q: s.trim() };
}

// ---------------------------------------------------------------------------
// Recents
// ---------------------------------------------------------------------------

export const RECENT_KEY = "harness.palette.recent";
export const RECENT_MAX = 8;

type RecentStorage = Pick<Storage, "getItem" | "setItem">;
const defaultStorage = (): RecentStorage | null => (typeof localStorage === "undefined" ? null : localStorage);

/** Item ids run most recently first. Missing, corrupt or unreadable storage is an empty list. */
export function readRecents(storage: RecentStorage | null = defaultStorage()): string[] {
  try {
    const v: unknown = JSON.parse(storage?.getItem(RECENT_KEY) ?? "[]");
    if (!Array.isArray(v)) return [];
    return [...new Set(v.filter((x): x is string => typeof x === "string"))].slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

/** Put `id` at the front of the recents (once), keeping the last RECENT_MAX. Returns the new list. */
export function pushRecent(id: string, storage: RecentStorage | null = defaultStorage()): string[] {
  const next = [id, ...readRecents(storage).filter((x) => x !== id)].slice(0, RECENT_MAX);
  try {
    storage?.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {}
  return next;
}

/** id → recentRank, for the items' recentRank. */
export const recentRanks = (recents: readonly string[]): Map<string, number> => new Map(recents.map((id, i) => [id, i]));

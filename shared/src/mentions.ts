// @-mentions of project files in prompts and messages, like Claude Code's: `@src/app.ts`, or
// `@"docs/with space.md"` when the path has whitespace. The composers use activeMention and
// insertMention to autocomplete the one being typed; the service uses parseMentions to attach the
// mentioned files to the run's prompt and rankPaths to answer the autocomplete.

/** A file or directory offered by the autocomplete. Directories end in "/". */
export interface FileMatch {
  path: string;
  kind: "file" | "dir";
}

/** The mention the caret is in: text[start, end) is replaced when one is picked. */
export interface ActiveMention {
  start: number;
  end: number;
  /** What's typed between the @ (or @") and the caret. */
  query: string;
  quoted: boolean;
}

// An @ only starts a mention at the start of the text, after whitespace, or after an opening
// bracket or quote, so `mark@example.com` and `a@b` aren't mentions.
const BOUNDARY = /[\s([{"'`]/;
// Punctuation that ends a sentence rather than a path: "look at @src/a.ts."
const TRAILING = /[.,;:!?)\]}'"`]+$/;

function atBoundary(text: string, at: number): boolean {
  return at === 0 || BOUNDARY.test(text[at - 1]!);
}

/** The mention being typed at `caret`, or null when the caret isn't in one. */
export function activeMention(text: string, caret: number): ActiveMention | null {
  if (caret < 0 || caret > text.length) return null;
  // Quoted: @" then anything but a quote or newline up to the caret.
  for (let i = caret - 1; i >= 1; i--) {
    const ch = text[i]!;
    if (ch === "\n") break;
    if (ch === '"') {
      if (text[i - 1] === "@" && atBoundary(text, i - 1)) {
        const close = text.indexOf('"', caret);
        const newline = text.indexOf("\n", caret);
        const end = close !== -1 && (newline === -1 || close < newline) ? close + 1 : caret;
        return { start: i - 1, end, query: text.slice(i + 1, caret), quoted: true };
      }
      break;
    }
  }
  // Unquoted: @ then non-whitespace up to the caret; the mention runs to the end of the word.
  let i = caret - 1;
  while (i >= 0 && !/\s/.test(text[i]!) && text[i] !== "@") i--;
  if (i < 0 || text[i] !== "@" || !atBoundary(text, i)) return null;
  const query = text.slice(i + 1, caret);
  if (query.startsWith('"')) return null;
  let end = caret;
  while (end < text.length && !/\s/.test(text[end]!)) end++;
  return { start: i, end, query, quoted: false };
}

/** How a path is written as a mention. */
export function formatMention(path: string): string {
  return /[\s"]/.test(path) ? `@"${path.replace(/"/g, "")}"` : `@${path}`;
}

/**
 * Replace the active mention with `path`. A file gets a trailing space so typing carries on; a
 * directory ("src/") doesn't, so the autocomplete keeps going inside it.
 */
export function insertMention(text: string, mention: ActiveMention, path: string): { text: string; caret: number } {
  const dir = path.endsWith("/");
  let token = formatMention(path);
  // A quoted directory stays open so the next segment lands inside the quotes.
  if (dir && token.endsWith('"')) token = token.slice(0, -1);
  const after = text.slice(mention.end);
  const space = dir || /^\s/.test(after) ? "" : " ";
  const next = text.slice(0, mention.start) + token + space + after;
  // After a file, the caret skips the space (inserted or already there).
  return { text: next, caret: mention.start + token.length + (dir ? 0 : 1) };
}

/** Every path mentioned in `text`, in order, without duplicates. */
export function parseMentions(text: string): string[] {
  const out: string[] = [];
  const re = /@(?:"([^"\n]+)"|([^\s"]+))/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (!atBoundary(text, m.index)) continue;
    const path = (m[1] ?? m[2]!.replace(TRAILING, "")).trim();
    if (path && !out.includes(path)) out.push(path);
  }
  return out;
}

/**
 * Rank `paths` (files, and directories ending in "/") for the autocomplete, best first:
 * the path starts with the query, then its name does, then any folder name in it does, then it
 * contains the query. Only when none of those match do paths with the query's characters in order
 * ("fmt" → format.ts) count. Case-insensitive; shorter paths win ties. An empty query lists the
 * top level.
 */
export function rankPaths(paths: readonly string[], query: string, limit = 50): string[] {
  const q = query.toLowerCase();
  const scored: { path: string; score: number }[] = [];
  for (const path of paths) {
    // A picked folder ("src/") lists what's in it, not itself again. A file typed in full stays.
    if (q.endsWith("/") && path.toLowerCase() === q) continue;
    const score = q ? matchScore(path.toLowerCase(), q) : topLevel(path) ? 0 : -1;
    if (score >= 0) scored.push({ path, score });
  }
  // Loose in-order matches are noise next to real ones (every path with m…e…n…t in it).
  const loose = scored.some((s) => s.score < LOOSE) ? scored.filter((s) => s.score < LOOSE) : scored;
  loose.sort((a, b) => a.score - b.score || a.path.length - b.path.length || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return loose.slice(0, limit).map((s) => s.path);
}

const LOOSE = 4;

function topLevel(path: string): boolean {
  const slash = path.indexOf("/");
  return slash === -1 || slash === path.length - 1;
}

function matchScore(path: string, q: string): number {
  if (path.startsWith(q)) return 0;
  const segments = path.replace(/\/$/, "").split("/");
  if (segments.at(-1)!.startsWith(q)) return 1;
  if (segments.some((s) => s.startsWith(q))) return 2;
  if (path.includes(q)) return 3;
  let i = 0;
  for (const ch of path) if (ch === q[i] && ++i === q.length) return LOOSE;
  return -1;
}

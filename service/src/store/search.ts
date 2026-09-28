// Ticket search + keyset paging helpers (DESIGN.md "HTTP API": /tickets/page, /tickets/search).

/** A cursor that doesn't decode, or belongs to a different listing. Maps to a 400. */
export class CursorError extends Error {
  constructor() {
    super("Invalid cursor");
  }
}

export const DEFAULT_PAGE_LIMIT = 50;
export const DEFAULT_SEARCH_LIMIT = 100;
export const MAX_PAGE_LIMIT = 200;

/** A requested page size, clamped to 1..MAX_PAGE_LIMIT; missing or non-numeric → the default. */
export function clampLimit(raw: number | string | null | undefined, fallback: number): number {
  const n = typeof raw === "number" ? raw : raw === null || raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_PAGE_LIMIT, Math.max(1, Math.trunc(n)));
}

type CursorValue = string | number;

/**
 * Opaque cursor: base64url JSON of [tag, ...sort key, id]. The tag names the listing it came
 * from ("d" done order, "p" position order, "s" search order) so one can't be replayed on another.
 */
export function encodeCursor(tag: string, values: CursorValue[]): string {
  return Buffer.from(JSON.stringify([tag, ...values])).toString("base64url");
}

/** Decode a cursor made by encodeCursor with this tag and shape ("n" number, "s" string per slot). */
export function decodeCursor(cursor: string, tag: string, shape: ("n" | "s")[]): CursorValue[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new CursorError();
  }
  if (!Array.isArray(parsed) || parsed.length !== shape.length + 1 || parsed[0] !== tag) throw new CursorError();
  const values = parsed.slice(1);
  shape.forEach((kind, i) => {
    const v = values[i];
    if (kind === "n" ? typeof v !== "number" || !Number.isFinite(v) : typeof v !== "string") throw new CursorError();
  });
  return values as CursorValue[];
}

/** Whitespace-separated terms that contain something FTS would index (a letter or digit). */
export function searchTerms(q: string): string[] {
  return q
    .trim()
    .split(/\s+/)
    .filter((t) => /[\p{L}\p{N}]/u.test(t));
}

/**
 * An FTS5 MATCH expression: every term as a quoted string with a prefix star, implicitly ANDed.
 * Quoting makes every FTS operator (`"`, `*`, `-`, `:`, `^`, parentheses, AND/OR/NOT/NEAR) plain
 * text: inside a string only `"` is special, and it's escaped by doubling. The tokenizer then
 * splits punctuation inside a term, so `foo-bar` is the phrase "foo bar*". `column` limits the
 * match to one column. null when there's nothing searchable.
 */
export function ftsQuery(q: string, column?: string): string | null {
  const terms = searchTerms(q).map((t) => `"${t.replace(/"/g, '""')}"*`);
  if (!terms.length) return null;
  const expr = terms.join(" ");
  return column ? `{${column}} : (${expr})` : expr;
}

/** A LIKE pattern matching `s` literally (escape char `\`), with `%` appended when `prefix`. */
export function likePattern(s: string, prefix: boolean): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`) + (prefix ? "%" : "");
}

/** The whole query as a ticket key (exact/prefix match), or null when it can't be one (spaces). */
export function keyCandidate(q: string): string | null {
  const k = q.trim().toUpperCase();
  return k && !/\s/.test(k) ? k : null;
}

/**
 * A short one-line excerpt for a search hit: a window of about `width` characters around the
 * first search term found in the first source that contains one (case-insensitive), or the start
 * of the first non-empty source when no term appears (a key-only match). "…" marks cut ends.
 */
export function searchSnippet(sources: (string | null | undefined)[], q: string, width = 160): string {
  const texts = sources.map((s) => (s ?? "").replace(/\s+/g, " ").trim()).filter(Boolean);
  if (!texts.length) return "";
  const terms = searchTerms(q).map((t) => t.toLowerCase());
  for (const text of texts) {
    const lower = text.toLowerCase();
    const at = terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0);
    if (!at.length) continue;
    const start = Math.max(0, Math.min(...at) - Math.floor(width / 3));
    return clip(text, start, width);
  }
  return clip(texts[0]!, 0, width);
}

function clip(text: string, start: number, width: number): string {
  const end = Math.min(text.length, start + width);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

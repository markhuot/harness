// Labels (DESIGN.md "Labels"): a label is a name plus a color token, shared by every project. A
// ticket carries zero or more by name (Ticket.labels); the colors, counts and recency live in the
// labels collection (GET /labels, the labels.changed event). Search understands `label:` and
// `project:` qualifiers. The iPhone and iPad apps repeat the qualifier parser and the name rules in
// Swift (Logic/SearchQuery.swift) and both test them against labels.fixtures.json.

import { PROJECT_COLORS, isProjectColorId } from "./projectColors";

/** A label as clients show it. Sorted by lastUsedAt (most recently added to a ticket first). */
export interface LabelInfo {
  name: string;
  /** One of LABEL_COLORS: the same preset ids a project color uses, so every theme draws them alike */
  color: string;
  createdAt: number;
  /** When the label was last added to a ticket */
  lastUsedAt: number;
  /**
   * Tickets carrying it that are in progress, blocked or in review: the rule the project counts in
   * the sidebar use. Done tickets and drafts don't count.
   */
  count: number;
}

/** PATCH /labels/:name */
export interface UpdateLabelBody {
  color: string;
}

export const LABEL_COLORS = PROJECT_COLORS;
export const MAX_LABEL_NAME_LENGTH = 40;

export function isLabelColor(v: unknown): v is string {
  return isProjectColorId(v);
}

/**
 * A label name as stored: trimmed with inner whitespace collapsed to single spaces. null when it
 * isn't usable: empty, over MAX_LABEL_NAME_LENGTH, or holding a `"` (which would break the quoted
 * form `label:"…"` in a search).
 */
export function normalizeLabelName(raw: string): string | null {
  const name = raw.trim().replace(/\s+/g, " ");
  if (!name || name.length > MAX_LABEL_NAME_LENGTH || name.includes('"')) return null;
  return name;
}

/** What two names are compared by: case and diacritics ignored ("Bugfix" = "bugfix" = "BÜGFIX" ≈ "bugfix"). */
export function labelKey(name: string): string {
  return name.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** The color a new label starts with: a stable pick from its name, so every client and a re-created label agree. */
export function defaultLabelColor(name: string): string {
  let h = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(labelKey(name))) {
    h ^= byte;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return LABEL_COLORS[h % LABEL_COLORS.length]!.id;
}

/** The name list a ticket carries, normalized and de-duplicated by labelKey (first spelling wins); unusable names dropped. */
export function normalizeLabelNames(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const name = normalizeLabelName(raw);
    if (!name || seen.has(labelKey(name))) continue;
    seen.add(labelKey(name));
    out.push(name);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Search qualifiers
// ---------------------------------------------------------------------------

export type QualifierField = "label" | "project";

/** The last word of a query when it is a qualifier still being typed (what a palette completes). */
export interface QualifierCompletion {
  field: QualifierField;
  /** What was typed after the colon, without its opening quote ("" for a bare `label:`) */
  partial: string;
  /** Where the qualifier starts in the query: what a completion replaces from there to the end */
  start: number;
}

export interface ParsedSearch {
  /** Every `label:` value, in order: all must match (AND) */
  labels: string[];
  /** Every `project:` value (a project key), in order: a ticket matches any of them (OR) */
  projects: string[];
  /** The query without its qualifiers: what the text search runs on */
  text: string;
  /**
   * How many qualifier words the query held, counting ones with no value yet (a bare `label:`).
   * With empty `text`, a query with qualifiers is a filter only, not a text search.
   */
  qualifiers: number;
  completion: QualifierCompletion | null;
}

const FIELD = /^(label|project):/i;

/**
 * Split a search into qualifiers and plain text. A qualifier is `label:` or `project:` (any case)
 * at the start of a word, then a value: bare (up to whitespace) or in double quotes, which may hold
 * spaces (`label:"Release 1.2.3"`). An unclosed quote runs to the end of the query. Other `foo:bar`
 * words stay plain text, and a bare `label:` counts as a qualifier with no value, so a query still
 * being typed never reaches the text search as punctuation.
 */
export function parseSearchQuery(query: string): ParsedSearch {
  const labels: string[] = [];
  const projects: string[] = [];
  const text: string[] = [];
  let qualifiers = 0;
  let completion: QualifierCompletion | null = null;
  let i = 0;
  const n = query.length;
  while (i < n) {
    if (/\s/.test(query[i]!)) {
      i++;
      continue;
    }
    const start = i;
    const m = FIELD.exec(query.slice(i));
    if (m) {
      const field = m[1]!.toLowerCase() as QualifierField;
      i += m[0].length;
      let value: string;
      let open = false;
      if (query[i] === '"') {
        const close = query.indexOf('"', i + 1);
        open = close < 0;
        value = query.slice(i + 1, open ? n : close);
        i = open ? n : close + 1;
      } else {
        let j = i;
        while (j < n && !/\s/.test(query[j]!)) j++;
        value = query.slice(i, j);
        i = j;
      }
      qualifiers++;
      // The word being typed is the last one with nothing after it: an unclosed quote, or a bare value at the end.
      if (i >= n && (open || query[start + m[0].length] !== '"')) completion = { field, partial: value, start };
      const v = value.trim().replace(/\s+/g, " ");
      if (v) (field === "label" ? labels : projects).push(v);
      continue;
    }
    let j = i;
    while (j < n && !/\s/.test(query[j]!)) j++;
    text.push(query.slice(i, j));
    i = j;
  }
  return { labels, projects, text: text.join(" "), qualifiers, completion };
}

/** A qualifier value as typed back into a query: bare when it can be, else in quotes. */
export function quoteQualifierValue(value: string): string {
  return /^[^\s"]+$/.test(value) ? value : `"${value}"`;
}

/** The query with its trailing qualifier-in-progress replaced by a finished `field:value ` (a trailing space so typing goes on). */
export function completeQualifier(query: string, field: QualifierField, value: string): string {
  const completion = parseSearchQuery(query).completion;
  const head = completion ? query.slice(0, completion.start) : query && !/\s$/.test(query) ? `${query} ` : query;
  return `${head}${field}:${quoteQualifierValue(value)} `;
}

import { labelKey, parseSearchQuery, type LabelInfo, type Project, type QualifierCompletion, type QualifierField } from "@harness/shared";

/** One choice in the picker that opens while a `label:` or `project:` is being typed. */
export interface QualifierOption {
  field: QualifierField;
  /** What goes after the colon: the label's name, the project's key. */
  value: string;
  label: string;
  /** A project's name beside its key. */
  detail?: string;
  /** The label's or project's color id. */
  color: string | null;
}

/**
 * The choices for the qualifier at the end of `query` (null when its last word isn't one): labels
 * whose name contains what's typed after the colon, or projects whose key or name does, ignoring
 * case and accents. Names that start with it come first, then the collection's order.
 */
export function qualifierOptions(
  query: string,
  labels: readonly LabelInfo[],
  projects: readonly Project[],
  limit = 8,
): { completion: QualifierCompletion; options: QualifierOption[] } | null {
  const completion = parseSearchQuery(query).completion;
  if (!completion) return null;
  const needle = labelKey(completion.partial.trim());
  const all: (QualifierOption & { hay: string[] })[] =
    completion.field === "label"
      ? labels.map((l) => ({ field: "label", value: l.name, label: l.name, color: l.color, hay: [labelKey(l.name)] }))
      : projects.map((p) => ({ field: "project", value: p.key, label: p.key, detail: p.name, color: p.color ?? null, hay: [labelKey(p.key), labelKey(p.name)] }));
  const hits = all.filter((o) => o.hay.some((h) => h.includes(needle)));
  const starts = (o: { hay: string[] }) => (o.hay.some((h) => h.startsWith(needle)) ? 0 : 1);
  const ordered = hits.map((o, i) => ({ o, i })).sort((a, b) => starts(a.o) - starts(b.o) || a.i - b.i);
  return { completion, options: ordered.slice(0, limit).map(({ o: { hay: _hay, ...option } }) => option) };
}

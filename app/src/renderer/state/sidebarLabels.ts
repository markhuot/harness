import { labelKey, parseSearchQuery, quoteQualifierValue, type LabelInfo } from "@harness/shared";

/** Labels the sidebar shows at first, and how many more each click of "More" reveals. */
export const LABELS_PAGE = 10;

/**
 * The sidebar's Labels section: every label, the ones on tickets first (the collection's order,
 * most recently used first, within each group) and the empty ones after, then the first `limit`.
 * `more` is how many are left.
 */
export function sidebarLabels(labels: readonly LabelInfo[], limit: number = LABELS_PAGE): { shown: LabelInfo[]; more: number } {
  const all = [...labels.filter((l) => l.count > 0), ...labels.filter((l) => l.count === 0)];
  const n = Math.max(0, limit);
  return { shown: all.slice(0, n), more: Math.max(0, all.length - n) };
}

/** The board search a click on a label sets, or "" when that label alone is already the search. */
export function labelSearchToggle(current: string, name: string): string {
  const parsed = parseSearchQuery(current);
  const only = parsed.qualifiers === 1 && parsed.labels.length === 1 && !parsed.text && labelKey(parsed.labels[0]!) === labelKey(name);
  return only ? "" : `label:${quoteQualifierValue(name)}`;
}

/** Whether the board search is filtering by this label (it may carry other words too). */
export function labelSearchActive(current: string, name: string): boolean {
  return parseSearchQuery(current).labels.some((l) => labelKey(l) === labelKey(name));
}

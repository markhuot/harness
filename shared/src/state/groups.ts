// The project group field in project settings: the rows its picker shows for what's typed. The
// group rules themselves (names, matching, the list) live in ../projectGroups.

import { normalizeProjectGroup, PROJECT_GROUP_MAX, sameGroup } from "../projectGroups";

export type GroupRow =
  /** Leave the project out of every group */
  | { kind: "none"; value: null; label: string }
  | { kind: "group"; value: string; label: string }
  /** The typed name, which no group has yet */
  | { kind: "new"; value: string; label: string }
  /** A typed name the service would refuse (not pickable) */
  | { kind: "invalid"; value: null; label: string };

export const NO_GROUP_LABEL = "No group";

/**
 * How well a group's name matches the typed text (lower-cased, whitespace collapsed), best first:
 * 0 the same name in any case, 1 the name starts with it, 2 a word of the name does (after a
 * character that isn't a letter or digit), 3 it's elsewhere or only its words are.
 */
export function groupMatchRank(group: string, typed: string): number {
  if (sameGroup(group, typed)) return 0;
  const lower = group.toLowerCase();
  if (lower.startsWith(typed)) return 1;
  for (let i = lower.indexOf(typed, 1); i > 0; i = lower.indexOf(typed, i + 1)) if (!/[\p{L}\p{N}]/u.test(lower[i - 1]!)) return 2;
  return 3;
}

/**
 * A group picker's rows for `query`. Nothing typed: No group, then every group. Otherwise the
 * groups whose name has every typed word, best match first (groupMatchRank, alphabetical within a
 * rank), then No group when every typed word is in its label, then the typed name as a new group
 * when no group has it in any case (typing "work" picks "Work" instead). The first row is the best
 * pick, so Enter on a typed name joins the group it completes to, or starts a new one.
 */
export function groupRows(groups: readonly string[], query: string): GroupRow[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const typed = words.join(" ");
  const none: GroupRow = { kind: "none", value: null, label: NO_GROUP_LABEL };
  const matches = groups
    .filter((g) => words.every((w) => g.toLowerCase().includes(w)))
    .map((g, i) => ({ g, i, rank: groupMatchRank(g, typed) }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map(({ g }): GroupRow => ({ kind: "group", value: g, label: g }));
  if (!typed) return [none, ...matches];
  const rows = [...matches];
  if (words.every((w) => NO_GROUP_LABEL.toLowerCase().includes(w))) rows.push(none);
  const name = normalizeProjectGroup(query);
  if (name === undefined) rows.push({ kind: "invalid", value: null, label: `Group names are at most ${PROJECT_GROUP_MAX} characters` });
  else if (name !== null && !groups.some((g) => sameGroup(g, name))) rows.push({ kind: "new", value: name, label: `New group "${name}"` });
  return rows;
}

/**
 * The rows' ids for keyboard focus, in order: No group is "", a group (or new name) its name.
 * Invalid rows have none.
 */
export function groupRowIds(rows: readonly GroupRow[]): string[] {
  return rows.flatMap((r) => (r.kind === "invalid" ? [] : [r.value ?? ""]));
}

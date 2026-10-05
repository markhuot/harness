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
 * A group picker's rows for `query`: No group first (while nothing is typed, or every typed word is
 * in its label), then the existing groups whose name has every typed word, then the typed name as a
 * new group when no group has it (in any case: typing "work" picks "Work" instead). So Enter on a
 * typed name either joins the group it completes to or starts a new one.
 */
export function groupRows(groups: readonly string[], query: string): GroupRow[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const rows: GroupRow[] = [];
  if (words.every((w) => NO_GROUP_LABEL.toLowerCase().includes(w))) rows.push({ kind: "none", value: null, label: NO_GROUP_LABEL });
  for (const g of groups) if (words.every((w) => g.toLowerCase().includes(w))) rows.push({ kind: "group", value: g, label: g });
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

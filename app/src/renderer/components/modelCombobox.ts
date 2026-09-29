// Pure parts of the driver + model combobox (ModelSelect.tsx DriverModelSelect): the rows the
// popover shows for a query, the active option's movement over them, and which keys open it with
// type-ahead. Filtering itself is filterChoiceGroups in @harness/shared/state.

import { filterChoiceGroups, type ChoiceGroup, type ModelOption } from "@harness/shared/state";
import { rovingIndex, type RovingMove } from "./useRovingList";

export type ComboRow = { kind: "heading"; driver: string; label: string } | { kind: "option"; value: string; label: string };

/**
 * The popover's rows for `query`: Default first (hidden while a query is typed unless every word
 * of it is in Default's label), then each group's heading (none for a flat, unlabelled group) and
 * its matching options.
 */
export function comboRows(def: ModelOption, groups: ChoiceGroup[], query: string, driverNames: Record<string, string> = {}): ComboRow[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const rows: ComboRow[] = [];
  const defLabel = def.label.toLowerCase();
  if (words.every((w) => defLabel.includes(w))) rows.push({ kind: "option", value: def.value, label: def.label });
  for (const g of filterChoiceGroups(groups, query, driverNames)) {
    if (g.label !== null) rows.push({ kind: "heading", driver: g.driver, label: g.label });
    for (const o of g.options) rows.push({ kind: "option", value: o.value, label: o.label });
  }
  return rows;
}

/** The pickable values among `rows`, in order (headings skipped). */
export function optionValues(rows: ComboRow[]): string[] {
  return rows.flatMap((r) => (r.kind === "option" ? [r.value] : []));
}

/**
 * Where the active option goes: ↑/↓ wrap over the options (headings never take it), Home/End jump
 * to the ends. With no active option (or one the filter removed) down starts at the first and up at
 * the last. null when nothing is left to pick.
 */
export function moveActive(values: string[], active: string | null, move: RovingMove): string | null {
  const i = rovingIndex(values.length, active === null ? -1 : values.indexOf(active), move, true);
  return i < 0 ? null : values[i]!;
}

/** The option active when the list (re)renders: the current one if it's still there, else the picked value, else the first. */
export function settleActive(values: string[], active: string | null, picked: string): string | null {
  if (active !== null && values.includes(active)) return active;
  if (values.includes(picked)) return picked;
  return values[0] ?? null;
}

/** A key that should open the closed combobox with itself as the start of the search. */
export function isTypeaheadKey(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean }): boolean {
  return e.key.length === 1 && e.key !== " " && !e.metaKey && !e.ctrlKey && !e.altKey;
}

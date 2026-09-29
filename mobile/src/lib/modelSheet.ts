// Rows for the searchable Model sheet (the combined driver + model picker): the Default option,
// (when offered), then one section per driver, narrowed by the type-ahead query. Kept free of React Native so it
// can be unit tested.
import { filterChoiceGroups, type ChoiceOptions, type ModelOption } from "@harness/shared/state";

export interface ChoiceSection {
  key: string;
  /** Driver name heading; null → no header (the Default row, or a single driver's flat list) */
  title: string | null;
  data: ModelOption[];
}

/**
 * Sections for a SectionList. With no query everything shows, Default first. While a query is
 * typed, drivers and models are filtered by the shared type-ahead and Default only stays when its
 * own label matches every word. An empty result means "No models match".
 */
export function choiceSections(choices: Pick<ChoiceOptions, "default" | "groups">, query: string, driverNames: Record<string, string> = {}): ChoiceSection[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const def = choices.default;
  const showDefault = !!def && (!words.length || words.every((w) => def.label.toLowerCase().includes(w)));
  const groups = filterChoiceGroups(choices.groups, query, driverNames);
  return [
    ...(showDefault ? [{ key: "", title: null, data: [def!] }] : []),
    ...groups.map((g) => ({ key: g.driver, title: g.label, data: g.options })),
  ];
}

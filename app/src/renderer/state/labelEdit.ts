import { MAX_LABEL_NAME_LENGTH, labelKey, normalizeLabelName, type LabelInfo } from "@harness/shared";

/** Existing labels the ticket doesn't carry yet that match what's typed (any case or accent), most recently used first. */
export function labelSuggestions(known: readonly LabelInfo[], current: readonly string[], typed: string, limit = 6): LabelInfo[] {
  const have = new Set(current.map(labelKey));
  const needle = labelKey(typed.trim());
  return known.filter((l) => !have.has(labelKey(l.name)) && labelKey(l.name).includes(needle)).slice(0, limit);
}

export type AddLabel = { labels: string[] } | { error: string };

/**
 * The ticket's labels with what was typed added: an existing label keeps its own spelling, a new
 * name is created as typed. A name the service would refuse is an error to show; one the ticket
 * already carries changes nothing.
 */
export function addLabel(known: readonly LabelInfo[], current: readonly string[], typed: string): AddLabel {
  const name = normalizeLabelName(typed);
  if (name === null) {
    if (!typed.trim()) return { labels: [...current] };
    return { error: typed.includes('"') ? "A label name can't contain a double quote." : `A label name is at most ${MAX_LABEL_NAME_LENGTH} characters.` };
  }
  const key = labelKey(name);
  if (current.some((c) => labelKey(c) === key)) return { labels: [...current] };
  return { labels: [...current, known.find((l) => labelKey(l.name) === key)?.name ?? name] };
}

export const removeLabel = (current: readonly string[], name: string): string[] => current.filter((c) => labelKey(c) !== labelKey(name));

/** One row of a label picker: a label that exists, or the new name the typed text would create. */
export type LabelOption = { kind: "existing"; name: string; color: string | null } | { kind: "create"; name: string };

/**
 * The rows of a label picker for a ticket carrying `current`. Adding lists the labels it doesn't
 * carry that match the typed text (all of them while nothing's typed), then "create" for text that
 * is a valid name no label has yet. Removing lists the ticket's own labels that match.
 */
export function labelOptions(known: readonly LabelInfo[], current: readonly string[], typed: string, mode: "add" | "remove", limit = 8): LabelOption[] {
  const needle = labelKey(typed.trim());
  if (mode === "remove") {
    return current
      .filter((name) => labelKey(name).includes(needle))
      .slice(0, limit)
      .map((name) => ({ kind: "existing", name, color: known.find((l) => l.name === name)?.color ?? null }));
  }
  // An exact match (any case) leads, so Enter on a fully typed name picks it.
  const rows: LabelOption[] = labelSuggestions(known, current, typed, limit)
    .sort((a, b) => Number(labelKey(b.name) === needle) - Number(labelKey(a.name) === needle))
    .map((l) => ({ kind: "existing", name: l.name, color: l.color }));
  const name = normalizeLabelName(typed);
  const exists = name !== null && (known.some((l) => labelKey(l.name) === labelKey(name)) || current.some((c) => labelKey(c) === labelKey(name)));
  if (name !== null && !exists) rows.push({ kind: "create", name });
  return rows;
}

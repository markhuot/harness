// Option shape for the native selects, and the trigger's label for a value.

export interface SelectOption<V extends string = string> {
  value: V;
  label: string;
  /** Second line in the menu (a description) */
  subtitle?: string;
  disabled?: boolean;
}

/** The trigger's text: the selected option's label, or `fallback` when the value isn't listed. */
export function selectedLabel(options: SelectOption[], value: string, fallback: string): string {
  return options.find((o) => o.value === value)?.label ?? fallback;
}

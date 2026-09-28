// Option lists for the Driver selects. The screens differ in what "no choice" means (the global
// default, the project's fallback, a watcher's default) and in how they flag drivers that can't run.

import type { DriverInfo } from "@harness/shared";

export interface SelectOption<V extends string = string> {
  value: V;
  label: string;
  /** Second line in the menu (a description) */
  subtitle?: string;
  disabled?: boolean;
}

/**
 * Drivers as select options. `none` adds a leading "no choice" option with the value "" (for
 * settings that fall back to something else). `unavailable` decides what happens to a driver that
 * isn't installed: "disable" greys it out, "mark" keeps it pickable with a note (an existing ticket
 * may already use it). A driver that isn't signed in keeps its label note either way.
 */
export function driverOptions(drivers: Pick<DriverInfo, "id" | "name" | "available" | "authenticated">[], opts: { none?: string; unavailable?: "disable" | "mark" } = {}): SelectOption[] {
  return [
    ...(opts.none !== undefined ? [{ value: "", label: opts.none }] : []),
    ...drivers.map((d) => {
      const notes = [!d.available && opts.unavailable === "mark" ? "unavailable" : null, d.available && !d.authenticated ? "not signed in" : null].filter(Boolean);
      return { value: d.id, label: notes.length ? `${d.name} · ${notes.join(", ")}` : d.name, ...(!d.available && opts.unavailable === "disable" ? { disabled: true } : {}) };
    }),
  ];
}

/** The trigger's text: the selected option's label, or `fallback` when the value isn't listed. */
export function selectedLabel(options: SelectOption[], value: string, fallback: string): string {
  return options.find((o) => o.value === value)?.label ?? fallback;
}

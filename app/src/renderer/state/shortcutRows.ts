// The rows of the keyboard shortcuts overlay, from the command registry.

import { COMMANDS, commandKeys, type CommandGroup } from "./keys";

interface Row {
  id: string;
  label: string;
  keys: string[];
}

/** The rows for a group, in registry order; tab.1 … tab.9 are one row. */
export function shortcutRows(group: CommandGroup): Row[] {
  const rows: Row[] = [];
  for (const c of COMMANDS) {
    if (c.group !== group || !c.keys.length) continue;
    if (/^tab\.\d$/.test(c.id)) {
      if (c.id === "tab.1") rows.push({ id: "tab.n", label: "Jump to tab 1–9", keys: ["1–9"] });
      continue;
    }
    rows.push({ id: c.id, label: c.label, keys: commandKeys(c.id) });
  }
  return rows;
}

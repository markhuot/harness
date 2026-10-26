// What a tab is called when it's torn off or dragged.

import type { PluginTab as PluginTabRef } from "@harness/shared";
import { CHANGES_LABEL, CHANGES_TAB, parsePluginTab, tabStripTab, TAB_LABEL, type TicketTab } from "@harness/shared/state";

/** A tab's name in a placeholder, a drag image or a torn-off pane's header. */
export function tornTabName(tab: TicketTab, pluginTabs: PluginTabRef[] | null | undefined): string {
  const t = tabStripTab(tab);
  if (t === CHANGES_TAB) return CHANGES_LABEL;
  const plugin = parsePluginTab(t);
  if (plugin) return pluginTabs?.find((p) => p.pluginId === plugin.pluginId && p.id === plugin.tabId)?.title ?? plugin.tabId;
  return TAB_LABEL[t as keyof typeof TAB_LABEL] ?? t;
}

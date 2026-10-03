// The Changes tab is built into the apps: they draw the ticket's diff themselves instead of hosting
// the git plugin's page (the desktop's ChangesTab.tsx, the iOS app's ChangesTabView). The service
// still offers it as the git plugin's "changes" tab, so this layer sits on top of tabs.ts (whose
// fixture-checked functions don't know about it), as HarnessKit's ChangesTab.swift does: it maps
// "plugin:git:changes" to the built-in "changes" tab, keeps git:changes out of the plugin tabs, and
// decides when the tab shows.
import { effectiveTab, pluginTabRoute, ticketTabFrom, visibleTabs, type TicketTab } from "./tabs";

type PluginTabRef = { pluginId: string; id: string };

export const CHANGES_TAB = "changes" satisfies TicketTab;
export const CHANGES_LABEL = "Changes";
/** The plugin tab the built-in one replaces. */
export const CHANGES_PLUGIN = { pluginId: "git", id: "changes" } as const;
export const CHANGES_PLUGIN_ROUTE = pluginTabRoute(CHANGES_PLUGIN.pluginId, CHANGES_PLUGIN.id);

export const isPluginChanges = (t: PluginTabRef) => t.pluginId === CHANGES_PLUGIN.pluginId && t.id === CHANGES_PLUGIN.id;

/** "plugin:git:changes" (old links and saved panes) → "changes"; every other tab as is. */
export const normalizeChangesTab = (tab: TicketTab): TicketTab => (tab === CHANGES_PLUGIN_ROUTE ? CHANGES_TAB : tab);

/**
 * ticketTabFrom, plus "changes" (and "plugin:git:changes" normalized to it): a tab id from a link or a
 * saved route, renamed ids mapped to their new tab, null when it isn't one.
 */
export function ticketTabWithChanges(t: string | undefined | null): TicketTab | null {
  if (t === CHANGES_TAB) return CHANGES_TAB;
  const tab = ticketTabFrom(t);
  return tab && normalizeChangesTab(tab);
}

/** The ticket's plugin tabs without git:changes, which the built-in tab replaces. Null stays null (not loaded yet). */
export function otherPluginTabs<T extends PluginTabRef>(tabs: T[] | null | undefined): T[] | null {
  return tabs ? tabs.filter((t) => !isPluginChanges(t)) : null;
}

/**
 * Whether the ticket has a Changes tab. The service decides: once the plugin tabs have loaded, only
 * when they list git:changes (the plugin is enabled and its `when: "workdir"` holds, or a diff was
 * pinned before the worktree went away; the git plugin's `showTab`). Until they load, a workdir is
 * the best guess.
 */
export function showsChangesTab(workdir: string | null | undefined, pluginTabs: PluginTabRef[] | null | undefined): boolean {
  if (!pluginTabs) return !!workdir;
  return pluginTabs.some(isPluginChanges);
}

type Opts = { conductor: boolean; workdir: string | null | undefined; pluginTabs: PluginTabRef[] | null; subagents?: { id: string }[] | null };

/**
 * effectiveTab with the built-in Changes tab: shown while it applies (and while the plugin tabs that
 * could say it does aren't loaded yet), else the Spec.
 */
export function effectiveTabWithChanges(requested: TicketTab, opts: Opts): TicketTab {
  const tab = normalizeChangesTab(requested);
  if (tab === CHANGES_TAB) return opts.pluginTabs === null || showsChangesTab(opts.workdir, opts.pluginTabs) ? CHANGES_TAB : "spec";
  return effectiveTab(tab, { conductor: opts.conductor, subagents: opts.subagents, pluginTabs: otherPluginTabs(opts.pluginTabs) });
}

/** visibleTabs with Changes after Browser, ahead of Details. */
export function visibleTabsWithChanges(opts: Omit<Opts, "pluginTabs"> & { pluginTabs?: PluginTabRef[] | null }): TicketTab[] {
  const tabs = visibleTabs({ conductor: opts.conductor, subagents: opts.subagents, pluginTabs: otherPluginTabs(opts.pluginTabs) });
  const i = tabs.indexOf("details");
  if (showsChangesTab(opts.workdir, opts.pluginTabs) && i >= 0) tabs.splice(i, 0, CHANGES_TAB);
  return tabs;
}

/** The git plugin's icon for the tab (plugins/git/plugin.json). */
export const CHANGES_DEFAULT_ICON = "branch";

/** The tab's icon: the one the service lists for git:changes, else the plugin's default. */
export function changesTabIcon(pluginTabs: { pluginId: string; id: string; icon?: string | null }[] | null | undefined): string {
  return pluginTabs?.find(isPluginChanges)?.icon || CHANGES_DEFAULT_ICON;
}

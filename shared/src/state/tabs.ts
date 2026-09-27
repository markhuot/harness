// Ticket detail tabs, shared by every client: the built-in tabs and plugin tabs addressed as
// "plugin:<pluginId>:<tabId>" (DESIGN.md "Plugins"). The desktop puts these in its hash route; the
// phone keeps them in navigation params.

/** "children" is the conductor-only Tickets tab (listed right after Summaries). */
export type BuiltinTicketTab = "summaries" | "children" | "transcript" | "browser" | "details";
/** Built-in tabs, or a plugin tab as "plugin:<pluginId>:<tabId>". */
export type TicketTab = BuiltinTicketTab | `plugin:${string}:${string}`;
export const TICKET_TABS: BuiltinTicketTab[] = ["summaries", "children", "transcript", "browser", "details"];

export const TAB_LABEL: Record<BuiltinTicketTab, string> = {
  summaries: "Summaries",
  children: "Tickets",
  transcript: "Transcript",
  browser: "Browser",
  details: "Details",
};

const PLUGIN_TAB = /^plugin:([a-z0-9][a-z0-9_-]*):([a-z0-9][a-z0-9_-]*)$/;

export function pluginTabRoute(pluginId: string, tabId: string): TicketTab {
  return `plugin:${pluginId}:${tabId}`;
}

/** "plugin:git:changes" → { pluginId: "git", tabId: "changes" }; null for built-in tabs. */
export function parsePluginTab(tab: string): { pluginId: string; tabId: string } | null {
  const m = PLUGIN_TAB.exec(tab);
  return m ? { pluginId: m[1]!, tabId: m[2]! } : null;
}

export function isTicketTab(t: string | undefined | null): t is TicketTab {
  return !!t && ((TICKET_TABS as string[]).includes(t) || PLUGIN_TAB.test(t));
}

/**
 * The tab to show for a requested one: a plugin tab that doesn't apply (once the ticket's plugin
 * tabs are known) and the conductor-only Tickets tab on a plain ticket fall back to Summaries.
 */
export function effectiveTab(requested: TicketTab, opts: { conductor: boolean; pluginTabs: { pluginId: string; id: string }[] | null }): TicketTab {
  if (requested === "children" && !opts.conductor) return "summaries";
  const p = parsePluginTab(requested);
  if (p && opts.pluginTabs && !opts.pluginTabs.some((t) => t.pluginId === p.pluginId && t.id === p.tabId)) return "summaries";
  return requested;
}

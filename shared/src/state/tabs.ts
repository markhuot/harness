// Ticket detail tabs, shared by every client: the built-in tabs, plugin tabs addressed as
// "plugin:<pluginId>:<tabId>" (DESIGN.md "Plugins") and one sub-agent's transcript as
// "agent:<subagentId>" (under the Agents tab, DESIGN.md "Sub-agents"). The desktop puts these in
// its hash route; the phone keeps them in navigation params.

/**
 * "children" is the conductor-only Tickets tab (listed right after Summaries). "agents" lists the
 * session's sub-agents; it exists only once the session has any.
 */
export type BuiltinTicketTab = "summaries" | "children" | "transcript" | "agents" | "browser" | "details";
/** Built-in tabs, a plugin tab as "plugin:<pluginId>:<tabId>", or a sub-agent as "agent:<id>". */
export type TicketTab = BuiltinTicketTab | `plugin:${string}:${string}` | `agent:${string}`;
export const TICKET_TABS: BuiltinTicketTab[] = ["summaries", "children", "transcript", "agents", "browser", "details"];

export const TAB_LABEL: Record<BuiltinTicketTab, string> = {
  summaries: "Summaries",
  children: "Tickets",
  transcript: "Transcript",
  agents: "Agents",
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

/** Tool call ids (the sub-agent ids Claude Code gives) are letters, digits, "_" and "-". */
const AGENT_TAB = /^agent:([A-Za-z0-9_-]{1,128})$/;

/** The tab showing one sub-agent's transcript. */
export function subagentTabRoute(subagentId: string): TicketTab {
  return `agent:${subagentId}`;
}

/** "agent:toolu_01" → "toolu_01"; null for every other tab. */
export function parseSubagentTab(tab: string): string | null {
  return AGENT_TAB.exec(tab)?.[1] ?? null;
}

/** The tab strip entry a tab belongs to: a sub-agent's transcript sits under Agents. */
export function tabStripTab(tab: TicketTab): TicketTab {
  return parseSubagentTab(tab) ? "agents" : tab;
}

export function isTicketTab(t: string | undefined | null): t is TicketTab {
  return !!t && ((TICKET_TABS as string[]).includes(t) || PLUGIN_TAB.test(t) || AGENT_TAB.test(t));
}

/** Whether the tab strip shows Agents: only once the session has sub-agents to list. */
export function showsAgentsTab(subagents: { id: string }[] | null | undefined): boolean {
  return (subagents?.length ?? 0) > 0;
}

/**
 * The tab to show for a requested one: a plugin tab that doesn't apply (once the ticket's plugin
 * tabs are known) and the conductor-only Tickets tab on a plain ticket fall back to Summaries.
 * The Agents tab and a sub-agent's view need sub-agents: without any (or before they're known)
 * they fall back to Summaries, and a sub-agent that isn't among them falls back to the list.
 * The requested tab is kept by the caller, so a deep link opens once the sub-agents arrive.
 */
export function effectiveTab(
  requested: TicketTab,
  opts: { conductor: boolean; pluginTabs: { pluginId: string; id: string }[] | null; subagents?: { id: string }[] | null },
): TicketTab {
  if (requested === "children" && !opts.conductor) return "summaries";
  if (tabStripTab(requested) === "agents") {
    if (!showsAgentsTab(opts.subagents)) return "summaries";
    const agent = parseSubagentTab(requested);
    if (agent && !opts.subagents!.some((s) => s.id === agent)) return "agents";
  }
  const p = parsePluginTab(requested);
  if (p && opts.pluginTabs && !opts.pluginTabs.some((t) => t.pluginId === p.pluginId && t.id === p.tabId)) return "summaries";
  return requested;
}

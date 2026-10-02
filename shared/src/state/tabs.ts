// Ticket detail tabs, shared by every client: the built-in tabs, plugin tabs addressed as
// "plugin:<pluginId>:<tabId>" (DESIGN.md "Plugins") and one sub-agent's transcript as
// "agent:<subagentId>" (under the Agents tab, DESIGN.md "Sub-agents"). The desktop puts these in
// its hash route; the phone keeps them in navigation params.

/**
 * "children" is the conductor-only Tickets tab (listed right after Summaries). "agents" (Agents &
 * tasks) lists the session's sub-agents and background tasks; it exists only once there are any.
 */
export type BuiltinTicketTab = "summaries" | "children" | "transcript" | "agents" | "browser" | "details";
/** Built-in tabs, a plugin tab as "plugin:<pluginId>:<tabId>", or a sub-agent as "agent:<id>". */
export type TicketTab = BuiltinTicketTab | `plugin:${string}:${string}` | `agent:${string}`;
export const TICKET_TABS: BuiltinTicketTab[] = ["summaries", "children", "transcript", "agents", "browser", "details"];

export const TAB_LABEL: Record<BuiltinTicketTab, string> = {
  summaries: "Summaries",
  children: "Tickets",
  transcript: "Transcript",
  agents: "Agents & tasks",
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

/** The live dot's tooltip on the Agents & tasks tab. */
export const AGENTS_LIVE_LABEL = "A sub-agent or task is running";

/** Whether the tab strip shows Agents & tasks: only once the session has sub-agents or tasks to list. */
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

/**
 * The tab a ticket opens on when nothing asked for a particular one: Summaries once it has any,
 * otherwise the Transcript (a fresh ticket's Summaries tab is just an empty state). Null while the
 * summaries aren't loaded yet, so the caller waits instead of guessing.
 */
export function openingTab(summaries: readonly unknown[] | undefined): TicketTab | null {
  if (!summaries) return null;
  return summaries.length ? "summaries" : "transcript";
}

/**
 * The tab strip, in order: the built-in tabs this ticket shows (Tickets only on a conductor, Agents
 * only once there are sub-agents), then its plugin tabs. ⌘⇧[ / ⌘⇧] and 1–9 walk this list.
 */
export function visibleTabs(opts: { conductor: boolean; subagents?: { id: string }[] | null; pluginTabs?: { pluginId: string; id: string }[] | null }): TicketTab[] {
  const builtin = TICKET_TABS.filter((t) => (t !== "children" || opts.conductor) && (t !== "agents" || showsAgentsTab(opts.subagents)));
  return [...builtin, ...(opts.pluginTabs ?? []).map((p) => pluginTabRoute(p.pluginId, p.id))];
}

/**
 * The tab `delta` steps from `current` in `tabs`, wrapping at both ends (like Chrome's ⌘⇧]). A
 * sub-agent's view counts as the Agents tab; from a tab that isn't in the strip, forward goes to
 * the first tab and back to the last. Null when there are no tabs.
 */
export function nextTab(tabs: readonly TicketTab[], current: TicketTab, delta: number): TicketTab | null {
  if (!tabs.length) return null;
  const i = tabs.indexOf(tabStripTab(current));
  const from = i < 0 ? (delta > 0 ? -1 : 0) : i;
  const n = tabs.length;
  return tabs[(((from + delta) % n) + n) % n]!;
}

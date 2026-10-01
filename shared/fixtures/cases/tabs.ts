// Ticket detail tabs (shared/src/state/tabs.ts) for HarnessKit's Tabs.swift.
import {
  effectiveTab,
  isTicketTab,
  nextTab,
  openingTab,
  parsePluginTab,
  parseSubagentTab,
  pluginTabRoute,
  showsAgentsTab,
  subagentTabRoute,
  TAB_LABEL,
  TICKET_TABS,
  tabStripTab,
  type TicketTab,
  visibleTabs,
} from "../../src/state/tabs";
import { cases } from "../case";

export const ticketTabs = TICKET_TABS;
export const tabLabel = TAB_LABEL;

/** Strings every parser sees. */
const tabStrings: Record<string, string> = {
  summaries: "summaries",
  children: "children",
  transcript: "transcript",
  agents: "agents",
  browser: "browser",
  details: "details",
  "capitalized built-in": "Summaries",
  empty: "",
  plugin: "plugin:git:changes",
  "plugin with digits, dash and underscore": "plugin:a1_b-c:t_2-x",
  "plugin digit-led ids": "plugin:1:2",
  "plugin upper-case id": "plugin:Git:changes",
  "plugin dash-led id": "plugin:-git:changes",
  "plugin underscore-led tab": "plugin:git:_x",
  "plugin empty tab": "plugin:git:",
  "plugin empty plugin": "plugin::changes",
  "plugin three parts": "plugin:a:b:c",
  "plugin trailing newline": "plugin:git:changes\n",
  "plugin non-ASCII": "plugin:gït:changes",
  "plugin only prefix": "plugin:",
  agent: "agent:toolu_01ABC",
  "agent with dash": "agent:a-b",
  "agent empty id": "agent:",
  "agent with colon": "agent:a:b",
  "agent with dot": "agent:a.b",
  "agent 128 characters": `agent:${"a".repeat(128)}`,
  "agent 129 characters": `agent:${"a".repeat(129)}`,
  "agent trailing newline": "agent:x\n",
  "agent upper-case prefix": "Agent:x",
  "agent non-ASCII": "agent:é",
  "unknown tab": "files",
};

export const pluginTabRouteCases = cases(({ pluginId, tabId }: { pluginId: string; tabId: string }) => pluginTabRoute(pluginId, tabId), {
  plain: { pluginId: "git", tabId: "changes" },
  "not validated": { pluginId: "A B", tabId: ":" },
});

export const subagentTabRouteCases = cases(subagentTabRoute, { plain: "toolu_1", "not validated": "a b" });

export const parsePluginTabCases = cases(parsePluginTab, tabStrings);
export const parseSubagentTabCases = cases(parseSubagentTab, tabStrings);
export const tabStripTabCases = cases((t: string) => tabStripTab(t as TicketTab), tabStrings);
export const isTicketTabCases = cases(isTicketTab, { ...tabStrings, null: null });

export const showsAgentsTabCases = cases(showsAgentsTab, {
  null: null,
  empty: [],
  one: [{ id: "a" }],
});

export const openingTabCases = cases(openingTab, {
  "not loaded": null as unknown as undefined,
  "no summaries": [],
  "some summaries": [{ id: "s1" }],
});

type Opts = { conductor: boolean; pluginTabs: { pluginId: string; id: string }[] | null; subagents?: { id: string }[] | null };

const git = { pluginId: "git", id: "changes" };

export const effectiveTabCases = cases(({ requested, opts }: { requested: string; opts: Opts }) => effectiveTab(requested as TicketTab, opts), {
  "summaries stays": { requested: "summaries", opts: { conductor: false, pluginTabs: null } },
  "children on a plain ticket": { requested: "children", opts: { conductor: false, pluginTabs: null } },
  "children on a conductor": { requested: "children", opts: { conductor: true, pluginTabs: null } },
  "agents without sub-agents": { requested: "agents", opts: { conductor: false, pluginTabs: null } },
  "agents before sub-agents are known": { requested: "agents", opts: { conductor: false, pluginTabs: null, subagents: null } },
  "agents with empty sub-agents": { requested: "agents", opts: { conductor: false, pluginTabs: null, subagents: [] } },
  "agents with sub-agents": { requested: "agents", opts: { conductor: false, pluginTabs: null, subagents: [{ id: "a" }] } },
  "known sub-agent": { requested: "agent:a", opts: { conductor: false, pluginTabs: null, subagents: [{ id: "a" }] } },
  "unknown sub-agent falls back to the list": { requested: "agent:b", opts: { conductor: false, pluginTabs: null, subagents: [{ id: "a" }] } },
  "sub-agent without sub-agents": { requested: "agent:a", opts: { conductor: true, pluginTabs: null, subagents: [] } },
  "plugin tab before plugin tabs are known": { requested: "plugin:git:changes", opts: { conductor: false, pluginTabs: null } },
  "plugin tab that applies": { requested: "plugin:git:changes", opts: { conductor: false, pluginTabs: [git] } },
  "plugin tab that doesn't apply": { requested: "plugin:git:log", opts: { conductor: false, pluginTabs: [git] } },
  "plugin tab with no plugin tabs": { requested: "plugin:git:changes", opts: { conductor: false, pluginTabs: [] } },
  "plugin id must match too": { requested: "plugin:other:changes", opts: { conductor: false, pluginTabs: [git] } },
  "malformed plugin tab is kept": { requested: "plugin:Git:changes", opts: { conductor: false, pluginTabs: [git] } },
  "details stays": { requested: "details", opts: { conductor: true, pluginTabs: [], subagents: [] } },
});

export const visibleTabsCases = cases(visibleTabs, {
  "plain ticket": { conductor: false },
  "conductor with sub-agents and plugin tabs": {
    conductor: true,
    subagents: [{ id: "a" }],
    pluginTabs: [git, { pluginId: "x", id: "y" }],
  },
  "empty sub-agents hide Agents": { conductor: false, subagents: [] },
  "null sub-agents and plugin tabs": { conductor: false, subagents: null, pluginTabs: null },
  "conductor only": { conductor: true },
  "plugin tabs only": { conductor: false, pluginTabs: [git] },
});

const strip = ["summaries", "transcript", "details", "plugin:git:changes"];

export const nextTabCases = cases(({ tabs, current, delta }: { tabs: string[]; current: string; delta: number }) => nextTab(tabs as TicketTab[], current as TicketTab, delta), {
  forward: { tabs: strip, current: "transcript", delta: 1 },
  back: { tabs: strip, current: "transcript", delta: -1 },
  "wraps forward": { tabs: strip, current: "plugin:git:changes", delta: 1 },
  "wraps back": { tabs: strip, current: "summaries", delta: -1 },
  "sub-agent steps forward from Agents": { tabs: ["summaries", "agents", "details"], current: "agent:toolu_1", delta: 1 },
  "sub-agent steps back from Agents": { tabs: ["summaries", "agents", "details"], current: "agent:toolu_1", delta: -1 },
  "not in strip forward": { tabs: strip, current: "children", delta: 1 },
  "not in strip back": { tabs: strip, current: "children", delta: -1 },
  "not in strip two forward": { tabs: strip, current: "children", delta: 2 },
  "not in strip two back": { tabs: strip, current: "children", delta: -2 },
  "no tabs": { tabs: [], current: "summaries", delta: 1 },
  "zero delta": { tabs: strip, current: "details", delta: 0 },
  "zero delta not in strip": { tabs: strip, current: "children", delta: 0 },
  "big forward wraps around": { tabs: strip, current: "summaries", delta: 9 },
  "big back wraps around": { tabs: strip, current: "summaries", delta: -9 },
  "one tab": { tabs: ["details"], current: "details", delta: -1 },
  "duplicate tab uses the first": { tabs: ["a", "b", "a", "c"], current: "a", delta: 1 },
});

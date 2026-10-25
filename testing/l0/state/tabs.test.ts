import { describe, expect, test } from "bun:test";
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
  tabAfterSend,
  tabStripTab,
  ticketTabFrom,
  visibleTabs,
  type TicketTab,
} from "../../../shared/src/state/tabs";

describe("plugin and sub-agent tab ids", () => {
  test("a plugin tab round-trips through its route", () => {
    expect(parsePluginTab(pluginTabRoute("git", "changes"))).toEqual({ pluginId: "git", tabId: "changes" });
  });

  test("parsePluginTab rejects built-ins, uppercase, and a missing or extra segment", () => {
    expect(parsePluginTab("spec")).toBeNull();
    expect(parsePluginTab("plugin:Git:changes")).toBeNull();
    expect(parsePluginTab("plugin:git")).toBeNull();
    expect(parsePluginTab("plugin:git:a:b")).toBeNull();
    expect(parsePluginTab("plugin:-git:a")).toBeNull();
  });

  test("a sub-agent tab round-trips, and ids with other characters are rejected", () => {
    expect(parseSubagentTab(subagentTabRoute("toolu_01-x"))).toBe("toolu_01-x");
    expect(parseSubagentTab("agent:")).toBeNull();
    expect(parseSubagentTab("agent:a/b")).toBeNull();
    expect(parseSubagentTab("agent:" + "a".repeat(129))).toBeNull();
    expect(parseSubagentTab("agent:" + "a".repeat(128))).toBe("a".repeat(128));
    expect(parseSubagentTab("spec")).toBeNull();
  });

  test("a sub-agent's view sits under the Agents strip entry, other tabs under themselves", () => {
    expect(tabStripTab("agent:x")).toBe("agents");
    expect(tabStripTab("browser")).toBe("browser");
    expect(tabStripTab("plugin:a:b")).toBe("plugin:a:b");
  });
});

describe("isTicketTab / ticketTabFrom", () => {
  test("accepts built-ins, plugin tabs and agent tabs; rejects empties and unknowns", () => {
    expect(isTicketTab("details")).toBe(true);
    expect(isTicketTab("plugin:a:b")).toBe(true);
    expect(isTicketTab("agent:x")).toBe(true);
    expect(isTicketTab("changes")).toBe(false); // layered on by changesTab, not known here
    expect(isTicketTab("nope")).toBe(false);
    expect(isTicketTab("")).toBe(false);
    expect(isTicketTab(null)).toBe(false);
    expect(isTicketTab(undefined)).toBe(false);
  });

  test("a renamed tab id maps to its new tab", () => {
    expect(ticketTabFrom("summaries")).toBe("spec");
  });

  test("a prototype key is not treated as a rename", () => {
    expect(ticketTabFrom("constructor")).toBeNull();
    expect(ticketTabFrom("toString")).toBeNull();
  });

  test("valid ids pass through; invalid and empty give null", () => {
    expect(ticketTabFrom("transcript")).toBe("transcript");
    expect(ticketTabFrom("bogus")).toBeNull();
    expect(ticketTabFrom(null)).toBeNull();
    expect(ticketTabFrom("")).toBeNull();
  });
});

describe("tabAfterSend", () => {
  test("a sent message goes to the transcript; a failed send stays on the current tab", () => {
    expect(tabAfterSend("spec", true)).toBe("transcript");
    expect(tabAfterSend("spec", false)).toBe("spec");
  });
});

describe("showsAgentsTab", () => {
  test("only with at least one sub-agent", () => {
    expect(showsAgentsTab(null)).toBe(false);
    expect(showsAgentsTab(undefined)).toBe(false);
    expect(showsAgentsTab([])).toBe(false);
    expect(showsAgentsTab([{ id: "a" }])).toBe(true);
  });
});

describe("effectiveTab", () => {
  const plain = { conductor: false, pluginTabs: null, subagents: null };

  test("Tickets falls back to Spec on a plain ticket, stays on a conductor", () => {
    expect(effectiveTab("children", plain)).toBe("spec");
    expect(effectiveTab("children", { ...plain, conductor: true })).toBe("children");
  });

  test("Agents falls back to Spec without sub-agents, including while unknown", () => {
    expect(effectiveTab("agents", plain)).toBe("spec");
    expect(effectiveTab("agents", { ...plain, subagents: [] })).toBe("spec");
    expect(effectiveTab("agents", { ...plain, subagents: [{ id: "a" }] })).toBe("agents");
  });

  test("a sub-agent view falls back to Spec without agents, to the list when that agent is gone, else stays", () => {
    expect(effectiveTab("agent:a", plain)).toBe("spec");
    expect(effectiveTab("agent:zz", { ...plain, subagents: [{ id: "a" }] })).toBe("agents");
    expect(effectiveTab("agent:a", { ...plain, subagents: [{ id: "a" }] })).toBe("agent:a");
  });

  test("a plugin tab stays while plugin tabs are unknown, stays when listed, falls back to Spec when absent", () => {
    expect(effectiveTab("plugin:g:c", plain)).toBe("plugin:g:c");
    expect(effectiveTab("plugin:g:c", { ...plain, pluginTabs: [{ pluginId: "g", id: "c" }] })).toBe("plugin:g:c");
    expect(effectiveTab("plugin:g:c", { ...plain, pluginTabs: [{ pluginId: "g", id: "other" }] })).toBe("spec");
    expect(effectiveTab("plugin:g:c", { ...plain, pluginTabs: [] })).toBe("spec");
  });

  test("a plugin tab needs both ids to match", () => {
    expect(effectiveTab("plugin:g:c", { ...plain, pluginTabs: [{ pluginId: "x", id: "c" }] })).toBe("spec");
  });

  test("Events needs events: without any it falls back to Spec, with some it stays", () => {
    expect(effectiveTab("events", plain)).toBe("spec");
    expect(effectiveTab("events", { ...plain, events: false })).toBe("spec");
    expect(effectiveTab("events", { ...plain, events: true })).toBe("events");
  });

  test("built-in tabs pass through", () => {
    expect(effectiveTab("browser", plain)).toBe("browser");
  });
});

describe("openingTab / visibleTabs", () => {
  test("a ticket opens on the Spec", () => {
    expect(openingTab()).toBe("spec");
  });

  test("a plain ticket's strip omits Tickets and Agents", () => {
    expect(visibleTabs({ conductor: false })).toEqual(["spec", "activity", "transcript", "browser", "details"]);
  });

  test("a conductor with sub-agents gets Tickets and Agents in place", () => {
    expect(visibleTabs({ conductor: true, subagents: [{ id: "a" }] })).toEqual(["spec", "activity", "children", "transcript", "agents", "browser", "details"]);
  });

  test("Events sits after Agents, only once the ticket has events", () => {
    expect(visibleTabs({ conductor: false, events: true })).toEqual(["spec", "activity", "transcript", "events", "browser", "details"]);
    expect(visibleTabs({ conductor: true, subagents: [{ id: "a" }], events: true })).toEqual(["spec", "activity", "children", "transcript", "agents", "events", "browser", "details"]);
    expect(visibleTabs({ conductor: false, events: false })).not.toContain("events");
  });

  test("a saved Events route is still a ticket tab, so it reopens once events arrive", () => {
    expect(ticketTabFrom("events")).toBe("events");
  });

  test("plugin tabs follow the built-ins as routes", () => {
    const tabs = visibleTabs({ conductor: false, pluginTabs: [{ pluginId: "g", id: "c" }] });
    expect(tabs.at(-1)).toBe("plugin:g:c");
    expect(tabs.at(-2)).toBe("details");
  });
});

describe("nextTab", () => {
  const tabs: TicketTab[] = ["spec", "activity", "agents", "details"];

  test("null with no tabs", () => {
    expect(nextTab([], "spec", 1)).toBeNull();
  });

  test("wraps forward past the end and backward past the start", () => {
    expect(nextTab(tabs, "details", 1)).toBe("spec");
    expect(nextTab(tabs, "spec", -1)).toBe("details");
  });

  test("steps larger than the strip still land in range, in both directions", () => {
    expect(nextTab(tabs, "spec", 5)).toBe("activity");
    expect(nextTab(tabs, "spec", -5)).toBe("details");
  });

  test("a sub-agent's view moves from the Agents position", () => {
    expect(nextTab(tabs, "agent:x", 1)).toBe("details");
    expect(nextTab(tabs, "agent:x", -1)).toBe("activity");
  });

  test("from a tab outside the strip, forward is the first tab and back the last", () => {
    expect(nextTab(tabs, "browser", 1)).toBe("spec");
    expect(nextTab(tabs, "browser", -1)).toBe("details");
  });
});

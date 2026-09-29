import { describe, expect, test } from "bun:test";
import { nextTab, openingTab, visibleTabs, type TicketTab } from "./tabs";

describe("openingTab", () => {
  test("waits until the summaries are loaded", () => {
    expect(openingTab(undefined)).toBeNull();
  });
  test("opens on the Transcript when there are no summaries, Summaries once there are", () => {
    expect(openingTab([])).toBe("transcript");
    expect(openingTab([{ id: "s1" }])).toBe("summaries");
  });
});

describe("visibleTabs", () => {
  test("a plain ticket has no Tickets or Agents tab", () => {
    expect(visibleTabs({ conductor: false })).toEqual(["summaries", "transcript", "browser", "details"]);
  });
  test("a conductor with sub-agents shows both, and plugin tabs come last in their order", () => {
    const tabs = visibleTabs({ conductor: true, subagents: [{ id: "a" }], pluginTabs: [{ pluginId: "git", id: "changes" }, { pluginId: "x", id: "y" }] });
    expect(tabs).toEqual(["summaries", "children", "transcript", "agents", "browser", "details", "plugin:git:changes", "plugin:x:y"]);
  });
  test("an empty sub-agent list hides Agents", () => {
    expect(visibleTabs({ conductor: false, subagents: [] })).not.toContain("agents");
  });
});

describe("nextTab", () => {
  const tabs: TicketTab[] = ["summaries", "transcript", "details", "plugin:git:changes"];
  test("steps forward and back", () => {
    expect(nextTab(tabs, "transcript", 1)).toBe("details");
    expect(nextTab(tabs, "transcript", -1)).toBe("summaries");
  });
  test("wraps at both ends", () => {
    expect(nextTab(tabs, "plugin:git:changes", 1)).toBe("summaries");
    expect(nextTab(tabs, "summaries", -1)).toBe("plugin:git:changes");
  });
  test("a sub-agent's view steps from the Agents tab", () => {
    expect(nextTab(["summaries", "agents", "details"], "agent:toolu_1", 1)).toBe("details");
    expect(nextTab(["summaries", "agents", "details"], "agent:toolu_1", -1)).toBe("summaries");
  });
  test("from a tab not in the strip, forward lands on the first and back on the last", () => {
    expect(nextTab(tabs, "children", 1)).toBe("summaries");
    expect(nextTab(tabs, "children", -1)).toBe("plugin:git:changes");
  });
  test("no tabs, no step", () => {
    expect(nextTab([], "summaries", 1)).toBeNull();
  });
});

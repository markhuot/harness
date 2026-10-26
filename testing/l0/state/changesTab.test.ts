import { describe, expect, test } from "bun:test";
import {
  CHANGES_PLUGIN_ROUTE,
  effectiveTabWithChanges,
  isPluginChanges,
  normalizeChangesTab,
  otherPluginTabs,
  showsChangesTab,
  ticketTabWithChanges,
  visibleTabsWithChanges,
} from "../../../shared/src/state/changesTab";

const gitChanges = { pluginId: "git", id: "changes" };
const other = { pluginId: "git", id: "log" };

describe("normalizeChangesTab / ticketTabWithChanges", () => {
  test("the git plugin's route becomes the built-in tab; others are untouched", () => {
    expect(normalizeChangesTab(CHANGES_PLUGIN_ROUTE)).toBe("changes");
    expect(normalizeChangesTab("plugin:git:log")).toBe("plugin:git:log");
    expect(normalizeChangesTab("spec")).toBe("spec");
  });

  test("accepts changes, normalizes the plugin route, keeps ordinary and renamed ids, rejects junk", () => {
    expect(ticketTabWithChanges("changes")).toBe("changes");
    expect(ticketTabWithChanges("plugin:git:changes")).toBe("changes");
    expect(ticketTabWithChanges("details")).toBe("details");
    expect(ticketTabWithChanges("summaries")).toBe("spec");
    expect(ticketTabWithChanges("junk")).toBeNull();
    expect(ticketTabWithChanges(null)).toBeNull();
  });
});

describe("isPluginChanges / otherPluginTabs", () => {
  test("needs both the plugin and the tab id", () => {
    expect(isPluginChanges(gitChanges)).toBe(true);
    expect(isPluginChanges({ pluginId: "git", id: "log" })).toBe(false);
    expect(isPluginChanges({ pluginId: "svn", id: "changes" })).toBe(false);
  });

  test("filters git:changes out, keeps null as null, and empty as empty", () => {
    expect(otherPluginTabs([gitChanges, other])).toEqual([other]);
    expect(otherPluginTabs(null)).toBeNull();
    expect(otherPluginTabs(undefined)).toBeNull();
    expect(otherPluginTabs([])).toEqual([]);
  });
});

describe("showsChangesTab", () => {
  test("before plugin tabs load, a workdir is the guess", () => {
    expect(showsChangesTab("/w", null)).toBe(true);
    expect(showsChangesTab(null, null)).toBe(false);
    expect(showsChangesTab("", undefined)).toBe(false);
  });

  test("once loaded the service decides, whatever the workdir", () => {
    expect(showsChangesTab(null, [gitChanges])).toBe(true);
    expect(showsChangesTab("/w", [other])).toBe(false);
    expect(showsChangesTab("/w", [])).toBe(false);
  });
});

describe("effectiveTabWithChanges", () => {
  const base = { conductor: false, workdir: null, pluginTabs: null };

  test("Changes stays while the plugin tabs are unknown, even with no workdir", () => {
    expect(effectiveTabWithChanges("changes", base)).toBe("changes");
  });

  test("Changes falls back to Spec once the plugin tabs say it doesn't apply", () => {
    expect(effectiveTabWithChanges("changes", { ...base, workdir: "/w", pluginTabs: [] })).toBe("spec");
    expect(effectiveTabWithChanges("changes", { ...base, pluginTabs: [gitChanges] })).toBe("changes");
  });

  test("an old plugin:git:changes link resolves like Changes", () => {
    expect(effectiveTabWithChanges("plugin:git:changes", { ...base, pluginTabs: [] })).toBe("spec");
    expect(effectiveTabWithChanges("plugin:git:changes", { ...base, pluginTabs: [gitChanges] })).toBe("changes");
  });

  test("other tabs defer to effectiveTab with git:changes hidden from the plugin list", () => {
    expect(effectiveTabWithChanges("children", base)).toBe("spec");
    expect(effectiveTabWithChanges("plugin:git:log", { ...base, pluginTabs: [gitChanges] })).toBe("spec");
    expect(effectiveTabWithChanges("plugin:git:log", { ...base, pluginTabs: [other] })).toBe("plugin:git:log");
  });
});

describe("visibleTabsWithChanges", () => {
  const base = { conductor: false, workdir: "/w" };

  test("Changes sits right before Details", () => {
    expect(visibleTabsWithChanges({ ...base, pluginTabs: null })).toEqual(["spec", "activity", "transcript", "browser", "changes", "details"]);
  });

  test("no Changes tab without a workdir (plugins not loaded) or when plugins omit it", () => {
    expect(visibleTabsWithChanges({ conductor: false, workdir: null })).not.toContain("changes");
    expect(visibleTabsWithChanges({ ...base, pluginTabs: [other] })).not.toContain("changes");
  });

  test("git:changes isn't listed twice as a plugin tab; other plugin tabs stay at the end", () => {
    const tabs = visibleTabsWithChanges({ ...base, pluginTabs: [gitChanges, other] });
    expect(tabs).not.toContain("plugin:git:changes");
    expect(tabs.filter((t) => t === "changes")).toHaveLength(1);
    expect(tabs.at(-1)).toBe("plugin:git:log");
  });
});

describe("Events through the Changes layer", () => {
  const base = { conductor: false, workdir: null, pluginTabs: [] as { pluginId: string; id: string }[] };
  test("the hasEvents flag reaches both the strip and the fallback", () => {
    expect(visibleTabsWithChanges({ ...base, events: true })).toContain("events");
    expect(visibleTabsWithChanges(base)).not.toContain("events");
    expect(effectiveTabWithChanges("events", { ...base, events: true })).toBe("events");
    expect(effectiveTabWithChanges("events", base)).toBe("spec");
  });
});

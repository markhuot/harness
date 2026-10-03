import { describe, expect, test } from "bun:test";
import { changesTabIcon, effectiveTabWithChanges, otherPluginTabs, showsChangesTab, ticketTabWithChanges, visibleTabsWithChanges } from "./changesTab";
import { changesEmptyState, changesNotices, effectiveStyle, fileDecoration, relTime } from "./changes";

const git = { pluginId: "git", id: "changes" };
const other = { pluginId: "notes", id: "notes" };

describe("ticketTabWithChanges", () => {
  test("takes the built-in tab and maps the plugin's route to it", () => {
    expect(ticketTabWithChanges("changes")).toBe("changes");
    expect(ticketTabWithChanges("plugin:git:changes")).toBe("changes");
  });
  test("leaves every other tab to ticketTabFrom", () => {
    expect(ticketTabWithChanges("summaries")).toBe("spec");
    expect(ticketTabWithChanges("plugin:git:log")).toBe("plugin:git:log");
    expect(ticketTabWithChanges("plugin:other:changes")).toBe("plugin:other:changes");
    expect(ticketTabWithChanges("Changes")).toBeNull();
    expect(ticketTabWithChanges(null)).toBeNull();
  });
});

describe("showsChangesTab", () => {
  test("guesses from the workdir until the plugin tabs load", () => {
    expect(showsChangesTab("/w", null)).toBe(true);
    expect(showsChangesTab(null, null)).toBe(false);
  });
  test("then follows the service, which also keeps a pinned diff after the worktree is gone", () => {
    expect(showsChangesTab(null, [git])).toBe(true);
    expect(showsChangesTab("/w", [other])).toBe(false);
    expect(showsChangesTab("/w", [])).toBe(false);
  });
});

test("otherPluginTabs drops only git:changes and keeps null as not loaded", () => {
  expect(otherPluginTabs([git, other, { pluginId: "git", id: "log" }])).toEqual([other, { pluginId: "git", id: "log" }]);
  expect(otherPluginTabs(null)).toBeNull();
});

describe("visibleTabsWithChanges", () => {
  test("puts Changes after Browser, ahead of Details, and not again among the plugin tabs", () => {
    expect(visibleTabsWithChanges({ conductor: false, workdir: "/w", pluginTabs: [git, other] })).toEqual(["spec", "activity", "transcript", "browser", "changes", "details", "plugin:notes:notes"]);
  });
  test("leaves it out when the service doesn't offer it", () => {
    expect(visibleTabsWithChanges({ conductor: false, workdir: "/w", pluginTabs: [other] })).not.toContain("changes");
    expect(visibleTabsWithChanges({ conductor: false, workdir: null })).not.toContain("changes");
  });
});

describe("effectiveTabWithChanges", () => {
  const opts = { conductor: false, workdir: "/w" as string | null, subagents: null };
  test("shows Changes, from either id, while the plugin tabs load or once they list it", () => {
    expect(effectiveTabWithChanges("changes", { ...opts, pluginTabs: null })).toBe("changes");
    expect(effectiveTabWithChanges("plugin:git:changes", { ...opts, pluginTabs: [git] })).toBe("changes");
    expect(effectiveTabWithChanges("changes", { ...opts, workdir: null, pluginTabs: [git] })).toBe("changes");
  });
  test("falls back to the Spec once the service says there's no diff", () => {
    expect(effectiveTabWithChanges("changes", { ...opts, pluginTabs: [] })).toBe("spec");
    expect(effectiveTabWithChanges("plugin:git:changes", { ...opts, pluginTabs: [other] })).toBe("spec");
  });
  test("hands other tabs to effectiveTab", () => {
    expect(effectiveTabWithChanges("plugin:notes:notes", { ...opts, pluginTabs: [git, other] })).toBe("plugin:notes:notes");
    expect(effectiveTabWithChanges("plugin:notes:notes", { ...opts, pluginTabs: [git] })).toBe("spec");
    expect(effectiveTabWithChanges("children", { ...opts, pluginTabs: [git] })).toBe("spec");
  });
});

test("changesTabIcon uses the service's icon, else the plugin's default", () => {
  expect(changesTabIcon([{ ...git, icon: "fileText" }])).toBe("fileText");
  expect(changesTabIcon([{ ...git, icon: "" }])).toBe("branch");
  expect(changesTabIcon(null)).toBe("branch");
});

test("fileDecoration: counts for text files, a kind for binaries and pure renames", () => {
  const f = { path: "a", status: "modified" as const, additions: 3, deletions: 1, binary: false };
  expect(fileDecoration(f)?.parts).toEqual([{ text: "+3", tone: "add" }, { text: " " }, { text: "−1", tone: "del" }]);
  expect(fileDecoration({ ...f, binary: true })?.text).toBe("bin");
  expect(fileDecoration({ ...f, status: "renamed", additions: 0, deletions: 0, oldPath: "b" })).toEqual({ text: "moved", title: "Renamed from b" });
  expect(fileDecoration({ ...f, status: "renamed", additions: 0, deletions: 0 })).toBeNull();
  // A rename with edits shows its counts like any other change.
  expect(fileDecoration({ ...f, status: "renamed", oldPath: "b" })?.text).toBe("+3 −1");
});

test("changesEmptyState says why there's nothing, per mode", () => {
  expect(changesEmptyState({ mode: "branch", branch: "harness/x", base: "main" }).detail).toStartWith("harness/x matches main");
  expect(changesEmptyState({ mode: "branch", branch: null, base: null }).detail).toStartWith("This branch matches its base");
  expect(changesEmptyState({ mode: "pinned", branch: "b", base: "main" }).title).toBe("No changes");
  expect(changesEmptyState({ mode: "workdir", branch: "b", base: "HEAD" }).detail).toStartWith("The working tree is clean");
});

test("changesNotices: a truncated diff, and a failed refresh only while older data is on screen", () => {
  const c = { truncated: true, files: [{}, {}] as never[] };
  expect(changesNotices(c, null)).toEqual(["This diff is large, so only the first part is shown. 2 files changed in total."]);
  expect(changesNotices({ ...c, truncated: false }, "boom")).toEqual(["Refresh failed: boom"]);
  expect(changesNotices(null, "boom")).toEqual([]);
});

test("effectiveStyle: the chosen style wins, else split from 1000 px", () => {
  expect(effectiveStyle(null, 999)).toBe("unified");
  expect(effectiveStyle(null, 1000)).toBe("split");
  expect(effectiveStyle("unified", 2000)).toBe("unified");
  expect(effectiveStyle("split", 300)).toBe("split");
});

test("relTime rounds into the largest unit", () => {
  const now = 1_000_000_000;
  expect(relTime(now - 59_000, now)).toBe("just now");
  expect(relTime(now - 90_000, now)).toBe("2m ago");
  expect(relTime(now - 3 * 3600_000, now)).toBe("3h ago");
  expect(relTime(now - 50 * 3600_000, now)).toBe("2d ago");
});

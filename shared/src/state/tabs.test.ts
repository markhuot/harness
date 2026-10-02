import { describe, expect, test } from "bun:test";
import { effectiveTab, isTicketTab, logsMessages, nextTab, openingTab, TICKET_TABS, ticketTabFrom, visibleTabs, type TicketTab } from "./tabs";

describe("openingTab", () => {
  test("every ticket opens on its Spec", () => {
    expect(openingTab()).toBe("spec");
  });
});

describe("ticketTabFrom", () => {
  test("an old Summaries link opens the Spec, the default view that replaced it, even though summaries is no longer a tab", () => {
    expect(isTicketTab("summaries")).toBe(false);
    expect(ticketTabFrom("summaries")).toBe("spec");
  });
  test("current tab ids pass through unchanged", () => {
    for (const t of [...TICKET_TABS, "plugin:git:changes", "agent:toolu_1"] as TicketTab[]) expect(ticketTabFrom(t)).toBe(t);
  });
  test("anything else is null, renamed ids are matched exactly", () => {
    for (const t of [null, undefined, "", "files", "Summaries", "summaries ", "plugin:Git:changes", "agent:"]) expect(ticketTabFrom(t)).toBeNull();
  });
  // RENAMED_TABS is a plain object, so RENAMED_TABS["constructor"] is Object and ticketTabFrom
  // returns a function for a route like #/T-1/constructor. Needs Object.hasOwn in tabs.ts.
  test("Object.prototype keys aren't renamed tabs", () => {
    for (const t of ["constructor", "toString", "__proto__", "hasOwnProperty"]) expect(ticketTabFrom(t)).toBeNull();
  });
});

describe("logsMessages", () => {
  test("only the Spec and Activity tabs log a message into Activity", () => {
    const logging = ([...TICKET_TABS, "plugin:git:changes", "agent:a"] as TicketTab[]).filter(logsMessages);
    expect(logging).toEqual(["spec", "activity"]);
  });
});

describe("effectiveTab", () => {
  const plain = { conductor: false, pluginTabs: [{ pluginId: "git", id: "changes" }], subagents: [] };
  test("Spec and Activity are always shown as asked", () => {
    expect(effectiveTab("spec", plain)).toBe("spec");
    expect(effectiveTab("activity", plain)).toBe("activity");
  });
  test("tabs that don't apply fall back to the Spec", () => {
    expect(effectiveTab("children", plain)).toBe("spec");
    expect(effectiveTab("agents", plain)).toBe("spec");
    expect(effectiveTab("agent:a", plain)).toBe("spec");
    expect(effectiveTab("plugin:git:log", plain)).toBe("spec");
  });
});

describe("visibleTabs", () => {
  test("a plain ticket has no Tickets or Agents tab", () => {
    expect(visibleTabs({ conductor: false })).toEqual(["spec", "activity", "transcript", "browser", "details"]);
  });
  test("a conductor with sub-agents shows both, and plugin tabs come last in their order", () => {
    const tabs = visibleTabs({ conductor: true, subagents: [{ id: "a" }], pluginTabs: [{ pluginId: "git", id: "changes" }, { pluginId: "x", id: "y" }] });
    expect(tabs).toEqual(["spec", "activity", "children", "transcript", "agents", "browser", "details", "plugin:git:changes", "plugin:x:y"]);
  });
  test("an empty sub-agent list hides Agents", () => {
    expect(visibleTabs({ conductor: false, subagents: [] })).not.toContain("agents");
  });
});

describe("nextTab", () => {
  const tabs: TicketTab[] = ["activity", "transcript", "details", "plugin:git:changes"];
  test("steps forward and back", () => {
    expect(nextTab(tabs, "transcript", 1)).toBe("details");
    expect(nextTab(tabs, "transcript", -1)).toBe("activity");
  });
  test("wraps at both ends", () => {
    expect(nextTab(tabs, "plugin:git:changes", 1)).toBe("activity");
    expect(nextTab(tabs, "activity", -1)).toBe("plugin:git:changes");
  });
  test("a sub-agent's view steps from the Agents tab", () => {
    expect(nextTab(["spec", "agents", "details"], "agent:toolu_1", 1)).toBe("details");
    expect(nextTab(["spec", "agents", "details"], "agent:toolu_1", -1)).toBe("spec");
  });
  test("from a tab not in the strip, forward lands on the first and back on the last", () => {
    expect(nextTab(tabs, "children", 1)).toBe("activity");
    expect(nextTab(tabs, "children", -1)).toBe("plugin:git:changes");
  });
  test("no tabs, no step", () => {
    expect(nextTab([], "spec", 1)).toBeNull();
  });
});

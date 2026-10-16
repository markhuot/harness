import { describe, expect, test } from "bun:test";
import type { PluginTab } from "@harness/shared";
import { tornTabName } from "../../../app/src/renderer/state/tornTabName";

const plugin = (pluginId: string, id: string, title: string) => ({ pluginId, id, title }) as unknown as PluginTab;
const plugins = [plugin("git", "blame", "Blame"), plugin("lint", "blame", "Lint blame")];

describe("tornTabName", () => {
  test("the composer is the Message box", () => {
    expect(tornTabName("composer", plugins)).toBe("Message box");
  });
  test("the built-in Changes tab, and built-in tabs by label", () => {
    expect(tornTabName("changes", null)).toBe("Changes");
    expect(tornTabName("spec", null)).toBe("Spec");
    expect(tornTabName("children", undefined)).toBe("Tickets");
  });
  test("a sub-agent's tab is named for the Agents tab it sits under", () => {
    expect(tornTabName("agent:toolu_01", null)).toBe("Agents & tasks");
  });
  test("a plugin tab takes its title, matching on both plugin and tab id", () => {
    expect(tornTabName("plugin:git:blame", plugins)).toBe("Blame");
    expect(tornTabName("plugin:lint:blame", plugins)).toBe("Lint blame");
  });
  test("a plugin tab that isn't loaded (no list, or no match) falls back to its tab id", () => {
    expect(tornTabName("plugin:git:blame", null)).toBe("blame");
    expect(tornTabName("plugin:git:blame", undefined)).toBe("blame");
    expect(tornTabName("plugin:other:blame", plugins)).toBe("blame");
    expect(tornTabName("plugin:git:log", plugins)).toBe("log");
  });
  test("the old git:changes plugin route is still a plugin tab here (callers normalize it first)", () => {
    expect(tornTabName("plugin:git:changes", [])).toBe("changes");
  });
});

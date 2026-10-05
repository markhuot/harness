import { describe, expect, test } from "bun:test";
import { canonicalGroup, normalizeProjectGroup, PROJECT_GROUP_MAX, projectGroups } from "./projectGroups";

describe("project groups", () => {
  test("names are trimmed with inner whitespace collapsed; blank is no group; junk and overlong names are refused", () => {
    expect(normalizeProjectGroup("  Day \t  job ")).toBe("Day job");
    expect(normalizeProjectGroup("   ")).toBeNull();
    expect(normalizeProjectGroup(null)).toBeNull();
    expect(normalizeProjectGroup(7)).toBeUndefined();
    expect(normalizeProjectGroup("x".repeat(PROJECT_GROUP_MAX))).toHaveLength(PROJECT_GROUP_MAX);
    expect(normalizeProjectGroup("x".repeat(PROJECT_GROUP_MAX + 1))).toBeUndefined();
  });

  test("a name matching an existing group without case takes its spelling; accents still differ", () => {
    expect(canonicalGroup("work", ["Personal", "Work"])).toBe("Work");
    expect(canonicalGroup("Cafe", ["Café"])).toBe("Cafe");
    expect(canonicalGroup("Side", ["Work"])).toBe("Side");
  });

  test("the groups projects carry, once each, alphabetically without case", () => {
    const projects = [{ group: "work" }, { group: null }, { group: "Personal" }, {}, { group: "work" }, { group: "Archive" }];
    expect(projectGroups(projects)).toEqual(["Archive", "Personal", "work"]);
    expect(projectGroups([])).toEqual([]);
  });
});

import { describe, expect, test } from "bun:test";
import { PROJECT_GROUP_MAX, canonicalGroup, normalizeProjectGroup, projectGroups, sameGroup } from "../../../shared/src/projectGroups";

describe("normalizeProjectGroup", () => {
  test("null, undefined, empty and blank all mean no group", () => {
    for (const v of [null, undefined, "", "   ", "\t\n"]) expect(normalizeProjectGroup(v)).toBeNull();
  });
  test("trims and collapses inner whitespace runs", () => {
    expect(normalizeProjectGroup("  My   \t Group ")).toBe("My Group");
  });
  test("a non-string is invalid (undefined), including 0 and false", () => {
    for (const v of [5, 0, false, {}, []]) expect(normalizeProjectGroup(v)).toBeUndefined();
  });
  test("the length limit applies after normalizing, and is inclusive", () => {
    expect(normalizeProjectGroup("a".repeat(PROJECT_GROUP_MAX))).toBe("a".repeat(PROJECT_GROUP_MAX));
    expect(normalizeProjectGroup("a".repeat(PROJECT_GROUP_MAX + 1))).toBeUndefined();
    expect(normalizeProjectGroup(`  ${"a".repeat(PROJECT_GROUP_MAX)}  `)).toBe("a".repeat(PROJECT_GROUP_MAX));
    expect(normalizeProjectGroup(`${"a ".repeat(PROJECT_GROUP_MAX)}`)).toBeUndefined();
  });
});

describe("sameGroup / canonicalGroup", () => {
  test("case differences match, accent differences do not", () => {
    expect(sameGroup("work", "WORK")).toBe(true);
    expect(sameGroup("cafe", "café")).toBe(false);
    expect(sameGroup("a", "b")).toBe(false);
  });
  test("a typed name adopts an existing group's spelling, first match winning", () => {
    expect(canonicalGroup("work", ["Personal", "Work", "WORK"])).toBe("Work");
  });
  test("no match keeps the name as typed", () => {
    expect(canonicalGroup("work", ["Personal"])).toBe("work");
    expect(canonicalGroup("work", [])).toBe("work");
  });
});

describe("projectGroups", () => {
  test("each group once, alphabetical regardless of case, skipping none/empty", () => {
    const projects = [{ group: "work" }, { group: null }, { group: "Alpha" }, {}, { group: "work" }, { group: "" }, { group: "beta" }];
    expect(projectGroups(projects)).toEqual(["Alpha", "beta", "work"]);
  });
  test("names equal ignoring case are both kept (exact-match dedupe) with a stable order", () => {
    expect(projectGroups([{ group: "work" }, { group: "Work" }])).toEqual(["Work", "work"]);
    expect(projectGroups([{ group: "Work" }, { group: "work" }])).toEqual(["Work", "work"]);
  });
  test("accepts any iterable", () => {
    expect(projectGroups(new Set([{ group: "b" }, { group: "a" }]))).toEqual(["a", "b"]);
  });
});

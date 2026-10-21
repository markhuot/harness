import { describe, expect, test } from "bun:test";
import { groupRowIds, groupRowPick, groupRows } from "../../../shared/src/state/groups";
import { PROJECT_GROUP_MAX, canonicalGroup, groupNameOf, normalizeProjectGroup, projectGroups, resolveGroupKey, sameGroup } from "../../../shared/src/projectGroups";

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
  const p = (groupId: string | null, group: string | null) => ({ groupId, group });
  test("each group once by id, alphabetical regardless of case, skipping none", () => {
    const projects = [p("1", "work"), p(null, null), p("2", "Alpha"), {}, p("1", "work"), p("3", "beta")];
    expect(projectGroups(projects)).toEqual([
      { id: "2", name: "Alpha" },
      { id: "3", name: "beta" },
      { id: "1", name: "work" },
    ]);
  });
  test("two groups whose names differ only in case stay two, in a stable order", () => {
    expect(projectGroups([p("1", "work"), p("2", "Work")]).map((g) => g.id)).toEqual(["2", "1"]);
    expect(projectGroups([p("2", "Work"), p("1", "work")]).map((g) => g.id)).toEqual(["2", "1"]);
  });
  test("a renamed group is one group under its new name", () => {
    expect(projectGroups([p("1", "Clients"), p("1", "Clients")])).toEqual([{ id: "1", name: "Clients" }]);
  });
  test("accepts any iterable", () => {
    expect(projectGroups(new Set([p("2", "b"), p("1", "a")])).map((g) => g.name)).toEqual(["a", "b"]);
  });
});

describe("resolveGroupKey / groupNameOf", () => {
  const groups = [
    { id: "g-1", name: "Work" },
    { id: "g-2", name: "Play" },
  ];
  test("an id is itself", () => {
    expect(resolveGroupKey("g-2", groups)).toBe("g-2");
  });
  test("a name saved before groups had ids finds its group in any case", () => {
    expect(resolveGroupKey("work", groups)).toBe("g-1");
    expect(resolveGroupKey("PLAY", groups)).toBe("g-2");
  });
  test("an id wins over a group named like it", () => {
    expect(resolveGroupKey("g-1", [...groups, { id: "g-3", name: "g-1" }])).toBe("g-1");
  });
  test("an unknown key is null", () => {
    expect(resolveGroupKey("nope", groups)).toBeNull();
  });
  test("groupNameOf reads the name from a project in the group", () => {
    expect(groupNameOf([{ groupId: "g-1", group: "Work" }], "g-1")).toBe("Work");
    expect(groupNameOf([{ groupId: "g-1", group: "Work" }], "g-2")).toBeNull();
  });
});

describe("groupRows", () => {
  const groups = [
    { id: "g-1", name: "Client Work" },
    { id: "g-2", name: "Personal" },
  ];
  test("nothing typed: No group, then every group by id", () => {
    expect(groupRows(groups, "")).toEqual([
      { kind: "none", value: null, label: "No group" },
      { kind: "group", value: "g-1", label: "Client Work" },
      { kind: "group", value: "g-2", label: "Personal" },
    ]);
  });
  test("a name typed in another case picks the group, with no row for a new one", () => {
    const rows = groupRows(groups, "client work");
    expect(rows.map((r) => r.kind)).toEqual(["group"]);
    expect(groupRowPick(rows[0]!)).toEqual({ groupId: "g-1" });
  });
  test("a name no group has is offered as new and picks by name", () => {
    const rows = groupRows(groups, "Ideas");
    expect(rows.at(-1)).toEqual({ kind: "new", value: "Ideas", label: 'New group "Ideas"' });
    expect(groupRowPick(rows.at(-1)!)).toEqual({ group: "Ideas" });
  });
  test("No group picks null, a name too long is refused", () => {
    expect(groupRowPick(groupRows(groups, "")[0]!)).toEqual({ groupId: null });
    const long = groupRows(groups, "x".repeat(PROJECT_GROUP_MAX + 1));
    expect(long.at(-1)!.kind).toBe("invalid");
    expect(groupRowPick(long.at(-1)!)).toBeUndefined();
  });
  test("row ids keep a new name apart from a group id and skip invalid rows", () => {
    const rows = groupRows([{ id: "Ideas", name: "Other" }], "Ideas");
    expect(groupRowIds(rows)).toEqual(["new:Ideas"]);
    expect(groupRowIds(groupRows(groups, ""))).toEqual(["", "g-1", "g-2"]);
  });
});

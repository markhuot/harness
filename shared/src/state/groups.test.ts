import { describe, expect, test } from "bun:test";
import { groupRowIds, groupRows } from "./groups";

const labels = (groups: string[], q: string) => groupRows(groups, q).map((r) => `${r.kind}:${r.label}`);

describe("group picker rows", () => {
  const groups = ["Personal", "Side projects", "Work"];

  test("with nothing typed: No group, then every group", () => {
    expect(labels(groups, "")).toEqual(["none:No group", "group:Personal", "group:Side projects", "group:Work"]);
  });

  test("a typed prefix completes to the group first, and offers the typed name as a new group after it", () => {
    expect(labels(groups, "wor")).toEqual(["group:Work", 'new:New group "wor"']);
    expect(labels(groups, "side proj")).toEqual(["group:Side projects", 'new:New group "side proj"']);
  });

  test("a name a group already has, in any case, isn't offered as new", () => {
    expect(labels(groups, "work")).toEqual(["group:Work"]);
    expect(labels(groups, "  WORK ")).toEqual(["group:Work"]);
  });

  test("a brand-new name is the only row, spaces tidied", () => {
    expect(labels(groups, "  Open   source ")).toEqual(['new:New group "Open source"']);
  });

  test("No group stays reachable by typing it", () => {
    expect(labels(groups, "no")).toEqual(["none:No group", 'new:New group "no"']);
  });

  test("an overlong name says why and isn't pickable", () => {
    const rows = groupRows(groups, "x".repeat(61));
    expect(rows.map((r) => r.kind)).toEqual(["invalid"]);
    expect(groupRowIds(rows)).toEqual([]);
  });

  test("ids: No group is the empty id, the rest their names", () => {
    expect(groupRowIds(groupRows(["Work"], ""))).toEqual(["", "Work"]);
    expect(groupRowIds(groupRows(["Work"], "home"))).toEqual(["home"]);
  });
});

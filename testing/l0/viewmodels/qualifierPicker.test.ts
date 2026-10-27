import { describe, expect, test } from "bun:test";
import type { LabelInfo, Project } from "@harness/shared";
import { qualifierOptions } from "../../../app/src/renderer/state/qualifierPicker";

const label = (name: string): LabelInfo => ({ name, color: "red", createdAt: 0, lastUsedAt: 0, count: 1 });
const labels = [label("Bugfix"), label("Release 1.2.3"), label("Subrelease"), label("Docs")];
const project = (key: string, name: string) => ({ key, name, color: "blue" }) as Project;
const projects = [project("HAR", "Harness"), project("NYT", "New York Times")];
const names = (q: string, ls = labels, ps = projects) => qualifierOptions(q, ls, ps)?.options.map((o) => o.value);

describe("qualifierOptions", () => {
  test("is null unless the last word is a qualifier being typed", () => {
    expect(qualifierOptions("fix the bug", labels, projects)).toBeNull();
    expect(qualifierOptions('label:"Release 1.2.3" ', labels, projects)).toBeNull();
    expect(qualifierOptions("label:Bugfix", labels, projects)).not.toBeNull();
  });
  test("a bare label: lists every label in collection order", () => {
    expect(names("label:")).toEqual(["Bugfix", "Release 1.2.3", "Subrelease", "Docs"]);
  });
  test("filters by what's typed after the colon, names that start with it first", () => {
    expect(names("widget label:rel")).toEqual(["Release 1.2.3", "Subrelease"]);
    expect(names("label:ELEASE")).toEqual(["Release 1.2.3", "Subrelease"]);
  });
  test("an open quote filters by the whole phrase", () => {
    expect(names('label:"release 1')).toEqual(["Release 1.2.3"]);
  });
  test("projects match by key or name and insert the key", () => {
    expect(names("project:york")).toEqual(["NYT"]);
    expect(names("project:ha")).toEqual(["HAR"]);
    expect(qualifierOptions("project:", labels, projects)?.options[0]).toMatchObject({ field: "project", value: "HAR", detail: "Harness" });
  });
  test("caps the list", () => {
    expect(qualifierOptions("label:", labels, projects, 2)?.options).toHaveLength(2);
  });
});

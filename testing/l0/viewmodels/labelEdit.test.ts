import { describe, expect, test } from "bun:test";
import type { LabelInfo } from "@harness/shared";
import { addLabel, labelSuggestions, removeLabel } from "../../../app/src/renderer/state/labelEdit";

const info = (name: string): LabelInfo => ({ name, color: "red", createdAt: 0, lastUsedAt: 0, count: 1 });
const known = [info("Bugfix"), info("Réferences"), info("Release 1.2.3"), info("Docs")];

describe("labelSuggestions", () => {
  test("matches anywhere in the name without case or accents, in collection order", () => {
    expect(labelSuggestions(known, [], "RE").map((l) => l.name)).toEqual(["Réferences", "Release 1.2.3"]);
  });
  test("leaves out labels the ticket already carries", () => {
    expect(labelSuggestions(known, ["docs"], "d").map((l) => l.name)).toEqual([]);
  });
  test("caps the list", () => {
    expect(labelSuggestions(known, [], "", 2)).toHaveLength(2);
  });
});

describe("addLabel", () => {
  test("an existing label keeps its spelling whatever case is typed", () => {
    expect(addLabel(known, ["Docs"], "  bugfix ")).toEqual({ labels: ["Docs", "Bugfix"] });
  });
  test("a new name is added as typed, whitespace collapsed", () => {
    expect(addLabel(known, [], "Needs   review")).toEqual({ labels: ["Needs review"] });
  });
  test("one the ticket has changes nothing, and so does an empty entry", () => {
    expect(addLabel(known, ["Bugfix"], "BUGFIX")).toEqual({ labels: ["Bugfix"] });
    expect(addLabel(known, ["Bugfix"], "   ")).toEqual({ labels: ["Bugfix"] });
  });
  test("names the service refuses are errors", () => {
    expect(addLabel(known, [], 'say "hi"')).toHaveProperty("error");
    expect(addLabel(known, [], "x".repeat(41))).toHaveProperty("error");
  });
});

test("removeLabel drops by key", () => {
  expect(removeLabel(["A", "B"], "a")).toEqual(["B"]);
});

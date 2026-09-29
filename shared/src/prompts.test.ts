import { expect, test } from "bun:test";
import type { PromptEntry } from "./protocol";
import { groupPrompts, insertText, lineDiff, promptDraftDirty, promptDraftError, promptSavePatch, promptState } from "./prompts";

const entry = (over: Partial<PromptEntry>): PromptEntry => ({
  id: "system.work",
  group: "system",
  label: "Work",
  description: "",
  variables: [
    { name: "branch", description: "" },
    { name: "worktree", description: "" },
  ],
  builtin: "Work on {{branch}}.",
  override: null,
  overrideError: null,
  ...over,
});

test("groups follow system then run whatever the catalog order, and empty groups are dropped", () => {
  const list = [entry({ id: "run.review", group: "run" }), entry({ id: "system.intro" }), entry({ id: "system.work" })];
  expect(groupPrompts(list).map((g) => [g.group, g.entries.map((e) => e.id)])).toEqual([
    ["system", ["system.intro", "system.work"]],
    ["run", ["run.review"]],
  ]);
  expect(groupPrompts([entry({ group: "run", id: "run.review" })]).map((g) => g.group)).toEqual(["run"]);
});

test("state: no override is built-in; a stored override with an error is broken, not customized", () => {
  expect(promptState(entry({}))).toBe("builtin");
  expect(promptState(entry({ override: "x" }))).toBe("customized");
  expect(promptState(entry({ override: "{{brnch}}", overrideError: "Unknown variable {{brnch}}" }))).toBe("broken");
  // An error without an override (shouldn't happen) still reads as the built-in.
  expect(promptState(entry({ overrideError: "stale" }))).toBe("builtin");
});

test("draft validation only allows the prompt's own variables; empty is a reset, not an error", () => {
  expect(promptDraftError(entry({}), "On {{branch}}{{#if worktree}} (worktree){{/if}}")).toBeNull();
  expect(promptDraftError(entry({}), "On {{brnch}}")).toContain("{{brnch}}");
  expect(promptDraftError(entry({}), "{{#if branch}}open")).toContain("never closed");
  expect(promptDraftError(entry({}), "")).toBeNull();
  expect(promptDraftError(entry({}), " \n ")).toBeNull();
});

test("dirty: a fresh Customize isn't a change, editing back to the built-in is (it resets)", () => {
  const builtin = entry({});
  expect(promptDraftDirty(builtin, builtin.builtin)).toBe(false);
  expect(promptDraftDirty(builtin, "Changed")).toBe(true);
  const custom = entry({ override: "Mine" });
  expect(promptDraftDirty(custom, "Mine")).toBe(false);
  expect(promptDraftDirty(custom, custom.builtin)).toBe(true);
  expect(promptDraftDirty(custom, "")).toBe(true);
});

test("save patch stores null for a reset, an empty draft or the built-in text, so it keeps updating", () => {
  const e = entry({ override: "Mine" });
  expect(promptSavePatch(e, "Other")).toEqual({ prompts: { "system.work": "Other" } });
  expect(promptSavePatch(e, null)).toEqual({ prompts: { "system.work": null } });
  expect(promptSavePatch(e, "")).toEqual({ prompts: { "system.work": null } });
  expect(promptSavePatch(e, "  \n")).toEqual({ prompts: { "system.work": null } });
  expect(promptSavePatch(e, e.builtin)).toEqual({ prompts: { "system.work": null } });
  // Whitespace differences are a real override (text is kept exactly).
  expect(promptSavePatch(e, e.builtin + "\n")).toEqual({ prompts: { "system.work": e.builtin + "\n" } });
});

test("insertText replaces the selection and clamps out-of-range carets", () => {
  expect(insertText("ab cd", 3, 5, "{{x}}")).toEqual({ text: "ab {{x}}", caret: 8 });
  expect(insertText("ab", 1, 1, "Z")).toEqual({ text: "aZb", caret: 2 });
  expect(insertText("ab", 9, 12, "Z")).toEqual({ text: "abZ", caret: 3 });
  expect(insertText("ab", 2, 0, "Z")).toEqual({ text: "abZ", caret: 3 });
});

test("lineDiff keeps shared lines, marks changes, and rebuilds both sides", () => {
  const from = "one\ntwo\nthree\nfour";
  const to = "one\n2\nthree\nfour\nfive";
  const d = lineDiff(from, to);
  expect(d).toEqual([
    { type: "same", text: "one" },
    { type: "del", text: "two" },
    { type: "add", text: "2" },
    { type: "same", text: "three" },
    { type: "same", text: "four" },
    { type: "add", text: "five" },
  ]);
  expect(d.filter((l) => l.type !== "add").map((l) => l.text).join("\n")).toBe(from);
  expect(d.filter((l) => l.type !== "del").map((l) => l.text).join("\n")).toBe(to);
  expect(lineDiff("a\nb", "a\nb").every((l) => l.type === "same")).toBe(true);
  expect(lineDiff("x", "")).toEqual([
    { type: "del", text: "x" },
    { type: "add", text: "" },
  ]);
});

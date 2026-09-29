import { describe, expect, test } from "bun:test";
import type { ChoiceGroup } from "@harness/shared/state";
import { comboRows, isTypeaheadKey, moveActive, optionValues, settleActive } from "./modelCombobox";

const def = { value: "", label: "Default (Claude Code · Opus 5.5)" };
const groups: ChoiceGroup[] = [
  {
    driver: "claude-code",
    label: "Claude Code",
    options: [
      { value: "claude-code\u0001opus", label: "Opus 5.5" },
      { value: "claude-code\u0001sonnet", label: "Sonnet 5" },
    ],
  },
  { driver: "dummy", label: "Dummy", options: [{ value: "dummy\u0001dummy-fast", label: "Dummy Fast" }] },
];

describe("comboRows", () => {
  test("no query: Default, then a heading before each driver's models", () => {
    expect(comboRows(def, groups, "").map((r) => (r.kind === "heading" ? `# ${r.label}` : r.label))).toEqual(["Default (Claude Code · Opus 5.5)", "# Claude Code", "Opus 5.5", "Sonnet 5", "# Dummy", "Dummy Fast"]);
  });

  test("a query hides Default unless it matches, and drops groups with no match", () => {
    expect(comboRows(def, groups, "son").map((r) => r.label)).toEqual(["Claude Code", "Sonnet 5"]);
    // "opus" is in Default's label (it names what Default resolves to)
    expect(comboRows(def, groups, "opus").map((r) => r.label)).toEqual(["Default (Claude Code · Opus 5.5)", "Claude Code", "Opus 5.5"]);
  });

  test("a flat (unlabelled) group has no heading", () => {
    const flat = [{ ...groups[0]!, label: null }];
    expect(comboRows(def, flat, "").map((r) => r.kind)).toEqual(["option", "option", "option"]);
  });

  test("nothing matching leaves no rows", () => {
    expect(comboRows(def, groups, "zzz")).toEqual([]);
  });

  test("without a Default (a ticket mid-run) the rows start at the models", () => {
    expect(comboRows(null, groups, "").map((r) => r.label)).toEqual(["Claude Code", "Opus 5.5", "Sonnet 5", "Dummy", "Dummy Fast"]);
    expect(comboRows(null, groups, "opus").map((r) => r.label)).toEqual(["Claude Code", "Opus 5.5"]);
  });
});

describe("active option", () => {
  const values = optionValues(comboRows(def, groups, ""));

  test("headings are skipped: down from Opus's neighbour crosses the Dummy heading", () => {
    expect(values).toEqual(["", "claude-code\u0001opus", "claude-code\u0001sonnet", "dummy\u0001dummy-fast"]);
    expect(moveActive(values, "claude-code\u0001sonnet", "next")).toBe("dummy\u0001dummy-fast");
  });

  test("wraps at both ends", () => {
    expect(moveActive(values, "dummy\u0001dummy-fast", "next")).toBe("");
    expect(moveActive(values, "", "prev")).toBe("dummy\u0001dummy-fast");
  });

  test("with no active option down starts at the first and up at the last; empty lists have none", () => {
    expect(moveActive(values, null, "next")).toBe("");
    expect(moveActive(values, "gone", "prev")).toBe("dummy\u0001dummy-fast");
    expect(moveActive([], null, "next")).toBeNull();
  });

  test("settles on the current active, else the picked value, else the first", () => {
    expect(settleActive(values, "dummy\u0001dummy-fast", "")).toBe("dummy\u0001dummy-fast");
    expect(settleActive(["claude-code\u0001sonnet"], "dummy\u0001dummy-fast", "claude-code\u0001sonnet")).toBe("claude-code\u0001sonnet");
    expect(settleActive(["a", "b"], "gone", "also-gone")).toBe("a");
    expect(settleActive([], null, "")).toBeNull();
  });
});

describe("isTypeaheadKey", () => {
  const k = (key: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) => ({ key, metaKey: false, ctrlKey: false, altKey: false, ...mods });
  test("printable characters open with type-ahead; space, named keys and shortcuts don't", () => {
    expect(isTypeaheadKey(k("s"))).toBe(true);
    expect(isTypeaheadKey(k("4"))).toBe(true);
    expect(isTypeaheadKey(k(" "))).toBe(false);
    expect(isTypeaheadKey(k("ArrowDown"))).toBe(false);
    expect(isTypeaheadKey(k("k", { metaKey: true }))).toBe(false);
    expect(isTypeaheadKey(k("a", { ctrlKey: true }))).toBe(false);
  });
});

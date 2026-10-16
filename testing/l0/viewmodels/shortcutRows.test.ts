import { describe, expect, test } from "bun:test";
import { COMMANDS } from "../../../app/src/renderer/state/keys";
import { shortcutRows } from "../../../app/src/renderer/state/shortcutRows";

describe("shortcutRows", () => {
  test("tab.1 to tab.9 collapse into one 'Jump to tab' row, in the place of tab.1", () => {
    const rows = shortcutRows("Ticket");
    expect(rows.filter((r) => r.id.startsWith("tab.")).map((r) => r.id)).toEqual(["tab.next", "tab.prev", "tab.n"]);
    expect(rows.find((r) => r.id === "tab.n")).toEqual({ id: "tab.n", label: "Jump to tab 1–9", keys: ["1–9"] });
  });
  test("commands with no keys are left out (Actions, palette-only board.children)", () => {
    expect(shortcutRows("Actions")).toEqual([]);
    expect(shortcutRows("Board").map((r) => r.id)).not.toContain("board.children");
  });
  test("rows follow registry order and carry the display keys, ⌘ first", () => {
    const rows = shortcutRows("Panes");
    expect(rows.map((r) => r.id)).toEqual(COMMANDS.filter((c) => c.group === "Panes").map((c) => c.id));
    expect(rows[0]).toEqual({ id: "pane.left", label: "Focus Pane Left", keys: ["⌥⌘←", "⌃H"] });
  });
  test("only the asked group's commands appear", () => {
    expect(shortcutRows("General").every((r) => COMMANDS.find((c) => c.id === r.id)!.group === "General")).toBe(true);
  });
});

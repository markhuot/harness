import { describe, expect, test } from "bun:test";
import { renderAxTree, type AxNode, type SnapshotHost } from "./snapshot.ts";

/** A node: role, name, children; backend id = its node id as a number. */
const node = (id: string, role: string, name: string, childIds: string[] = [], extra: Partial<AxNode> = {}): AxNode => ({
  nodeId: id,
  role: { value: role },
  name: { value: name },
  childIds,
  backendDOMNodeId: Number(id),
  ...extra,
});

const host = (frames: Record<number, string[]> = {}): SnapshotHost => ({
  ref: (b) => `e${b}`,
  child: async (b, depth) => (frames[b] ?? ["(none)"]).map((l) => `${"  ".repeat(depth)}${l}`),
});

const render = (nodes: AxNode[], h = host(), left = 100) => renderAxTree(nodes, h, { budget: { left, skipped: 0 } });

describe("renderAxTree", () => {
  test("flattens unnamed structure and ignored nodes, keeps roles with names and refs", async () => {
    const nodes = [
      node("1", "RootWebArea", "Shop", ["2"]),
      { ...node("2", "generic", "", ["3", "4"]) },
      node("3", "heading", "Cart", ["5"], { properties: [{ name: "level", value: { value: 2 } }] }),
      node("5", "StaticText", "Cart", ["6"]),
      node("6", "InlineTextBox", "Cart"),
      node("4", "none", "", ["7"], { ignored: true }),
      node("7", "button", "Pay", [], { properties: [{ name: "disabled", value: { value: true } }, { name: "focusable", value: { value: true } }] }),
    ];
    expect(await render(nodes)).toEqual(['- document "Shop"', '  - heading "Cart" [ref=e3] level=2', '  - button "Pay" [ref=e7] (disabled)']);
  });

  test("shows a field's value once, its states, and text that isn't its parent's name or value", async () => {
    const nodes = [
      node("1", "RootWebArea", "", ["2", "4", "6"]),
      node("2", "textbox", "Card number", ["3"], { value: { value: "4242 4242" }, properties: [{ name: "focused", value: { value: true } }, { name: "invalid", value: { value: "false" } }] }),
      node("3", "StaticText", "4242 4242"),
      node("4", "checkbox", "Save card", [], { properties: [{ name: "checked", value: { value: "true" } }] }),
      node("6", "paragraph", "", ["7"]),
      node("7", "StaticText", "  Secured   by\nStripe "),
    ];
    expect(await render(nodes)).toEqual([
      "- document",
      '  - textbox "Card number" [ref=e2] value="4242 4242" (focused)',
      '  - checkbox "Save card" [ref=e4] (checked)',
      "  - paragraph [ref=e6]",
      "    - text: Secured by Stripe",
    ]);
  });

  test("an iframe nests its frame's lines one level under it", async () => {
    const nodes = [node("1", "RootWebArea", "", ["2", "3"]), node("2", "Iframe", "Card"), node("3", "button", "Pay")];
    const lines = await render(nodes, host({ 2: ["- document", '  - textbox "Number" [ref=e40]'] }));
    expect(lines).toEqual(["- document", '  - iframe "Card" [ref=e2]', "    - document", '      - textbox "Number" [ref=e40]', '  - button "Pay" [ref=e3]']);
  });

  test("the budget caps the lines across the tree and counts the rest", async () => {
    const nodes = [node("1", "RootWebArea", "", ["2", "3", "4"]), node("2", "button", "A"), node("3", "button", "B"), node("4", "button", "C")];
    const budget = { left: 2, skipped: 0 };
    expect(await renderAxTree(nodes, host(), { budget })).toEqual(["- document", '  - button "A" [ref=e2]']);
    expect(budget.skipped).toBe(2);
  });
});

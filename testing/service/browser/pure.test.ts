import { expect, test } from "bun:test";
import { authKey, basicRealm, headerOf, originOf, stripUserinfo } from "../../../service/src/browser/auth";
import { sameView, SCROLL_TOLERANCE, findElementExpression, type PageElementReport } from "../../../service/src/browser/element";
import { charCode, charPress, macEditingCommands, MOD_ALT, MOD_CTRL, MOD_META, MOD_SHIFT, parseKeyChord, virtualKeyCode } from "../../../service/src/browser/keys";
import { axNodes, renderAxTree, type AxNode, type SnapshotHost } from "../../../service/src/browser/snapshot";

test("basicRealm finds the realm of a Basic challenge among several, quoted or not, and is empty for a Basic challenge without one", () => {
  expect(basicRealm('Basic realm="Staging area"')).toBe("Staging area");
  expect(basicRealm('Bearer abc\nBasic realm="a \\"quoted\\" realm"')).toBe('a "quoted" realm');
  expect(basicRealm('Digest realm="x", Basic realm=plain')).toBe("plain");
  expect(basicRealm("Basic")).toBe("");
  expect(basicRealm('Bearer realm="x"')).toBeNull();
  expect(basicRealm(undefined)).toBeNull();
});

test("headers are found by name whatever the server's capitalisation, and only string values count", () => {
  expect(headerOf({ "WWW-Authenticate": "Basic" }, "www-authenticate")).toBe("Basic");
  expect(headerOf({ Foo: 1 }, "foo")).toBeUndefined();
  expect(headerOf(undefined, "foo")).toBeUndefined();
});

test("credentials are keyed by origin and realm, and URLs lose their user:password before they're stored", () => {
  expect(authKey("https://a.test", "r")).not.toBe(authKey("https://a.test", "s"));
  expect(authKey("https://a.test", "r")).not.toBe(authKey("https://b.test", "r"));
  expect(stripUserinfo("https://user:pw@host.test/path?q=1")).toBe("https://host.test/path?q=1");
  expect(stripUserinfo("https://host.test/a@b")).toBe("https://host.test/a@b");
  expect(stripUserinfo("not a url @ here")).toBe("not a url @ here");
  expect(originOf("https://host.test:8443/x")).toBe("https://host.test:8443");
  expect(originOf("about:blank")).toBeNull();
  expect(originOf("data:text/plain,hi")).toBeNull();
  expect(originOf("garbage")).toBeNull();
});

test("a key chord parses its modifiers and what it types: shortcuts type nothing, a shifted letter is upper-case", () => {
  expect(parseKeyChord("a")).toEqual({ key: "a", code: "KeyA", modifiers: 0, text: "a" });
  expect(parseKeyChord("Shift+a")).toEqual({ key: "A", code: "KeyA", modifiers: MOD_SHIFT, text: "A" });
  expect(parseKeyChord("Meta+a")).toEqual({ key: "a", code: "KeyA", modifiers: MOD_META });
  expect(parseKeyChord("ctrl+alt+Delete")).toEqual({ key: "Delete", code: "Delete", modifiers: MOD_CTRL | MOD_ALT });
  expect(parseKeyChord("Enter")).toEqual({ key: "Enter", code: "Enter", modifiers: 0, text: "\r" });
  expect(parseKeyChord("Cmd+Enter").text).toBeUndefined();
  expect(parseKeyChord("Space")).toEqual({ key: " ", code: "Space", modifiers: 0, text: " " });
  expect(parseKeyChord("esc").key).toBe("Escape");
  expect(parseKeyChord("down").key).toBe("ArrowDown");
  expect(parseKeyChord("f5").key).toBe("F5");
  expect(parseKeyChord("+")).toMatchObject({ key: "+", modifiers: 0, text: "+" });
  expect(parseKeyChord("Shift++")).toMatchObject({ key: "+", modifiers: MOD_SHIFT });
});

test("a chord with an unknown modifier or key says what's allowed", () => {
  expect(() => parseKeyChord("Hyper+a")).toThrow(/Unknown modifier "Hyper".*Shift, Control, Alt or Meta/);
  expect(() => parseKeyChord("Banana")).toThrow(/Unknown key "Banana".*Enter, Tab/);
});

test("virtual key codes come from the code first, then the key, and are 0 when unknown", () => {
  expect(virtualKeyCode("a", "KeyA")).toBe(65);
  expect(virtualKeyCode("5", "Digit5")).toBe(53);
  expect(virtualKeyCode("5", "Numpad5")).toBe(101);
  expect(virtualKeyCode("F12", "F12")).toBe(123);
  expect(virtualKeyCode("Enter", "NumpadEnter")).toBe(13);
  expect(virtualKeyCode(" ", "")).toBe(32);
  expect(virtualKeyCode("z", "")).toBe(90);
  expect(virtualKeyCode("€", "")).toBe(0);
});

test("a typed character becomes a key press: Shift for capitals, Enter for a newline, no text for Tab", () => {
  expect(charPress("A")).toEqual({ key: "A", code: "KeyA", modifiers: MOD_SHIFT, text: "A" });
  expect(charPress("\n")).toEqual({ key: "Enter", code: "Enter", modifiers: 0, text: "\r" });
  expect(charPress("\t")).toEqual({ key: "Tab", code: "Tab", modifiers: 0 });
  expect(charPress("!")).toEqual({ key: "!", code: "", modifiers: 0, text: "!" });
  expect([charCode("q"), charCode("7"), charCode(" "), charCode("€")]).toEqual(["KeyQ", "Digit7", "Space", ""]);
});

test("Cmd shortcuts get macOS editing commands, with redo for Shift+Cmd+Z; nothing without Meta", () => {
  if (process.platform !== "darwin") return;
  expect(macEditingCommands("KeyA", MOD_META)).toEqual(["selectAll"]);
  expect(macEditingCommands("KeyZ", MOD_META | MOD_SHIFT)).toEqual(["redo"]);
  expect(macEditingCommands("KeyA", 0)).toBeUndefined();
  expect(macEditingCommands("KeyB", MOD_META)).toBeUndefined();
});

const node = (nodeId: string, role: string, extra: Partial<AxNode> = {}): AxNode => ({ nodeId, role: { value: role }, ...extra });
const host = (children: Record<number, string[]> = {}): SnapshotHost & { refs: number[] } => {
  const refs: number[] = [];
  return { refs, ref: (id) => (refs.push(id), `e${id}`), child: async (id) => children[id] ?? ["  - (no frame)"] };
};

test("the accessibility tree renders as indented lines with names, refs, values and states; layout wrappers fold away", async () => {
  const nodes: AxNode[] = [
    node("1", "RootWebArea", { name: { value: "Page" }, childIds: ["2", "3"] }),
    node("2", "generic", { childIds: ["4"] }),
    node("4", "heading", { name: { value: "Welcome" }, backendDOMNodeId: 10, properties: [{ name: "level", value: { value: 1 } }], childIds: ["5"] }),
    node("5", "StaticText", { name: { value: "Welcome" } }),
    node("3", "textbox", { name: { value: "Email" }, value: { value: "a@b.c" }, backendDOMNodeId: 11, properties: [{ name: "focused", value: { value: true } }, { name: "required", value: { value: true } }], childIds: ["6"] }),
    node("6", "StaticText", { name: { value: "Enter your email" } }),
  ];
  for (const n of nodes.slice(1)) n.parentId = n.nodeId === "4" ? "2" : n.nodeId === "5" ? "4" : n.nodeId === "6" ? "3" : "1";
  const h = host();
  const lines = await renderAxTree(nodes, h, { budget: { left: 100, skipped: 0 } });
  expect(lines).toEqual([
    '- document "Page"',
    '  - heading "Welcome" [ref=e10] level=1',
    '  - textbox "Email" [ref=e11] value="a@b.c" (focused, required)',
    "    - text: Enter your email",
  ]);
});

test("checked, expanded and invalid states each read as a word, and mixed checkboxes say so", async () => {
  const nodes: AxNode[] = [
    { ...node("1", "RootWebArea"), childIds: ["2", "3", "4"] },
    { ...node("2", "checkbox", { name: { value: "A" }, backendDOMNodeId: 1, properties: [{ name: "checked", value: { value: "true" } }, { name: "invalid", value: { value: "true" } }] }), parentId: "1" },
    { ...node("3", "checkbox", { name: { value: "B" }, backendDOMNodeId: 2, properties: [{ name: "checked", value: { value: "mixed" } }] }), parentId: "1" },
    { ...node("4", "button", { name: { value: "More" }, backendDOMNodeId: 3, properties: [{ name: "expanded", value: { value: false } }] }), parentId: "1" },
  ];
  const lines = await renderAxTree(nodes, host(), { budget: { left: 100, skipped: 0 } });
  expect(lines.slice(1)).toEqual(['  - checkbox "A" [ref=e1] (checked, invalid)', '  - checkbox "B" [ref=e2] (checked=mixed)', '  - button "More" [ref=e3] (not expanded)']);
});

test("the node budget is shared across the page: what doesn't fit is counted, not shown", async () => {
  const kids = Array.from({ length: 5 }, (_, i) => ({ ...node(`k${i}`, "button", { name: { value: `B${i}` }, backendDOMNodeId: i }), parentId: "1" }));
  const nodes = [{ ...node("1", "RootWebArea"), childIds: kids.map((k) => k.nodeId) }, ...kids];
  const budget = { left: 3, skipped: 0 };
  const lines = await renderAxTree(nodes, host(), { budget });
  expect(lines).toHaveLength(3);
  expect(budget.skipped).toBe(3);
});

test("an iframe's own tree is nested under it by the host, and ignored nodes and line boxes are left out", async () => {
  const nodes: AxNode[] = [
    { ...node("1", "RootWebArea"), childIds: ["2", "3", "4"] },
    { ...node("2", "Iframe", { name: { value: "Ad" }, backendDOMNodeId: 7 }), parentId: "1" },
    { ...node("3", "InlineTextBox", { name: { value: "x" } }), parentId: "1" },
    { ...node("4", "button", { name: { value: "Hidden" }, ignored: true, childIds: ["5"] }), parentId: "1" },
    { ...node("5", "link", { name: { value: "Inner" }, backendDOMNodeId: 9 }), parentId: "4" },
  ];
  const lines = await renderAxTree(nodes, host({ 7: ["    - text: from the frame"] }), { budget: { left: 100, skipped: 0 } });
  expect(lines).toEqual(["- document", '  - iframe "Ad" [ref=e7]', "    - text: from the frame", '  - link "Inner" [ref=e9]']);
  expect(await renderAxTree([], host(), { budget: { left: 1, skipped: 0 } })).toEqual([]);
  expect(axNodes({ nodes: [node("1", "x")] } as never)).toHaveLength(1);
  expect(axNodes(undefined as never)).toEqual([]);
});

const report = (over: Partial<PageElementReport> = {}): PageElementReport => ({
  href: "https://x.test/page",
  scroll: { x: 0, y: 100 },
  viewport: { width: 800, height: 600 },
  element: { path: "div>a", text: "Go" } as never,
  ...over,
});
const query = { url: "https://x.test/page", scroll: { x: 0, y: 100 }, viewport: { width: 800, height: 600 } };

test("the element under a marked point is trusted only while the page is still the one the screenshot showed", () => {
  const r = report();
  expect(sameView(r, "https://x.test/page", query)).toBe(r.element);
  expect(sameView(r, "https://tab.test/", { ...query, url: "https://tab.test/" })).toBe(r.element);
  expect(sameView(r, "https://x.test/page", { ...query, url: "https://other.test/" })).toBeNull();
  expect(sameView(r, "x", { ...query, scroll: { x: 0, y: 100 + SCROLL_TOLERANCE } })).toBe(r.element);
  expect(sameView(r, "x", { ...query, scroll: { x: 0, y: 100 + SCROLL_TOLERANCE + 0.5 } })).toBeNull();
  expect(sameView(r, "x", { ...query, viewport: { width: 801, height: 600 } })).toBeNull();
});

test("the in-page expression embeds the point and the limits as data", () => {
  const expr = findElementExpression(12, 34);
  expect(expr.startsWith("(")).toBe(true);
  expect(expr).toMatch(/\)\(12, 34, \d+, \d+\)$/);
});

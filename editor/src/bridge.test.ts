import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { EditorHandle, EditorOptions } from "./editor";

// Pierre's editor needs a real layout engine (canvas text measuring), so the bridge runs against a
// stand-in handle here; the real editor is covered by the Mac app check (app/scripts/file-pane-check.ts).
const opened: EditorOptions[] = [];
const calls: string[] = [];
let dirty = false;
let text = "";
function fakeHandle(options: EditorOptions): EditorHandle {
  if (options.contents === "boom") throw new Error("boom");
  opened.push(options);
  text = options.contents;
  dirty = options.saved !== undefined && options.saved !== options.contents;
  const none = () => () => {};
  return {
    setTheme: (t) => void calls.push(`theme ${JSON.stringify(t)}`),
    reveal: (r) => void calls.push(`reveal ${r.start}-${r.end}`),
    getContents: () => text,
    setContents: (c) => void ((text = c), calls.push("setContents")),
    isDirty: () => dirty,
    markSaved: () => void calls.push("markSaved"),
    focus: () => void calls.push("focus"),
    setReadOnly: () => {},
    setSelection: () => {},
    getSelectionLines: () => null,
    scrollToCursor: () => void calls.push("scrollToCursor"),
    probe: () => ({ markedLines: ["b"], selection: { anchor: 1, head: 2 }, dirty, scrollY: 0, lineCount: 4, colors: 3 }),
    onChange: (fn) => (listeners.change = fn, none()),
    onDirty: (fn) => (listeners.dirty = fn, none()),
    onSave: (fn) => (listeners.save = fn, none()),
    onBlur: (fn) => (listeners.blur = fn, none()),
    destroy: () => void calls.push("destroy"),
  };
}
const listeners: Record<string, (...a: never[]) => void> = {};
const diffs: unknown[] = [];
mock.module("./editor", () => ({ createEditor: (_p: unknown, o: EditorOptions) => fakeHandle(o) }));
mock.module("./diff", () => ({
  createDiffEditor: (_p: unknown, o: unknown) => {
    diffs.push(o);
    return { setTheme: (t: unknown) => void calls.push(`diffTheme ${JSON.stringify(t)}`), getContents: () => "mod", getOriginal: () => "orig", destroy: () => void calls.push("diffDestroy") };
  },
}));
const { mount } = await import("./bridge");
type Event = Parameters<Parameters<typeof mount>[1]>[0];

beforeEach(() => {
  opened.length = 0;
  calls.length = 0;
  diffs.length = 0;
});

describe("bridge", () => {
  test("announces itself, then an open creates a page-scrolled editor limited to the bundled grammars", () => {
    const events: Event[] = [];
    const m = mount(window, (e) => events.push(e));
    expect(events).toEqual([{ type: "ready" }]);
    m.receive({ type: "open", contents: "x", language: "main.tf" });
    expect(opened[0]!.scroller).toBe("page");
    expect(opened[0]!.languages!.has("hcl")).toBe(true);
    expect(opened[0]!.languages!.has("zig")).toBe(false);
    m.destroy();
  });

  test("a theme pushed before open is used by the editor, and the last one is kept across reopens", () => {
    const m = mount(window, () => {});
    m.receive({ type: "theme", theme: { appearance: "dark", syntaxTheme: "dracula" } });
    m.receive({ type: "open", contents: "x" });
    expect(opened[0]!.theme).toEqual({ appearance: "dark", syntaxTheme: "dracula" });
    m.receive({ type: "open", contents: "y", theme: { appearance: "light" } });
    m.receive({ type: "open", contents: "z" });
    expect(opened[2]!.theme).toEqual({ appearance: "light" });
    m.destroy();
  });

  test("editor events post as JSON: a change carries the dirty flag, save and blur follow", () => {
    const events: Event[] = [];
    const m = mount(window, (e) => events.push(e));
    m.receive({ type: "open", contents: "a" });
    dirty = true;
    (listeners.change as (c: string) => void)("ab");
    (listeners.dirty as (d: boolean) => void)(true);
    (listeners.save as (c: string) => void)("ab");
    (listeners.blur as () => void)();
    expect(events.slice(1)).toEqual([
      { type: "change", contents: "ab", dirty: true },
      { type: "dirty", dirty: true },
      { type: "save", contents: "ab" },
      { type: "blur" },
    ]);
    expect(() => JSON.stringify(events)).not.toThrow();
    m.destroy();
  });

  test("commands reach the editor, getContents answers with its id, and reopening destroys the old one", () => {
    const events: Event[] = [];
    const m = mount(window, (e) => events.push(e));
    m.receive({ type: "open", contents: "a" });
    m.receive({ type: "reveal", range: { start: 2, end: 3 } });
    m.receive({ type: "setContents", contents: "b" });
    m.receive({ type: "markSaved" });
    m.receive({ type: "focus" });
    m.receive({ type: "scrollToCursor" });
    m.receive({ type: "getContents", id: "7" });
    expect(calls).toEqual(["reveal 2-3", "setContents", "markSaved", "focus", "scrollToCursor"]);
    expect(events.at(-1)).toEqual({ type: "contents", id: "7", contents: "b" });
    m.receive({ type: "open", contents: "c" });
    expect(calls.at(-1)).toBe("destroy");
    m.destroy();
  });

  test("a command the editor rejects posts an error instead of throwing, and the page stays usable", () => {
    const events: Event[] = [];
    const m = mount(window, (e) => events.push(e));
    m.receive({ type: "open", contents: "boom" });
    expect(events.at(-1)).toEqual({ type: "error", message: "boom" });
    m.receive({ type: "open", contents: "fine" });
    expect(events.filter((e) => e.type === "error")).toHaveLength(1);
    expect(m.probe()).not.toBeNull();
    m.destroy();
  });

  test("probe is the editor's, and null without an editor or with only a diff open", () => {
    const m = mount(window, () => {});
    expect(m.probe()).toBeNull();
    m.receive({ type: "open", contents: "a\nb\nc\nd", range: { start: 2, end: 2 } });
    expect(m.probe()).toMatchObject({ markedLines: ["b"], lineCount: 4, dirty: false });
    m.receive({ type: "diff", original: "a", modified: "b" });
    expect(m.probe()).toBeNull();
    m.destroy();
  });

  test("a diff opens the read-only view, answers getContents with the modified side, and follows the theme", () => {
    const events: Event[] = [];
    const m = mount(window, (e) => events.push(e));
    m.receive({ type: "diff", original: "a", modified: "b", language: "a.ts", theme: { appearance: "dark" } });
    expect(diffs).toHaveLength(1);
    m.receive({ type: "theme", theme: { appearance: "light" } });
    expect(calls).toContain(`diffTheme ${JSON.stringify({ appearance: "light" })}`);
    m.receive({ type: "getContents" });
    expect(events.at(-1)).toEqual({ type: "contents", id: undefined, contents: "mod" });
    m.destroy();
  });
});

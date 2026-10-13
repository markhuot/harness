import { undo } from "@codemirror/commands";
import { afterEach, describe, expect, test } from "bun:test";
import { createDiffEditor, createEditor, detectEol, type EditorHandle } from "./editor";
import { languageName, resolveLanguage } from "./language";
import { mount, type BridgeEvent } from "./bridge";

const text = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
let host: HTMLElement;
let handles: Array<{ destroy(): void }> = [];

function make(options: Partial<Parameters<typeof createEditor>[1]> = {}): EditorHandle {
  host = document.createElement("div");
  document.body.append(host);
  const h = createEditor(host, { contents: text, language: "a.ts", ...options });
  handles.push(h);
  return h;
}
afterEach(() => {
  for (const h of handles) h.destroy();
  handles = [];
  document.body.replaceChildren();
});

const insert = (h: EditorHandle, s: string) => h.view.dispatch({ changes: { from: 0, insert: s } });

describe("reveal", () => {
  test("highlights the lines with an empty selection at the range start", () => {
    const h = make();
    h.reveal({ start: 5, end: 7 });
    const marked = [...host.querySelectorAll(".cm-revealed-line")].map((e) => e.textContent);
    expect(marked).toEqual(["line 5", "line 6", "line 7"]);
    const sel = h.view.state.selection.main;
    expect(sel.empty).toBe(true);
    expect(sel.head).toBe(h.view.state.doc.line(5).from);
  });

  test("clamps a range past the end of the file", () => {
    const h = make();
    h.reveal({ start: 28, end: 99 });
    expect([...host.querySelectorAll(".cm-revealed-line")].length).toBe(3);
  });

  test("the highlight lasts until the next edit", () => {
    const h = make({ range: { start: 2, end: 2 } });
    expect(host.querySelectorAll(".cm-revealed-line").length).toBe(1);
    insert(h, "x");
    expect(host.querySelectorAll(".cm-revealed-line").length).toBe(0);
  });
});

describe("theme", () => {
  test("a token map becomes CSS variables on the editor, and setTheme swaps and clears them", () => {
    const h = make({ theme: { tokens: { bg: "#111111", text: "#eeeeee" } } });
    expect(h.view.dom.style.getPropertyValue("--bg")).toBe("#111111");
    h.setTheme({ bg: "#222222", accent: "#ff0000" });
    expect(h.view.dom.style.getPropertyValue("--bg")).toBe("#222222");
    expect(h.view.dom.style.getPropertyValue("--accent")).toBe("#ff0000");
    expect(h.view.dom.style.getPropertyValue("--text")).toBe("");
  });

  test("the appearance flips the editor's dark class", () => {
    const h = make();
    const before = h.view.dom.className;
    h.setTheme({ appearance: "dark", tokens: {} });
    expect(h.view.dom.className).not.toBe(before);
  });
});

describe("dirty", () => {
  test("flips on edit, clears on markSaved, and reports transitions once", () => {
    const h = make();
    const seen: boolean[] = [];
    h.onDirty((d) => seen.push(d));
    expect(h.isDirty()).toBe(false);
    insert(h, "a");
    insert(h, "b");
    expect(h.isDirty()).toBe(true);
    h.markSaved();
    expect(h.isDirty()).toBe(false);
    expect(seen).toEqual([true, false]);
  });

  test("typing after a save event stays dirty when the host confirms the old contents", () => {
    const h = make({ contents: "abc" });
    let saved = "";
    h.onSave((c) => (saved = c));
    h.view.dispatch({ changes: { from: 3, insert: "d" } });
    h.view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "s", [/Mac|iPhone|iPad/.test(navigator.platform) ? "metaKey" : "ctrlKey"]: true, bubbles: true, cancelable: true }));
    expect(saved).toBe("abcd");
    h.view.dispatch({ changes: { from: 4, insert: "e" } });
    h.markSaved(saved);
    expect(h.isDirty()).toBe(true);
    h.markSaved(h.getContents());
    expect(h.isDirty()).toBe(false);
  });

  test("setContents is not undoable, and edits after it still emit change", () => {
    const h = make({ contents: "old" });
    insert(h, "x");
    h.setContents("new from disk");
    undo(h.view);
    expect(h.getContents()).toBe("new from disk");
    const changes: string[] = [];
    h.onChange((c) => changes.push(c));
    insert(h, "y");
    expect(changes.length).toBe(1);
  });

  test("typing back to the saved text is clean", () => {
    const h = make({ contents: "abc" });
    h.view.dispatch({ changes: { from: 3, insert: "d" } });
    expect(h.isDirty()).toBe(true);
    h.view.dispatch({ changes: { from: 3, to: 4 } });
    expect(h.isDirty()).toBe(false);
  });

  test("setContents is a clean reload: no change event, not dirty", () => {
    const h = make();
    const changes: string[] = [];
    h.onChange((c) => changes.push(c));
    insert(h, "a");
    h.setContents("fresh");
    expect(h.getContents()).toBe("fresh");
    expect(h.isDirty()).toBe(false);
    expect(changes).toEqual(["a" + text]);
  });

  test("a CRLF file reads and writes CRLF, and is the same text as the disk's", () => {
    const disk = "one\r\ntwo\r\nthree\r\n";
    const h = make({ contents: disk });
    expect(h.getContents()).toBe(disk);
    expect(h.view.state.doc.lines).toBe(4);
    h.view.dispatch({ changes: { from: 0, insert: "zero\r\n" } });
    expect(h.getContents()).toBe("zero\r\n" + disk);
    h.setContents(disk);
    expect(h.getContents()).toBe(disk);
    expect(h.isDirty()).toBe(false);
  });

  test("a file that mixes line endings is written back byte for byte, edits and all", () => {
    for (const disk of ["a\r\nb\nc\r\nd\r\n", "a\nb\r\nc\nd\n", "a\rb\nc\n", "a\r\nb\r\nc\n"]) {
      const h = make({ contents: disk });
      expect(h.getContents()).toBe(disk);
      expect(h.isDirty()).toBe(false);
      // An edit on the first line leaves every other line break as it was.
      h.view.dispatch({ changes: { from: 1, insert: "X" } });
      expect(h.getContents()).toBe("aX" + disk.slice(1));
    }
  });

  test("new lines in a mixed file use its most common line break", () => {
    expect(detectEol("a\r\nb\r\nc\n")).toBe("\r\n");
    expect(detectEol("a\nb\nc\r\n")).toBe("\n");
    expect(detectEol("a\r\nb\n")).toBe("\r\n");
    expect(detectEol("no breaks")).toBeNull();
    const h = make({ contents: "a\r\nb\r\nc\n" });
    h.view.dispatch({ changes: { from: 0, insert: "new\r\n" } });
    expect(h.getContents()).toBe("new\r\na\r\nb\r\nc\n");
  });

  test("a reload of a mixed file replaces only what changed", () => {
    const h = make({ contents: "a\r\nb\nc\r\n" });
    h.setContents("a\r\nb\nc\r\nd\n");
    expect(h.getContents()).toBe("a\r\nb\nc\r\nd\n");
    expect(h.isDirty()).toBe(false);
  });

  test("a mixed file reads clean after a save and after undoing back to it", () => {
    const original = "a\r\nb\nc\r\n";
    const h = make({ contents: original });
    insert(h, "x");
    expect(h.isDirty()).toBe(true);
    h.markSaved(h.getContents());
    expect(h.isDirty()).toBe(false);
    undo(h.view);
    expect(h.isDirty()).toBe(true);
    h.markSaved(original);
    expect(h.isDirty()).toBe(false);
    insert(h, "y");
    undo(h.view);
    expect(h.isDirty()).toBe(false);
  });

  test("a reload that changes the line breaks takes them", () => {
    const h = make({ contents: "a\r\nb\r\n" });
    h.setContents("a\nb\nc\n");
    expect(h.getContents()).toBe("a\nb\nc\n");
    expect(h.view.state.doc.lines).toBe(4);
    h.setContents("x\r\ny\r\n");
    expect(h.getContents()).toBe("x\r\ny\r\n");
  });

  test("a reload replaces only what changed: the cursor and the highlight stay", () => {
    const h = make({ contents: "a\nb\nc\nd\ne\n", range: { start: 4, end: 4 } });
    h.view.dispatch({ selection: { anchor: 6 } });
    h.setContents("a\nb\nc\nd\ne\nf\n");
    expect(h.view.state.selection.main.anchor).toBe(6);
    expect(h.view.dom.querySelectorAll(".cm-revealed-line").length).toBe(1);
    h.setContents("new\na\nb\nc\nd\ne\nf\n");
    expect(h.view.state.selection.main.anchor).toBe(10);
    expect(h.view.dom.querySelector(".cm-revealed-line")?.textContent).toBe("d");
  });
});

describe("reopened with unsaved edits", () => {
  test("opens dirty against what's on disk, and typing back to it is clean", () => {
    const h = make({ contents: "edited", saved: "disk" });
    expect(h.isDirty()).toBe(true);
    const events: boolean[] = [];
    h.onDirty((d) => events.push(d));
    h.view.dispatch({ changes: { from: 0, to: 6, insert: "disk" } });
    expect(h.isDirty()).toBe(false);
    expect(events).toEqual([false]);
  });

  test("saved equal to the contents is a clean open", () => {
    expect(make({ contents: "same", saved: "same" }).isDirty()).toBe(false);
  });
});

describe("touch keyboard", () => {
  test("autocorrect, capitalization and spell check are off on the editable content", () => {
    make();
    const content = host.querySelector(".cm-content")!;
    expect(content.getAttribute("autocorrect")).toBe("off");
    expect(content.getAttribute("autocapitalize")).toBe("off");
    expect(content.getAttribute("spellcheck")).toBe("false");
  });
});

describe("events", () => {
  test("Mod-s fires onSave with the contents", () => {
    const h = make({ contents: "hi" });
    const saves: string[] = [];
    h.onSave((c) => saves.push(c));
    const mac = /Mac|iPhone|iPad/.test(navigator.platform);
    const ev = new KeyboardEvent("keydown", { key: "s", [mac ? "metaKey" : "ctrlKey"]: true, bubbles: true, cancelable: true });
    h.view.contentDOM.dispatchEvent(ev);
    expect(saves).toEqual(["hi"]);
    expect(ev.defaultPrevented).toBe(true);
  });

  test("blur fires onBlur", () => {
    const h = make();
    let n = 0;
    h.onBlur(() => n++);
    h.view.contentDOM.dispatchEvent(new FocusEvent("blur"));
    expect(n).toBe(1);
  });

  test("an unsubscribed listener stops hearing", () => {
    const h = make();
    let n = 0;
    const off = h.onChange(() => n++);
    insert(h, "a");
    off();
    insert(h, "b");
    expect(n).toBe(1);
  });

  test("readOnly blocks typing through the editable flag", () => {
    const h = make({ readOnly: true });
    expect(h.view.contentDOM.getAttribute("contenteditable")).toBe("false");
    h.setReadOnly(false);
    expect(h.view.contentDOM.getAttribute("contenteditable")).toBe("true");
  });
});

describe("diff", () => {
  test("renders both sides and the changed lines", () => {
    host = document.createElement("div");
    document.body.append(host);
    const d = createDiffEditor(host, { original: "a\nb\nc", modified: "a\nB\nc", language: "x.ts" });
    handles.push(d);
    const editors = host.querySelectorAll(".cm-editor");
    expect(editors.length).toBe(2);
    expect(d.getOriginal()).toBe("a\nb\nc");
    expect(d.getContents()).toBe("a\nB\nc");
    expect(host.querySelectorAll(".cm-changedLine, .cm-deletedChunk").length).toBeGreaterThan(0);
  });
});

describe("language", () => {
  test("picks by extension and falls back to plain text", () => {
    expect(languageName("src/app.tsx")).toBe("typescript");
    expect(languageName("a/b/main.rs")).toBe("rust");
    expect(languageName("Gemfile")).toBe("ruby");
    expect(languageName("notes.weird")).toBe("plain");
    expect(languageName("LICENSE")).toBe("plain");
    expect(resolveLanguage("py")).toBe("python");
    expect(resolveLanguage("typescript")).toBe("typescript");
    expect(resolveLanguage(undefined)).toBe("plain");
  });

  test("a known language tokenizes into highlighted spans, plain text does not", () => {
    const ts = make({ contents: "const x = 1;", language: "a.ts" });
    const tsSpans = ts.view.contentDOM.querySelectorAll("span[class]").length;
    ts.destroy();
    document.body.replaceChildren();
    const plain = make({ contents: "const x = 1;", language: "a.unknown" });
    expect(tsSpans).toBeGreaterThan(0);
    expect(plain.view.contentDOM.querySelectorAll("span[class]").length).toBe(0);
  });
});

describe("reveal input", () => {
  test("a missing or NaN end reveals just the start line instead of throwing", () => {
    const h = make();
    h.reveal({ start: 5 } as never);
    expect(host.querySelectorAll(".cm-revealed-line").length).toBe(1);
    h.reveal({ start: 6, end: NaN });
    expect(host.querySelectorAll(".cm-revealed-line").length).toBe(1);
  });
});

describe("theme appearance", () => {
  test("a bare token map keeps the current appearance, and setTheme reuses one stylesheet", () => {
    const h = make({ theme: { appearance: "dark" } });
    const dark = h.view.dom.className;
    h.setTheme({ bg: "#000" });
    expect(h.view.dom.className).toBe(dark);
    const sheets = document.head.querySelectorAll("style").length;
    for (let i = 0; i < 3; i++) h.setTheme({ appearance: i % 2 ? "dark" : "light", tokens: {} });
    expect(document.head.querySelectorAll("style").length).toBe(sheets);
  });
});

describe("bridge", () => {
  test("a theme pushed before open applies, and a bad command posts an error", () => {
    const events: BridgeEvent[] = [];
    const m = mount(window, (e) => events.push(e));
    m.receive({ type: "theme", theme: { appearance: "dark", tokens: { bg: "#123456" } } });
    m.receive({ type: "open", contents: "x" });
    expect(document.querySelector<HTMLElement>(".cm-editor")!.style.getPropertyValue("--bg")).toBe("#123456");
    m.receive({ type: "reveal", range: { start: 1 } as never });
    m.receive({ type: "open", contents: 5 as never });
    expect(events.some((e) => e.type === "error")).toBe(true);
    m.destroy();
  });

  test("a reopened editor with unsaved edits is dirty, and scrollToCursor is accepted", () => {
    const events: BridgeEvent[] = [];
    const m = mount(window, (e) => events.push(e));
    m.receive({ type: "open", contents: "edited", saved: "disk", language: "a.js" });
    m.receive({ type: "markSaved" });
    m.receive({ type: "scrollToCursor" });
    expect(events.filter((e) => e.type === "error")).toEqual([]);
    m.receive({ type: "getContents", id: "2" });
    expect(events.at(-1)).toEqual({ type: "contents", id: "2", contents: "edited" });
    m.destroy();
  });

  test("open, edit, save and getContents round-trip as JSON events", () => {
    const events: BridgeEvent[] = [];
    const m = mount(window, (e) => events.push(e));
    expect(events).toEqual([{ type: "ready" }]);
    m.receive({ type: "open", contents: "x", language: "a.js" });
    const view = document.querySelector<HTMLElement>(".cm-content")!;
    expect(view).toBeTruthy();
    m.receive({ type: "setContents", contents: "y" });
    m.receive({ type: "getContents", id: "1" });
    expect(events.at(-1)).toEqual({ type: "contents", id: "1", contents: "y" });
    expect(() => JSON.stringify(events)).not.toThrow();
    m.destroy();
    expect(document.querySelector(".cm-editor")).toBeNull();
  });

  test("probe reports the marked lines, selection and dirty flag, and null without an editor", () => {
    const m = mount(window, () => {});
    expect(m.probe()).toBeNull();
    m.receive({ type: "open", contents: "a\nb\nc\nd", language: "a.js", range: { start: 2, end: 3 } });
    let p = m.probe()!;
    expect(p.markedLines).toEqual(["b", "c"]);
    expect(p.lineCount).toBe(4);
    expect(p.dirty).toBe(false);
    m.receive({ type: "setContents", contents: "a" });
    p = m.probe()!;
    expect(p.markedLines).toEqual([]);
    expect(p.lineCount).toBe(1);
    m.receive({ type: "diff", original: "a", modified: "b" });
    expect(m.probe()).toBeNull();
    m.destroy();
  });
});

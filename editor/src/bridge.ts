// A host-agnostic bridge for web views (iOS WKWebView): `mount(window, post)` reports events to
// `post` as JSON-safe objects, and the host drives the editor with `receive(command)` (also on
// `window.harnessEditor`). The native side decides how `post` travels, for example
// webkit.messageHandlers.<name>.postMessage, and how commands arrive.

import { EditorView } from "@codemirror/view";
import { createDiffEditor, createEditor, type DiffEditorHandle, type EditorHandle, type LineRange } from "./editor";
import type { ThemeInput } from "./theme";

export type BridgeCommand =
  | { type: "open"; contents: string; language?: string; theme?: ThemeInput; range?: LineRange; readOnly?: boolean; saved?: string }
  | { type: "diff"; original: string; modified: string; language?: string; theme?: ThemeInput }
  | { type: "theme"; theme: ThemeInput }
  | { type: "reveal"; range: LineRange }
  | { type: "setContents"; contents: string }
  | { type: "markSaved"; contents?: string }
  | { type: "focus" }
  | { type: "scrollToCursor" }
  | { type: "getContents"; id?: string };

export type BridgeEvent =
  | { type: "ready" }
  | { type: "change"; contents: string; dirty: boolean }
  | { type: "dirty"; dirty: boolean }
  | { type: "save"; contents: string }
  | { type: "blur" }
  | { type: "error"; message: string }
  | { type: "contents"; id?: string; contents: string };

/** What the debug state probe reads from the page (ios/HarnessKit DebugState.EditorState). */
export interface BridgeProbe {
  markedLines: string[];
  selection: { anchor: number; head: number };
  dirty: boolean;
  scrollY: number;
  lineCount: number;
}

export interface Mounted {
  receive(command: BridgeCommand): void;
  /** The editor's state for the debug probe; null while no editor (or only a diff) is open. */
  probe(): BridgeProbe | null;
  destroy(): void;
}

export function mount(win: Window, post: (event: BridgeEvent) => void, parent?: HTMLElement): Mounted {
  const root = parent ?? win.document.body;
  let editor: EditorHandle | undefined;
  let diff: DiffEditorHandle | undefined;
  let offs: Array<() => void> = [];
  /** The last theme pushed, for an editor opened after it. */
  let lastTheme: ThemeInput | undefined;

  const clear = () => {
    for (const off of offs) off();
    offs = [];
    editor?.destroy();
    diff?.destroy();
    editor = diff = undefined;
    root.replaceChildren();
  };

  const mounted: Mounted = {
    receive(cmd) {
      try {
        dispatch(cmd);
      } catch (error) {
        post({ type: "error", message: error instanceof Error ? error.message : String(error) });
      }
    },
    probe() {
      if (!editor) return null;
      const { selection, doc } = editor.view.state;
      return {
        markedLines: Array.from(root.querySelectorAll(".cm-revealed-line"), (el) => el.textContent ?? ""),
        selection: { anchor: selection.main.anchor, head: selection.main.head },
        dirty: editor.isDirty(),
        scrollY: Math.round(win.scrollY || 0),
        lineCount: doc.lines,
      };
    },
    destroy: clear,
  };
  const dispatch = (cmd: BridgeCommand) => {
      switch (cmd.type) {
        case "open": {
          if (cmd.theme) lastTheme = cmd.theme;
          clear();
          const e = createEditor(root, { ...cmd, theme: cmd.theme ?? lastTheme });
          editor = e;
          offs.push(
            e.onChange((contents) => post({ type: "change", contents, dirty: e.isDirty() })),
            e.onDirty((dirty) => post({ type: "dirty", dirty })),
            e.onSave((contents) => post({ type: "save", contents })),
            e.onBlur(() => post({ type: "blur" })),
          );
          break;
        }
        case "diff":
          if (cmd.theme) lastTheme = cmd.theme;
          clear();
          diff = createDiffEditor(root, { ...cmd, theme: cmd.theme ?? lastTheme });
          break;
        case "theme":
          lastTheme = cmd.theme;
          editor?.setTheme(cmd.theme);
          diff?.setTheme(cmd.theme);
          break;
        case "reveal":
          editor?.reveal(cmd.range);
          break;
        case "setContents":
          editor?.setContents(cmd.contents);
          break;
        case "markSaved":
          editor?.markSaved(cmd.contents);
          break;
        case "focus":
          editor?.focus();
          break;
        case "scrollToCursor":
          // The keyboard came up over the caret.
          if (editor) editor.view.dispatch({ effects: EditorView.scrollIntoView(editor.view.state.selection.main.head, { y: "nearest", yMargin: 24 }) });
          break;
        case "getContents":
          post({ type: "contents", id: cmd.id, contents: editor?.getContents() ?? diff?.getContents() ?? "" });
          break;
      }
  };
  (win as unknown as { harnessEditor?: Mounted }).harnessEditor = mounted;
  post({ type: "ready" });
  return mounted;
}

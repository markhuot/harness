// A host-agnostic bridge for web views (iOS WKWebView): `mount(window, post)` reports events to
// `post` as JSON-safe objects, and the host drives the editor with `receive(command)` (also on
// `window.harnessEditor`). The native side decides how `post` travels, for example
// webkit.messageHandlers.<name>.postMessage, and how commands arrive.

import { createDiffEditor, createEditor, type DiffEditorHandle, type EditorHandle, type LineRange } from "./editor";
import type { ThemeInput } from "./theme";

export type BridgeCommand =
  | { type: "open"; contents: string; language?: string; theme?: ThemeInput; range?: LineRange; readOnly?: boolean }
  | { type: "diff"; original: string; modified: string; language?: string; theme?: ThemeInput }
  | { type: "theme"; theme: ThemeInput }
  | { type: "reveal"; range: LineRange }
  | { type: "setContents"; contents: string }
  | { type: "markSaved" }
  | { type: "focus" }
  | { type: "getContents"; id?: string };

export type BridgeEvent =
  | { type: "ready" }
  | { type: "change"; contents: string; dirty: boolean }
  | { type: "dirty"; dirty: boolean }
  | { type: "save"; contents: string }
  | { type: "blur" }
  | { type: "contents"; id?: string; contents: string };

export interface Mounted {
  receive(command: BridgeCommand): void;
  destroy(): void;
}

export function mount(win: Window, post: (event: BridgeEvent) => void, parent?: HTMLElement): Mounted {
  const root = parent ?? win.document.body;
  let editor: EditorHandle | undefined;
  let diff: DiffEditorHandle | undefined;
  let offs: Array<() => void> = [];

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
      switch (cmd.type) {
        case "open": {
          clear();
          const e = createEditor(root, cmd);
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
          clear();
          diff = createDiffEditor(root, cmd);
          break;
        case "theme":
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
          editor?.markSaved();
          break;
        case "focus":
          editor?.focus();
          break;
        case "getContents":
          post({ type: "contents", id: cmd.id, contents: editor?.getContents() ?? diff?.getContents() ?? "" });
          break;
      }
    },
    destroy: clear,
  };
  (win as unknown as { harnessEditor?: Mounted }).harnessEditor = mounted;
  post({ type: "ready" });
  return mounted;
}

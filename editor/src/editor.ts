// The file editor: @pierre/diffs' File with its edit mode, behind a framework-free handle. The Mac
// renderer imports this; iOS loads the same code from a bundled web view through bridge.ts. Code is
// highlighted by the same Shiki pipeline as the Changes tab.

import { VirtualizedFile, Virtualizer, type FileContents } from "@pierre/diffs";
import { Editor } from "@pierre/diffs/edit";
import { MAX_HIGHLIGHT_LINES, countLines, createBaseline, clampRange, offsetOf, positionOf, selectionLines, type LineRange } from "./doc";
import { PLAIN, resolveLanguage } from "./language";
import { applyTokens, chromeCSS, normalizeTheme, shikiThemes, type EditorTheme, type ThemeInput, type TokenMap } from "./theme";

export type { LineRange } from "./doc";

export interface EditorOptions {
  contents: string;
  /** A file path or name ("src/a.ts", "Dockerfile"), an extension ("ts") or a language name ("typescript"); unknown is plain text. */
  language?: string;
  theme?: ThemeInput;
  /** Lines to reveal on open */
  range?: LineRange;
  readOnly?: boolean;
  /** What's on disk when it differs from `contents`: an editor reopened with unsaved edits opens dirty. */
  saved?: string;
  /** What scrolls the file: the box it's in (default) or the whole page (the iOS web view, where UIKit owns the scroll view). */
  scroller?: "parent" | "page";
  /** Grammars the bundle carries (iOS); a file in another language is plain text. Default: every Shiki grammar. */
  languages?: ReadonlySet<string>;
}

export interface EditorHandle {
  setTheme(theme: ThemeInput): void;
  reveal(range: LineRange): void;
  getContents(): string;
  /** Replaces the document and treats it as saved: a clean reload of what's on disk. */
  setContents(contents: string): void;
  isDirty(): boolean;
  /** Marks `contents` (what onSave handed out; default: the document now) as saved. Stays dirty if the document has moved on since. */
  markSaved(contents?: string): void;
  focus(): void;
  setReadOnly(readOnly: boolean): void;
  /** Puts the cursor at a document offset (a selection to `head` when given) and scrolls it into view. */
  setSelection(anchor: number, head?: number): void;
  /** The lines the selection covers (1-based, inclusive), or null for a caret. */
  getSelectionLines(): LineRange | null;
  /** Scrolls the caret's line into view (the keyboard came up over it). */
  scrollToCursor(): void;
  /** For the debug probe and the app checks: the page's own view of the editor. */
  probe(): EditorProbe;
  onChange(fn: (contents: string) => void): () => void;
  /** Fires when the dirty state flips, not on every edit. */
  onDirty(fn: (dirty: boolean) => void): () => void;
  /** Cmd/Ctrl+S inside the editor, with the contents to save. */
  onSave(fn: (contents: string) => void): () => void;
  onBlur(fn: () => void): () => void;
  destroy(): void;
}

export interface EditorProbe {
  /** The text of each revealed line */
  markedLines: string[];
  selection: { anchor: number; head: number };
  dirty: boolean;
  scrollY: number;
  lineCount: number;
}

function emitter<A extends unknown[]>() {
  const fns = new Set<(...args: A) => void>();
  return {
    on(fn: (...args: A) => void) {
      fns.add(fn);
      return () => void fns.delete(fn);
    },
    emit(...args: A) {
      for (const fn of [...fns]) fn(...args);
    },
  };
}

/** The shadow root @pierre/diffs draws a file into. */
export const shadowOf = (parent: ParentNode): ShadowRoot | null => parent.querySelector("diffs-container")?.shadowRoot ?? null;

/** How many frames a reveal keeps its scroll position asserted while the file lays out (about half a second). */
const SETTLE_FRAMES = 30;

let keys = 0;

export function createEditor(parent: HTMLElement, options: EditorOptions): EditorHandle {
  const page = options.scroller === "page";
  const win = parent.ownerDocument.defaultView ?? window;
  const scrollEl = (): HTMLElement => (page ? (parent.ownerDocument.scrollingElement as HTMLElement) : parent);
  const viewportHeight = () => (page ? win.innerHeight : parent.clientHeight);

  let theme: EditorTheme = normalizeTheme(options.theme);
  let tokens: TokenMap | undefined;
  const syncTokens = () => {
    applyTokens(parent, theme.tokens, tokens);
    tokens = theme.tokens;
  };
  syncTokens();

  let contents = options.contents;
  let readOnly = !!options.readOnly;
  const base = createBaseline(options.saved ?? options.contents, options.saved !== undefined && options.saved !== options.contents);
  const change = emitter<[string]>();
  const dirtyEv = emitter<[boolean]>();
  const save = emitter<[string]>();
  const blur = emitter<[]>();

  let virtualizer: Virtualizer | undefined;
  let file: VirtualizedFile | undefined;
  let editor: Editor<"file"> | undefined;
  let stopEdit: (() => void) | undefined;
  let marked: LineRange | null = null;
  const language = () => (countLines(contents) > MAX_HIGHLIGHT_LINES ? PLAIN : resolveLanguage(options.language, options.languages));
  const fileName = options.language && /[./\\]/.test(options.language) ? options.language : `file.${options.language ?? "txt"}`;

  /**
   * The editor can't take selections (or report them) until it has drawn the file, and the virtualized
   * file draws on a later frame, so a call that finds it unready is tried again each frame until it takes.
   */
  let generation = 0;
  const whenReady = (fn: () => void, tries = 120) => {
    const mine = generation;
    const attempt = (left: number) => {
      if (mine !== generation) return;
      try {
        fn();
      } catch (error) {
        if (left > 0) requestAnimationFrame(() => attempt(left - 1));
        else console.error(error);
      }
    };
    attempt(tries);
  };
  /**
   * Puts the cursor somewhere. The editor focuses itself to show a selection, and gives focus back
   * badly (typing stops landing after a blur and a refocus), so the cursor is only set where focus is wanted.
   */
  const select = (selections: Parameters<Editor["setSelections"]>[0]) => {
    editor?.setSelections(selections);
    focusing = true;
  };
  /** Focus was asked for, or the editor took it to show a cursor. */
  let focusing = false;
  const focusEditor = () => {
    focusing = true;
    editor?.focus();
  };

  /** Selections and the view state, once the editor has a document (undefined before that). */
  const viewState = () => {
    try {
      return editor?.getViewState();
    } catch {
      return undefined;
    }
  };

  /** The document: `contents` follows every edit (onChange), so it needs nothing from an editor that hasn't drawn yet. */
  const text = () => contents;

  const syncDirty = () => {
    if (base.check(text())) dirtyEv.emit(base.dirty);
  };

  /** Draws the document into a fresh file (and edit session unless read-only), keeping the scroll position. */
  const build = (view?: { selections?: ReturnType<Editor<"file">["getViewState"]>["selections"]; scrollTop: number; focused?: boolean }) => {
    const themes = shikiThemes(theme);
    virtualizer = new Virtualizer();
    virtualizer.setup(page ? parent.ownerDocument : parent);
    generation++;
    file = new VirtualizedFile({ ...themes, disableFileHeader: true, overflow: "scroll", unsafeCSS: chromeCSS }, virtualizer);
    const input: FileContents = { name: fileName, contents, lang: language() as FileContents["lang"], cacheKey: `editor-${++keys}` };
    file.render({ file: input, containerWrapper: parent });
    if (!readOnly) {
      const ed = new Editor<"file">("file", {
        onChange: () => {
          if (marked) {
            marked = null;
            file?.setSelectedLines(null);
          }
          contents = ed.getText();
          syncDirty();
          change.emit(contents);
        },
        onBlur: () => {
          focusing = false;
          blur.emit();
        },
      });
      editor = ed;
      stopEdit = ed.edit(file);
      const selections = view?.selections;
      // The cursor and focus come back only if the editor had focus: an idle one has no cursor worth keeping.
      if (view?.focused) {
        whenReady(() => {
          if (selections?.length) select(selections as never);
          focusEditor();
        });
      }
    }
    if (view) scrollEl().scrollTop = view.scrollTop;
    if (marked && file) file.setSelectedLines(marked);
  };

  const teardown = () => {
    generation++;
    if (editor) stopEdit?.();
    editor = stopEdit = undefined;
    file?.cleanUp();
    virtualizer?.cleanUp();
    file = virtualizer = undefined;
    parent.replaceChildren();
  };

  /** Draws the document again (new text, or a read-only change), keeping the selection and scroll position. */
  const rebuild = (next?: string) => {
    const view = { selections: viewState()?.selections, scrollTop: scrollEl().scrollTop, focused: !!shadowOf(parent)?.activeElement };
    teardown();
    if (next !== undefined) contents = next;
    build(view);
  };

  /** Scrolls so that `line` (1-based) sits in the middle (`center`) or just inside the viewport. */
  const scrollTo = (line: number, mode: "center" | "nearest") => {
    const pos = file?.getLinePosition(line);
    if (!pos) return;
    const el = scrollEl();
    const view = viewportHeight();
    const top = el.scrollTop;
    if (mode === "center") el.scrollTop = Math.max(0, pos.top + pos.height / 2 - view / 2);
    else if (pos.top < top + 24) el.scrollTop = Math.max(0, pos.top - 24);
    else if (pos.top + pos.height > top + view - 24) el.scrollTop = pos.top + pos.height - view + 24;
  };

  const revealLines = (range: LineRange) => {
    const { start, end } = clampRange(range, countLines(text()));
    marked = { start, end };
    file?.setSelectedLines(marked);
    const middle = Math.floor((start + end) / 2);
    scrollTo(middle, "center");
    // The virtualizer keeps the view anchored while the file lays out (its first measure can shift it a
    // whole file's height), so the scroll is asserted again over the next frames, until the reader moves it.
    let frames = 0;
    let moved = false;
    const stop = () => (moved = true);
    for (const type of ["wheel", "touchstart", "keydown", "pointerdown"]) parent.addEventListener(type, stop, { once: true, capture: true });
    const settle = () => {
      if (moved || mine !== generation || marked?.start !== start || ++frames > SETTLE_FRAMES) return;
      scrollTo(middle, "center");
      requestAnimationFrame(settle);
    };
    const mine = generation;
    requestAnimationFrame(settle);
  };

  // Cmd/Ctrl+S inside the editor (the keystroke is composed through the shadow root to the parent).
  const onKey = (e: KeyboardEvent) => {
    if (e.key.toLowerCase() !== "s" || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
    e.preventDefault();
    if (!readOnly) save.emit(text());
  };
  parent.addEventListener("keydown", onKey);

  build();
  if (options.range) {
    revealLines(options.range);
  }

  return {
    setTheme(input) {
      const was = JSON.stringify(shikiThemes(theme));
      theme = { ...theme, ...normalizeTheme(input) };
      syncTokens();
      // Colors that didn't change need no redraw (the page's own tokens are CSS variables, live already).
      if (!file || JSON.stringify(shikiThemes(theme)) === was) return;
      // Redrawn from scratch: a file re-rendered in place stops taking keystrokes.
      rebuild();
    },
    reveal: revealLines,
    getContents: text,
    setContents(next) {
      const flipped = base.mark(next, next);
      rebuild(next);
      if (flipped) dirtyEv.emit(false);
    },
    isDirty: () => base.dirty,
    markSaved(saved) {
      if (base.mark(saved ?? text(), text())) dirtyEv.emit(base.dirty);
    },
    focus: () => whenReady(focusEditor),
    setReadOnly(on) {
      if (on === readOnly) return;
      readOnly = on;
      rebuild();
    },
    setSelection(anchor, head = anchor) {
      const t = text();
      const [a, b] = [positionOf(t, anchor), positionOf(t, head)];
      const forward = anchor <= head;
      whenReady(() => select([{ start: forward ? a : b, end: forward ? b : a, direction: anchor === head ? "none" : forward ? "forward" : "backward" }]));
    },
    getSelectionLines: () => selectionLines(viewState()?.selections?.[0]),
    scrollToCursor() {
      const sel = viewState()?.selections?.[0];
      if (sel) scrollTo(sel.end.line + 1, "nearest");
    },
    probe() {
      const t = text();
      const sel = viewState()?.selections?.[0];
      const root = shadowOf(parent);
      return {
        markedLines: Array.from(root?.querySelectorAll("[data-line][data-selected-line]") ?? [], (el) => el.textContent ?? ""),
        selection: sel ? { anchor: offsetOf(t, sel.direction === -1 ? sel.end : sel.start), head: offsetOf(t, sel.direction === -1 ? sel.start : sel.end) } : { anchor: 0, head: 0 },
        dirty: base.dirty,
        scrollY: Math.round(scrollEl().scrollTop || 0),
        lineCount: countLines(t),
      };
    },
    onChange: change.on,
    onDirty: dirtyEv.on,
    onSave: save.on,
    onBlur: blur.on,
    destroy() {
      parent.removeEventListener("keydown", onKey);
      teardown();
      applyTokens(parent, undefined, tokens);
    },
  };
}

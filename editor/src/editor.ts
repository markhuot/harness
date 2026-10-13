// A CodeMirror 6 editor and merge view with a framework-free handle. The Mac renderer imports this;
// iOS loads the same code from a bundled web view through bridge.ts.

import { Annotation, Compartment, EditorState, StateEffect, StateField, Text, Transaction, type Extension } from "@codemirror/state";
import { Decoration, EditorView, drawSelection, highlightActiveLine, keymap, lineNumbers, type DecorationSet } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentOnInput } from "@codemirror/language";
import { MergeView } from "@codemirror/merge";
import { languageExtension, resolveLanguage } from "./language";
import { applyTokens, editorTheme, highlighting, normalizeTheme, type EditorTheme, type ThemeInput, type TokenMap } from "./theme";

/** A 1-based, inclusive line range. */
export interface LineRange {
  start: number;
  end: number;
}

export interface EditorOptions {
  contents: string;
  /** A file name or extension ("a.ts", "ts") or a language name ("typescript"); unknown is plain text. */
  language?: string;
  theme?: ThemeInput;
  /** Lines to reveal on open */
  range?: LineRange;
  readOnly?: boolean;
  /** What's on disk when it differs from `contents`: an editor reopened with unsaved edits opens dirty. */
  saved?: string;
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
  onChange(fn: (contents: string) => void): () => void;
  /** Fires when the dirty state flips, not on every edit. */
  onDirty(fn: (dirty: boolean) => void): () => void;
  /** Cmd/Ctrl+S inside the editor, with the contents to save. */
  onSave(fn: (contents: string) => void): () => void;
  onBlur(fn: () => void): () => void;
  destroy(): void;
  readonly view: EditorView;
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

// --- reveal highlight -----------------------------------------------------------------------

const setReveal = StateEffect.define<LineRange | null>();
/** A reload of what's on disk: edits that don't clear the highlight, since the lines it marks mostly stay put. */
const reload = Annotation.define<boolean>();
const lineMark = Decoration.line({ class: "cm-revealed-line" });

function clampRange(doc: Text, range: LineRange): LineRange {
  const first = Number.isFinite(range.start) ? Math.floor(range.start) : 1;
  const last = Number.isFinite(range.end) ? Math.floor(range.end) : first;
  const start = Math.min(Math.max(1, first), doc.lines);
  const end = Math.min(Math.max(start, last), doc.lines);
  return { start, end };
}

/** Marks the revealed lines until the next edit (a reload keeps them, moved along with the text). */
const revealField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) {
      if (e.is(setReveal)) {
        if (!e.value) return Decoration.none;
        const { start, end } = clampRange(tr.state.doc, e.value);
        const marks = [];
        for (let n = start; n <= end; n++) marks.push(lineMark.range(tr.state.doc.line(n).from));
        return Decoration.set(marks);
      }
    }
    if (!tr.docChanged) return deco;
    return tr.annotation(reload) ? deco.map(tr.changes) : Decoration.none;
  },
  provide: (f) => EditorView.decorations.from(f),
});

function revealIn(view: EditorView, range: LineRange) {
  const { start, end } = clampRange(view.state.doc, range);
  const first = view.state.doc.line(start);
  const last = view.state.doc.line(end);
  // An empty cursor at the start, never a selection the first keystroke would replace.
  view.dispatch({
    selection: { anchor: first.from },
    effects: [
      setReveal.of({ start, end }),
      EditorView.scrollIntoView(first.from + Math.floor((last.to - first.from) / 2), { y: "center" }),
    ],
  });
}

// --- shared setup ---------------------------------------------------------------------------

function baseExtensions(language: string | undefined, dark: boolean) {
  const lang = new Compartment();
  const theme = new Compartment();
  const readOnly = new Compartment();
  return {
    lang,
    theme,
    readOnly,
    extensions: [
      lang.of(languageExtension(resolveLanguage(language))),
      theme.of(editorTheme(dark)),
      readOnly.of([]),
      highlighting,
    ] as Extension[],
  };
}

const readOnlyExt = (on: boolean): Extension => (on ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []);

/** Keeps the token map on the editor's own element and the dark flag in the theme compartment. */
function themeController(host: () => HTMLElement[], initialDark: boolean, setDark: (dark: boolean) => void) {
  let tokens: TokenMap | undefined;
  let dark = initialDark;
  return (input: ThemeInput | undefined) => {
    const theme: EditorTheme = normalizeTheme(input);
    for (const el of host()) applyTokens(el, theme.tokens, tokens);
    tokens = theme.tokens;
    // A bare token map says nothing about appearance: keep the current one.
    const next = theme.appearance === undefined ? dark : theme.appearance === "dark";
    if (next !== dark) {
      dark = next;
      setDark(dark);
    }
  };
}

// --- editor ---------------------------------------------------------------------------------

type Eol = "\r\n" | "\n" | "\r";

/**
 * The line break the document is split and joined on: the file's only one, or the most common when it
 * mixes them (CRLF, then LF, win a tie). A break of another kind stays in its line as a plain character,
 * so saving writes back exactly what was read. Null for a file with no line break at all.
 */
export function detectEol(contents: string): Eol | null {
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  for (let i = 0; i < contents.length; i++) {
    const ch = contents.charCodeAt(i);
    if (ch === 13) {
      if (contents.charCodeAt(i + 1) === 10) {
        crlf++;
        i++;
      } else cr++;
    } else if (ch === 10) lf++;
  }
  if (crlf + lf + cr === 0) return null;
  if (crlf >= lf && crlf >= cr) return "\r\n";
  return lf >= cr ? "\n" : "\r";
}
const eolExtension = (eol: Eol | null): Extension => (eol ? EditorState.lineSeparator.of(eol) : []);

export function createEditor(parent: HTMLElement, options: EditorOptions): EditorHandle {
  const initial = normalizeTheme(options.theme);
  const base = baseExtensions(options.language, initial.appearance === "dark");
  // A file keeps its line breaks: the document is split and joined on them, so saving writes what was read.
  let eol = detectEol(options.contents);
  const eolCompartment = new Compartment();
  let saved: Text = EditorState.create({ doc: options.saved ?? options.contents }).doc;
  let dirty = options.saved !== undefined && options.saved !== options.contents;
  /** True while setContents replaces the document, so a reload isn't reported as an edit. */
  let quiet = false;
  const change = emitter<[string]>();
  const dirtyEv = emitter<[boolean]>();
  const save = emitter<[string]>();
  const blur = emitter<[]>();

  const syncDirty = (view: EditorView) => {
    const now = !view.state.doc.eq(saved);
    if (now !== dirty) {
      dirty = now;
      dirtyEv.emit(dirty);
    }
  };

  const view: EditorView = new EditorView({
    parent,
    state: EditorState.create({
      doc: options.contents,
      extensions: [
        eolCompartment.of(eolExtension(eol)),
        lineNumbers(),
        history(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        highlightActiveLine(),
        revealField,
        ...base.extensions,
        // Code, not prose: no autocorrect, smart quotes, capitalization or spell check on a touch keyboard.
        EditorView.contentAttributes.of({
          autocorrect: "off",
          autocapitalize: "off",
          autocomplete: "off",
          spellcheck: "false",
        }),
        keymap.of([
          {
            key: "Mod-s",
            preventDefault: true,
            run: () => {
              if (view.state.readOnly) return false;
              save.emit(view.state.sliceDoc());
              return true;
            },
          },
          indentWithTab,
          ...historyKeymap,
          ...defaultKeymap,
        ]),
        EditorView.domEventHandlers({
          blur: () => {
            blur.emit();
          },
        }),
        EditorView.updateListener.of((u) => {
          if (!u.docChanged || quiet) return;
          syncDirty(u.view);
          change.emit(u.state.sliceDoc());
        }),
      ],
    }),
  });
  view.dispatch({ effects: base.readOnly.reconfigure(readOnlyExt(!!options.readOnly)) });

  const apply = themeController(
    () => [view.dom],
    initial.appearance === "dark",
    (dark) => view.dispatch({ effects: base.theme.reconfigure(editorTheme(dark)) }),
  );
  apply(initial);
  if (options.range) revealIn(view, options.range);

  return {
    view,
    setTheme: apply,
    reveal: (range) => revealIn(view, range),
    getContents: () => view.state.sliceDoc(),
    setContents(contents) {
      const next = detectEol(contents);
      if (next !== eol) {
        // The file's line breaks changed on disk: switch before the text goes in, so it splits right.
        eol = next;
        view.dispatch({ effects: eolCompartment.reconfigure(eolExtension(eol)) });
      }
      // Only the span that differs is replaced, so the cursor, scroll position and highlight stay where
      // they are. Compared as the document counts it, a line break being one character.
      // NUL stands for the document's line break (the service refuses files that hold one), so a break of
      // another kind inside a mixed file's line isn't mistaken for a new line.
      const current = view.state.doc.sliceString(0, undefined, "\0");
      const incoming = eol ? contents.split(eol).join("\0") : contents;
      let from = 0;
      const max = Math.min(current.length, incoming.length);
      while (from < max && current.charCodeAt(from) === incoming.charCodeAt(from)) from++;
      let tail = 0;
      while (tail < max - from && current.charCodeAt(current.length - 1 - tail) === incoming.charCodeAt(incoming.length - 1 - tail)) tail++;
      quiet = true;
      try {
        // Not in undo history: Cmd+Z must never bring back the buffer this reload replaced.
        view.dispatch({
          changes: { from, to: current.length - tail, insert: Text.of(incoming.slice(from, incoming.length - tail).split("\0")) },
          annotations: [Transaction.addToHistory.of(false), reload.of(true)],
        });
      } finally {
        quiet = false;
      }
      saved = view.state.doc;
      syncDirty(view);
    },
    isDirty: () => dirty,
    markSaved(contents) {
      saved = contents === undefined ? view.state.doc : EditorState.create({ doc: contents }).doc;
      syncDirty(view);
    },
    focus: () => view.focus(),
    setReadOnly: (on) => view.dispatch({ effects: base.readOnly.reconfigure(readOnlyExt(on)) }),
    onChange: change.on,
    onDirty: dirtyEv.on,
    onSave: save.on,
    onBlur: blur.on,
    destroy: () => view.destroy(),
  };
}

// --- diff -----------------------------------------------------------------------------------

export interface DiffEditorOptions {
  original: string;
  modified: string;
  language?: string;
  theme?: ThemeInput;
}

export interface DiffEditorHandle {
  setTheme(theme: ThemeInput): void;
  getContents(): string;
  getOriginal(): string;
  destroy(): void;
  readonly view: MergeView;
}

/** Side-by-side diff of two texts, read-only: the viewer for a file against another version. */
export function createDiffEditor(parent: HTMLElement, options: DiffEditorOptions): DiffEditorHandle {
  const initial = normalizeTheme(options.theme);
  const sides = [baseExtensions(options.language, initial.appearance === "dark"), baseExtensions(options.language, initial.appearance === "dark")] as const;
  const side = (i: 0 | 1, doc: string) => ({
    doc,
    extensions: [lineNumbers(), ...sides[i].extensions, readOnlyExt(true)],
  });
  const view = new MergeView({
    parent,
    a: side(0, options.original),
    b: side(1, options.modified),
    highlightChanges: true,
    gutter: true,
  });
  const apply = themeController(
    () => [view.dom],
    initial.appearance === "dark",
    (dark) => {
      view.a.dispatch({ effects: sides[0].theme.reconfigure(editorTheme(dark)) });
      view.b.dispatch({ effects: sides[1].theme.reconfigure(editorTheme(dark)) });
    },
  );
  apply(initial);
  return {
    view,
    setTheme: apply,
    getContents: () => view.b.state.doc.toString(),
    getOriginal: () => view.a.state.doc.toString(),
    destroy: () => view.destroy(),
  };
}

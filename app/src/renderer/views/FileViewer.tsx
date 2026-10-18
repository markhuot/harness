// The file pane's renderers (views/FilePane.tsx), on the @pierre/diffs editor in editor/: FileEditor
// is an editable file with the linked lines highlighted, FileChanges its uncommitted diff, side by
// side. Loaded lazily with the pane, so the editor stays out of the main bundle.
//
// Code is colored by the Shiki theme the Changes tab uses (useSyntaxTheme); the editor's chrome takes
// its colors from the CSS variables on <html>, so a theme change recolors it in place.

import { useEffect, useRef } from "react";
import { createDiffEditor, createEditor, type DiffEditorHandle, type EditorHandle } from "@harness/editor";
import type { FileDiff as FileDiffData } from "@harness/shared";
import { useSyntaxTheme } from "../state/syntax";

const Plain = ({ text }: { text: string }) => (
  <pre className="file-plain">
    <code>{text}</code>
  </pre>
);

export interface FileEditorProps {
  name: string;
  /** What the editor opens with; later reloads go through the handle (setContents) */
  contents: string;
  /** The highlighted lines (1-based, inclusive), or null for none */
  range: { start: number; end: number } | null;
  readOnly: boolean;
  /** Long lines wrap (else they scroll sideways) */
  wrap: boolean;
  /** The editor is up (its handle), or gone (null) */
  onHandle: (handle: EditorHandle | null) => void;
  onDirty: (dirty: boolean) => void;
  /** Cmd+S inside the editor */
  onSave: () => void;
  onBlur: () => void;
  /** The editor is going away (the pane shows another file, or closes): what it held */
  onDispose: (last: { contents: string; dirty: boolean }) => void;
}

/** One file in the editor. Key it by file: a new file is a new editor, and the old one reports its edits (onDispose). */
export function FileEditor(props: FileEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const handle = useRef<EditorHandle | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const syntax = useSyntaxTheme();
  const theme = { appearance: syntax.appearance, syntaxTheme: syntax.name };
  const rangeKey = props.range ? `${props.range.start}-${props.range.end}` : "";

  useEffect(() => {
    const p = latest.current;
    const h = createEditor(host.current!, { contents: p.contents, language: p.name, theme, range: p.range ?? undefined, readOnly: p.readOnly, wrap: p.wrap });
    handle.current = h;
    // For the app checks (the Mac tests), which read and drive the editor through it.
    (host.current as HTMLElement & { harnessEditor?: EditorHandle }).harnessEditor = h;
    h.onDirty((d) => latest.current.onDirty(d));
    h.onSave(() => latest.current.onSave());
    h.onBlur(() => latest.current.onBlur());
    p.onHandle(h);
    return () => {
      const last = { contents: h.getContents(), dirty: h.isDirty() };
      h.destroy();
      handle.current = null;
      latest.current.onHandle(null);
      latest.current.onDispose(last);
    };
  }, []);
  useEffect(() => handle.current?.setTheme(theme), [syntax.name, syntax.appearance]);
  useEffect(() => handle.current?.setReadOnly(props.readOnly), [props.readOnly]);
  useEffect(() => handle.current?.setWrap(props.wrap), [props.wrap]);
  // A link moving the pane to other lines (the first reveal happens when the editor is created).
  const revealed = useRef(rangeKey);
  useEffect(() => {
    if (revealed.current === rangeKey) return;
    revealed.current = rangeKey;
    if (props.range) handle.current?.reveal(props.range);
  }, [rangeKey]);

  return <div ref={host} className="file-editor" data-testid="file-editor" />;
}

export function FileChanges({ name, diff }: { name: string; diff: FileDiffData }) {
  const host = useRef<HTMLDivElement>(null);
  const handle = useRef<DiffEditorHandle | null>(null);
  const syntax = useSyntaxTheme();
  const theme = { appearance: syntax.appearance, syntaxTheme: syntax.name };
  // With both sides in hand the diff view has the whole file; a side that's binary or too big to
  // send leaves just git's patch.
  const whole = diff.newContents !== null && (diff.oldContents !== null || /^new file mode/m.test(diff.patch));
  useEffect(() => {
    if (!whole) return;
    const h = createDiffEditor(host.current!, { original: diff.oldContents ?? "", modified: diff.newContents ?? "", language: name, theme });
    handle.current = h;
    return () => {
      h.destroy();
      handle.current = null;
    };
  }, [whole, name, diff.oldContents, diff.newContents]);
  useEffect(() => handle.current?.setTheme(theme), [syntax.name, syntax.appearance, whole, name, diff.oldContents, diff.newContents]);
  if (!whole) return <Plain text={diff.patch} />;
  return <div ref={host} className="file-diff" data-testid="file-diff" />;
}

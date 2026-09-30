// The file pane's renderers (views/FilePane.tsx), on @pierre/diffs like the Git tab and chat code:
// FileCode draws a whole file with line numbers and the linked lines highlighted, FileChanges its
// uncommitted diff. Loaded lazily with the pane, so the diff renderer stays out of the main bundle.
//
// Both wait for the syntax theme (both appearance slots) and the file's language before mounting,
// so the code shows highlighted in one pass, the way CodeDiff.tsx does.

import { Component, useEffect, useMemo, useState, type ReactNode } from "react";
import { getFiletypeFromFileName, type SelectedLineRange } from "@pierre/diffs";
import { File, MultiFileDiff, PatchDiff, type FileDiffOptions, type FileOptions } from "@pierre/diffs/react";
import type { FileDiff as FileDiffData } from "@harness/shared";
import { loadHighlighter, useSyntaxTheme, type SyntaxTheme } from "../state/syntax";

/** Past this many lines a file shows as plain text: tokenizing it would stall the renderer. */
const MAX_TOKENIZE_LINES = 20_000;

// The pane's own background rather than the Shiki theme's, like the rest of the app; the add /
// delete tints and the selected-line highlight mix from it.
const SURFACE = ":host { --diffs-light-bg: var(--bg); --diffs-dark-bg: var(--bg); }";

/** True once the theme slots and `name`'s language are in the shared highlighter. */
function useHighlighterReady(syntax: SyntaxTheme, names: string[]): boolean {
  const [ready, setReady] = useState<string | null>(null);
  const key = `${syntax.name}\u0000${names.join("\u0000")}`;
  useEffect(() => {
    let live = true;
    const langs = [...new Set(names.map((n) => getFiletypeFromFileName(n)))];
    Promise.all([loadHighlighter(syntax.theme.light, "text"), loadHighlighter(syntax.theme.dark, "text"), ...langs.map((l) => loadHighlighter(syntax.name, l))]).then(
      () => live && setReady(key),
      () => live && setReady(key), // a theme failed: useSyntaxTheme falls back and this runs again; show it plain meanwhile
    );
    return () => void (live = false);
  }, [key]);
  // After the first load a theme change keeps what's shown and recolors in place.
  return ready !== null;
}

class Boundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

const Plain = ({ text }: { text: string }) => (
  <pre className="file-plain">
    <code>{text}</code>
  </pre>
);

export interface FileCodeProps {
  name: string;
  contents: string;
  /** The highlighted lines (1-based, inclusive), or null for none */
  selected: { start: number; end: number } | null;
  /** The user picked lines by clicking or dragging the line numbers (null: cleared) */
  onSelect: (range: { start: number; end: number } | null) => void;
  /** After each render of the code (mount and updates), to scroll to the selection */
  onRendered: () => void;
}

export function FileCode({ name, contents, selected, onSelect, onRendered }: FileCodeProps) {
  const syntax = useSyntaxTheme();
  const ready = useHighlighterReady(syntax, [name]);
  const file = useMemo(() => ({ name, contents, cacheKey: `${name}:${contents.length}:${hash(contents)}` }), [name, contents]);
  const options = useMemo<FileOptions<undefined, undefined>>(
    () => ({
      theme: syntax.theme,
      themeType: syntax.themeType,
      overflow: "scroll",
      disableFileHeader: true,
      unsafeCSS: SURFACE,
      tokenizeMaxLength: MAX_TOKENIZE_LINES,
      enableLineSelection: true,
      lineHoverHighlight: "number",
      onLineSelected: (r: SelectedLineRange | null) => onSelect(r ? { start: Math.min(r.start, r.end), end: Math.max(r.start, r.end) } : null),
      onPostRender: (_node: HTMLElement, _instance: unknown, phase: string) => void (phase !== "unmount" && onRendered()),
    }),
    [syntax.name, syntax.themeType, onSelect, onRendered],
  );
  const selectedLines = useMemo(() => (selected ? { start: selected.start, end: selected.end } : null), [selected?.start, selected?.end]);
  if (!ready) return <Plain text={contents} />;
  return (
    <Boundary fallback={<Plain text={contents} />}>
      <File file={file} options={options} selectedLines={selectedLines} />
    </Boundary>
  );
}

export function FileChanges({ name, diff, diffStyle }: { name: string; diff: FileDiffData; diffStyle: "unified" | "split" }) {
  const syntax = useSyntaxTheme();
  const ready = useHighlighterReady(syntax, [name]);
  // With both sides in hand the whole file is there to expand into; a side that's binary or too
  // big to send leaves just git's patch.
  const whole = diff.newContents !== null && (diff.oldContents !== null || /^new file mode/m.test(diff.patch));
  const files = useMemo(
    () => ({
      oldFile: { name, contents: diff.oldContents ?? "", cacheKey: `old:${name}:${hash(diff.oldContents ?? "")}` },
      newFile: { name, contents: diff.newContents ?? "", cacheKey: `new:${name}:${hash(diff.newContents ?? "")}` },
    }),
    [name, diff.oldContents, diff.newContents],
  );
  const options = useMemo<FileDiffOptions<undefined, undefined>>(
    () => ({
      theme: syntax.theme,
      themeType: syntax.themeType,
      diffStyle,
      overflow: "scroll",
      lineDiffType: "word-alt",
      hunkSeparators: whole ? "line-info-basic" : "simple",
      disableFileHeader: true,
      unsafeCSS: SURFACE,
      tokenizeMaxLength: MAX_TOKENIZE_LINES,
    }),
    [syntax.name, syntax.themeType, diffStyle, whole],
  );
  const fallback = <Plain text={diff.patch} />;
  if (!ready) return fallback;
  return (
    <Boundary fallback={fallback}>
      {whole ? <MultiFileDiff {...files} options={options} /> : <PatchDiff patch={diff.patch} options={options} />}
    </Boundary>
  );
}

/** A cheap string hash for the highlighter's cache keys (FNV-1a over UTF-16 units). */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

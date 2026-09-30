// A diff in a chat message, drawn by @pierre/diffs' FileDiff like the Git tab's diff viewer. Loaded
// lazily (Code.tsx) so the diff renderer stays out of the main bundle. Hand-written diffs are cleaned
// up first (normalizePatch); anything that still doesn't parse, or fails to render, shows `fallback`.

import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getFiletypeFromFileName, parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import { FileDiff, type FileDiffOptions } from "@pierre/diffs/react";
import { normalizePatch } from "@harness/shared/state";
import { loadHighlighter, useSyntaxTheme } from "../state/syntax";
import { CopyButton, useNearViewport } from "./Code";

/** The files in a diff block, or [] when it doesn't parse. */
export function diffFiles(text: string): FileDiffMetadata[] {
  const quiet = console.error;
  try {
    console.error = () => {}; // the parser logs the patches it rejects; we fall back instead
    return parsePatchFiles(normalizePatch(text)).flatMap((p) => p.files);
  } catch {
    return [];
  } finally {
    console.error = quiet;
  }
}

// Sit on the code block surface (.md pre's) rather than the Shiki theme's editor background; the
// add / delete tints mix from it the same way the Git tab's do from its background.
const SURFACE = ":host { --diffs-light-bg: var(--bg-sunken); --diffs-dark-bg: var(--bg-sunken); }";

class Boundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export default function CodeDiff({ text, fallback }: { text: string; fallback: ReactNode }) {
  const files = useMemo(() => diffFiles(text), [text]);
  const ref = useRef<HTMLDivElement>(null);
  const near = useNearViewport(ref);
  const syntax = useSyntaxTheme();
  const [ready, setReady] = useState<string | null>(null);

  // Load both theme slots and each file's language before mounting FileDiff, so it renders
  // highlighted in one pass instead of plain-then-colored.
  useEffect(() => {
    if (!near || !files.length || ready === syntax.name) return;
    let live = true;
    const langs = [...new Set(files.map((f) => f.lang ?? getFiletypeFromFileName(f.name)))];
    Promise.all([loadHighlighter(syntax.theme.light, "text"), loadHighlighter(syntax.theme.dark, "text"), ...langs.map((l) => loadHighlighter(syntax.name, l))]).then(
      () => live && setReady(syntax.name),
      () => {}, // a theme failed: useSyntaxTheme falls back and this runs again
    );
    return () => void (live = false);
  }, [near, files, syntax.name, ready]);

  const numbered = /^@@ -\d+/m.test(text);
  const options = useMemo<FileDiffOptions<undefined, undefined>>(
    () => ({
      theme: syntax.theme,
      themeType: syntax.themeType,
      diffStyle: "unified",
      overflow: "scroll",
      lineDiffType: "word-alt",
      hunkSeparators: "simple", // no "11 unmodified lines" rows: a chat snippet has no file to expand into
      unsafeCSS: SURFACE,
      disableFileHeader: files.length < 2,
      disableLineNumbers: !numbered,
    }),
    [syntax.name, syntax.themeType, files.length, numbered],
  );

  if (!files.length) return fallback;
  // Until the first load: plain text. On a theme change the diff stays up and recolors in place.
  if (!ready)
    return (
      <div ref={ref} className="code-block">
        <pre>
          <code>{text}</code>
        </pre>
        <CopyButton text={text} />
      </div>
    );
  return (
    <div ref={ref} className="code-block code-diff">
      <Boundary fallback={fallback}>
        {files.map((f, i) => (
          <FileDiff key={i} fileDiff={f} options={options} />
        ))}
      </Boundary>
      <CopyButton text={text} />
    </div>
  );
}

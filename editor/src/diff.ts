// The Diff tab: a file against another version, side by side and read-only, drawn by @pierre/diffs'
// FileDiff (the Changes tab's renderer), so it needs no editor.

import { FileDiff, type FileContents } from "@pierre/diffs";
import { PLAIN, resolveLanguage } from "./language";
import { applyTokens, chromeCSS, normalizeTheme, shikiThemes, type EditorTheme, type ThemeInput, type TokenMap } from "./theme";

export interface DiffEditorOptions {
  original: string;
  modified: string;
  language?: string;
  theme?: ThemeInput;
  /** Grammars the bundle carries (iOS); a file in another language is plain text. */
  languages?: ReadonlySet<string>;
}

export interface DiffEditorHandle {
  setTheme(theme: ThemeInput): void;
  getContents(): string;
  getOriginal(): string;
  destroy(): void;
}

let keys = 0;

/** Side-by-side diff of two texts, read-only: the viewer for a file against another version. */
export function createDiffEditor(parent: HTMLElement, options: DiffEditorOptions): DiffEditorHandle {
  let theme: EditorTheme = normalizeTheme(options.theme);
  let tokens: TokenMap | undefined;
  const syncTokens = () => {
    applyTokens(parent, theme.tokens, tokens);
    tokens = theme.tokens;
  };
  syncTokens();
  const name = options.language && /[./\\]/.test(options.language) ? options.language : `file.${options.language ?? "txt"}`;
  const lang = resolveLanguage(options.language, options.languages) as FileContents["lang"];
  const side = (contents: string, side: string): FileContents => ({ name, contents, lang: lang === PLAIN ? undefined : lang, cacheKey: `diff-${side}-${++keys}` });
  const opts = () => ({ ...shikiThemes(theme), diffStyle: "split" as const, overflow: "scroll" as const, disableFileHeader: true, lineDiffType: "word-alt" as const, unsafeCSS: chromeCSS });
  const view = new FileDiff(opts());
  view.render({ oldFile: side(options.original, "a"), newFile: side(options.modified, "b"), containerWrapper: parent });
  return {
    setTheme(input) {
      const was = JSON.stringify(shikiThemes(theme));
      theme = { ...theme, ...normalizeTheme(input) };
      syncTokens();
      if (JSON.stringify(shikiThemes(theme)) === was) return;
      view.setOptions(opts());
      view.rerender();
    },
    getContents: () => options.modified,
    getOriginal: () => options.original,
    destroy() {
      view.cleanUp();
      parent.replaceChildren();
      applyTokens(parent, undefined, tokens);
    },
  };
}

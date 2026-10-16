// Syntax highlighting for code in the renderer, on @pierre/diffs' shared Shiki highlighter (the one
// the Git tab uses), so code in chat and in the diff viewer gets the same colors.
//
// useSyntaxTheme() follows the app theme: its Shiki theme (Theme.syntaxTheme), else Pierre's default
// for the appearance, and a name that fails to load falls back the same way, as the Git tab does. Its
// result spreads straight into @pierre/diffs options (`theme`, `themeType`), for File / FileDiff too.
//
// highlight() tokenizes one block, off the render path (idle time, one block per slice) and cached,
// so a long transcript renders its plain text at once and never re-highlights an unchanged block.

import { useEffect, useState } from "react";
import { useTheme } from "./theme";
import { createTokenCache, failedSyntaxThemes, markSyntaxThemeFailed, onSyntaxThemeFailed, syntaxThemeFor, MAX_HIGHLIGHT_CHARS, type Lines, type SyntaxTheme, type Tokenize } from "./syntaxTokens";

export * from "./syntaxTokens";

export function useSyntaxTheme(): SyntaxTheme {
  const state = useTheme();
  const [, bump] = useState(0);
  useEffect(() => {
    return onSyntaxThemeFailed(() => bump((n) => n + 1));
  }, []);
  return syntaxThemeFor(state, failedSyntaxThemes());
}

// --- tokens ---------------------------------------------------------------------------------

/** Wait for an idle moment (falls back to a timeout where requestIdleCallback is missing). */
function idle(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === "function") requestIdleCallback(() => resolve(), { timeout: 500 });
    else setTimeout(resolve, 16);
  });
}

// One block tokenized per idle slice, so a transcript full of code never blocks input.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(idle).then(fn);
  queue = run.catch(() => {});
  return run;
}

/** Load a theme and language into the shared highlighter; an unknown language degrades to text. */
export async function loadHighlighter(theme: string, lang: string) {
  const { getSharedHighlighter } = await import("@pierre/diffs");
  let h;
  try {
    h = await getSharedHighlighter({ themes: [theme], langs: [] });
  } catch (e) {
    markSyntaxThemeFailed(theme);
    throw e;
  }
  if (lang === "text") return { h, lang };
  try {
    await getSharedHighlighter({ themes: [], langs: [lang as "text"] });
    return { h, lang };
  } catch {
    return { h, lang: "text" };
  }
}

const shikiTokenize: Tokenize = (text, lang, theme) =>
  serial(async () => {
    const { h, lang: loaded } = await loadHighlighter(theme, lang);
    const { tokens } = h.codeToTokens(text, { lang: loaded as "text", theme });
    return tokens.map((line) => line.map((t) => ({ text: t.content, color: t.color, style: t.fontStyle || undefined })));
  });

const cache = createTokenCache(shikiTokenize);

/** The tokens for a block, once highlighted: sync from the cache on re-render, else null until ready. */
export function useHighlight(text: string, lang: string, theme: string, enabled = true): Lines | null {
  const cached = cache.get(text, lang, theme) ?? null;
  const [lines, setLines] = useState<{ key: string; lines: Lines } | null>(null);
  const key = `${theme}\u0000${lang}\u0000${text}`;
  useEffect(() => {
    if (!enabled || cached || text.length > MAX_HIGHLIGHT_CHARS) return;
    let live = true;
    cache.request(text, lang, theme).then(
      (l) => live && setLines({ key, lines: l }),
      () => {}, // the theme fell back (useSyntaxTheme re-renders) or Shiki failed: stay plain
    );
    return () => void (live = false);
  }, [key, enabled, cached]);
  return cached ?? (lines?.key === key ? lines.lines : null);
}

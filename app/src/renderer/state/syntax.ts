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
import { PIERRE_DEFAULT, syntaxThemeName, viewerThemes, type ThemeAppearance } from "@harness/shared/themes";
import { activeTheme, type ThemeState } from "../../main/theme";
import { useTheme } from "./theme";

export interface SyntaxTheme {
  appearance: ThemeAppearance;
  /** The Shiki theme on screen */
  name: string;
  /** @pierre/diffs `theme`: the chosen theme in the active slot, Pierre's default in the other */
  theme: Record<ThemeAppearance, string>;
  /** @pierre/diffs `themeType` */
  themeType: ThemeAppearance;
}

export function syntaxThemeFor(s: Pick<ThemeState, "themeId" | "resolved">, failed: ReadonlySet<string> = new Set()): SyntaxTheme {
  const appearance = s.resolved;
  const name = syntaxThemeName(appearance, activeTheme(s).syntaxTheme, failed);
  return { appearance, name, theme: viewerThemes(appearance, name), themeType: appearance };
}

const failedThemes = new Set<string>();
const failListeners = new Set<() => void>();

/** Remember a Shiki theme that didn't load, so everything falls back to Pierre's default instead. */
export function markSyntaxThemeFailed(name: string) {
  if (name === PIERRE_DEFAULT.light || name === PIERRE_DEFAULT.dark || failedThemes.has(name)) return;
  failedThemes.add(name);
  for (const fn of failListeners) fn();
}

export function useSyntaxTheme(): SyntaxTheme {
  const state = useTheme();
  const [, bump] = useState(0);
  useEffect(() => {
    const fn = () => bump((n) => n + 1);
    failListeners.add(fn);
    return () => void failListeners.delete(fn);
  }, []);
  return syntaxThemeFor(state, failedThemes);
}

// --- tokens ---------------------------------------------------------------------------------

/** One colored run; `style` is Shiki's FontStyle bits (1 italic, 2 bold, 4 underline). */
export interface Tok {
  text: string;
  color?: string;
  style?: number;
}
export type Lines = Tok[][];

/** Past this, a block stays plain text: tokenizing it would stall the renderer for little benefit. */
export const MAX_HIGHLIGHT_CHARS = 100_000;

export type Tokenize = (text: string, lang: string, theme: string) => Promise<Lines>;

/**
 * Tokenized blocks by (theme, language, text), least recently used evicted past `limit`, with
 * concurrent requests for the same block sharing one tokenize call. A failed tokenize isn't cached,
 * so a later request (after a theme falls back, say) tries again.
 */
export function createTokenCache(tokenize: Tokenize, limit = 400) {
  const done = new Map<string, Lines>();
  const pending = new Map<string, Promise<Lines>>();
  const key = (text: string, lang: string, theme: string) => `${theme}\u0000${lang}\u0000${text}`;
  return {
    get(text: string, lang: string, theme: string): Lines | undefined {
      const k = key(text, lang, theme);
      const hit = done.get(k);
      if (hit) {
        done.delete(k);
        done.set(k, hit);
      }
      return hit;
    },
    request(text: string, lang: string, theme: string): Promise<Lines> {
      const k = key(text, lang, theme);
      const hit = done.get(k);
      if (hit) return Promise.resolve(hit);
      let p = pending.get(k);
      if (!p) {
        p = tokenize(text, lang, theme).then(
          (lines) => {
            pending.delete(k);
            done.set(k, lines);
            if (done.size > limit) done.delete(done.keys().next().value!);
            return lines;
          },
          (e) => {
            pending.delete(k);
            throw e;
          },
        );
        pending.set(k, p);
      }
      return p;
    },
    get size() {
      return done.size;
    },
  };
}

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

// The pure half of syntax highlighting: which Shiki theme is on screen, which ones failed to load,
// and the token cache. syntax.ts wires them to Shiki and React.

import { PIERRE_DEFAULT, syntaxThemeName, viewerThemes, type ThemeAppearance } from "@harness/shared/themes";
import { activeTheme, type ThemeState } from "../../main/theme";

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

/** The Shiki themes that failed to load, for syntaxThemeFor. */
export const failedSyntaxThemes = (): ReadonlySet<string> => failedThemes;

/** Call `fn` whenever a theme is newly marked failed; returns an unsubscribe. */
export function onSyntaxThemeFailed(fn: () => void): () => void {
  failListeners.add(fn);
  return () => void failListeners.delete(fn);
}

/** Remember a Shiki theme that didn't load, so everything falls back to Pierre's default instead. */
export function markSyntaxThemeFailed(name: string) {
  if (name === PIERRE_DEFAULT.light || name === PIERRE_DEFAULT.dark || failedThemes.has(name)) return;
  failedThemes.add(name);
  for (const fn of failListeners) fn();
}

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

// The editor's look. Code colors come from a Shiki theme (the one the Changes tab uses, picked by
// the app theme's `syntaxTheme`); the chrome around it (background, selection, the revealed lines)
// comes from the app's theme tokens as CSS custom properties. On the Mac those are already on the
// page; where there are none (iOS web view) setTheme() writes a token map onto the editor's element.

import { CSS_VAR, type ThemeAppearance, type ThemeToken, type ThemeTokens } from "@harness/shared/themes/types";
import { PIERRE_DEFAULT, syntaxThemeName, viewerThemes } from "@harness/shared/themes/syntax";

export type TokenMap = Partial<ThemeTokens>;

/** What a caller passes as the theme: a token map, with the appearance when it isn't "light" and the Shiki theme's name. */
export interface EditorTheme {
  appearance?: ThemeAppearance;
  tokens?: TokenMap;
  /** The Shiki theme for the appearance (the app theme's `syntaxTheme`); Pierre's own when absent. */
  syntaxTheme?: string | null;
}

/** `setTheme` takes an EditorTheme or a bare token map. */
export type ThemeInput = EditorTheme | TokenMap;

export function normalizeTheme(input: ThemeInput | undefined): EditorTheme {
  if (!input) return {};
  if ("tokens" in input || "appearance" in input || "syntaxTheme" in input) return input as EditorTheme;
  return { tokens: input as TokenMap };
}

/** @pierre/diffs' `theme` and `themeType` for an editor theme. */
export function shikiThemes(theme: EditorTheme, failed?: ReadonlySet<string>) {
  const appearance = theme.appearance ?? "light";
  return { theme: viewerThemes(appearance, syntaxThemeName(appearance, theme.syntaxTheme, failed)), themeType: appearance };
}

export { PIERRE_DEFAULT };

const v = (token: ThemeToken, fallback: string) => `var(${CSS_VAR[token]}, ${fallback})`;

/**
 * The editor's chrome on top of Pierre's own: the page background and text for the code surface, the
 * app's selection color, and the lines a link revealed.
 */
export const chromeCSS = `
:host {
  --diffs-light-bg: ${v("bg", "#fff")};
  --diffs-dark-bg: ${v("bg", "#111")};
  --diffs-light: ${v("text", "#222")};
  --diffs-dark: ${v("text", "#ddd")};
  --diffs-font-size: 13px;
  --diffs-line-height: 1.55;
  --diffs-selection-base: ${v("accent", "#06f")};
  --diffs-bg-selection-override: ${v("accentSoft", "rgba(0,100,255,.15)")};
  --diffs-fg-number-override: ${v("text3", "#888")};
  caret-color: ${v("accent", "#06f")};
}
[data-line][data-selected-line] {
  box-shadow: inset 2px 0 0 ${v("accent", "#06f")};
}
`;

/** Writes a token map onto `el` as CSS custom properties, clearing any it set before that `next` omits. */
export function applyTokens(el: HTMLElement, next: TokenMap | undefined, prev: TokenMap | undefined): void {
  for (const key of Object.keys(prev ?? {}) as ThemeToken[]) {
    if (!next || next[key] === undefined) el.style.removeProperty(CSS_VAR[key]);
  }
  for (const key of Object.keys(next ?? {}) as ThemeToken[]) {
    const value = next?.[key];
    if (value !== undefined && CSS_VAR[key]) el.style.setProperty(CSS_VAR[key], value);
  }
}

// Which Shiki theme code is highlighted with (@pierre/diffs + @pierre/trees): the app theme's
// matching Shiki theme (Theme.syntaxTheme), or Pierre's own light/dark theme when there's none (an
// app theme Shiki doesn't ship, e.g. Tokyo Night Day) or its name failed to resolve. The Git tab and
// the desktop app's code blocks both use this, so code looks the same in chat and in the diff viewer.
import type { ThemeAppearance } from "./types";

export const PIERRE_DEFAULT: Record<ThemeAppearance, string> = { light: "pierre-light", dark: "pierre-dark" };

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function syntaxThemeName(appearance: ThemeAppearance, syntaxTheme: string | null | undefined, failed: ReadonlySet<string> = new Set()): string {
  if (syntaxTheme && NAME.test(syntaxTheme) && !failed.has(syntaxTheme)) return syntaxTheme;
  return PIERRE_DEFAULT[appearance];
}

/** @pierre/diffs' `theme` option: the chosen theme in the active slot, Pierre's default in the other. */
export function viewerThemes(appearance: ThemeAppearance, name: string): Record<ThemeAppearance, string> {
  return { ...PIERRE_DEFAULT, [appearance]: name };
}

/**
 * Resolve a theme to @pierre/trees CSS variables, cached per name. When `name` fails to resolve it's
 * added to `failed` and the appearance's Pierre default is used instead (whose own failure yields {}).
 */
export async function treeStylesFor(
  appearance: ThemeAppearance,
  name: string,
  cache: Map<string, Record<string, string>>,
  failed: Set<string>,
  resolve: (name: string) => Promise<Record<string, string>>,
): Promise<{ name: string; styles: Record<string, string> }> {
  const hit = cache.get(name);
  if (hit) return { name, styles: hit };
  try {
    const styles = await resolve(name);
    cache.set(name, styles);
    return { name, styles };
  } catch {
    const fallback = PIERRE_DEFAULT[appearance];
    if (name === fallback) {
      cache.set(name, {});
      return { name, styles: {} };
    }
    failed.add(name);
    return treeStylesFor(appearance, fallback, cache, failed, resolve);
  }
}

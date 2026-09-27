// Which @pierre/diffs + @pierre/trees (Shiki) theme the Changes tab uses. The host sends the app
// theme's matching Shiki theme (harness:init/theme `syntaxTheme`); without one (older hosts, or an
// app theme Shiki doesn't ship, e.g. Tokyo Night Day) we use Pierre's own light/dark theme. A name
// that fails to resolve is remembered and falls back the same way.
import type { Theme } from "@harness/plugin-sdk";

export const PIERRE_DEFAULT: Record<Theme, string> = { light: "pierre-light", dark: "pierre-dark" };

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function syntaxThemeName(appearance: Theme, syntaxTheme: string | null | undefined, failed: ReadonlySet<string> = new Set()): string {
  if (syntaxTheme && NAME.test(syntaxTheme) && !failed.has(syntaxTheme)) return syntaxTheme;
  return PIERRE_DEFAULT[appearance];
}

/** CodeView's `theme` option: the chosen theme in the active slot, Pierre's default in the other. */
export function viewerThemes(appearance: Theme, name: string): Record<Theme, string> {
  return { ...PIERRE_DEFAULT, [appearance]: name };
}

/**
 * Resolve a theme to tree CSS variables, cached per name. When `name` fails to resolve it's added to
 * `failed` and the appearance's Pierre default is used instead (whose own failure yields {}).
 */
export async function treeStylesFor(
  appearance: Theme,
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

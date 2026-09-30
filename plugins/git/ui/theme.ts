// Which @pierre/diffs + @pierre/trees (Shiki) theme the Changes tab uses. The host sends the app
// theme's matching Shiki theme (harness:init/theme `syntaxTheme`); without one (older hosts, or an
// app theme Shiki doesn't ship, e.g. Tokyo Night Day) we use Pierre's own light/dark theme. A name
// that fails to resolve is remembered and falls back the same way. The name logic is shared with the
// desktop app's chat code blocks (@harness/shared/themes), so both show the same colors.
import type { Theme } from "@harness/plugin-sdk";
import { PIERRE_DEFAULT } from "@harness/shared/themes";

export { PIERRE_DEFAULT, syntaxThemeName, viewerThemes } from "@harness/shared/themes";

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

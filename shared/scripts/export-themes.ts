// Writes ios/HarnessKit/Sources/HarnessKit/Resources/themes.json, which HarnessKit bundles and loads
// with Bundle.module: the theme registry, the project color presets and the icon set, straight from
// shared/src so the native app never hand-copies a palette. Swift: Themes, ProjectColors, Icons.
//
//   bun shared/scripts/export-themes.ts
//
// testing/l0/state/themesResource.test.ts fails when the committed JSON differs from `buildThemes()`.

import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ICON_PATHS } from "../src/state/icons";
import { PROJECT_COLORS } from "../src/projectColors";
import { DEFAULT_DARK_THEME, DEFAULT_LIGHT_THEME, THEMES } from "../src/themes";

export const THEMES_JSON = join(resolve(import.meta.dir, "../.."), "ios/HarnessKit/Sources/HarnessKit/Resources/themes.json");

/** The file's text: `{ "<name>": value }`, keys sorted, two-space indent, trailing newline. */
export function buildThemes(): string {
  const data = {
    DEFAULT_DARK_THEME,
    DEFAULT_LIGHT_THEME,
    ICON_NAMES: Object.keys(ICON_PATHS),
    ICON_PATHS,
    PROJECT_COLORS,
    THEMES,
  };
  return JSON.stringify(data, null, 2) + "\n";
}

if (import.meta.main) writeFileSync(THEMES_JSON, buildThemes());

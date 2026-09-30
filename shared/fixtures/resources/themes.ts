// Bundled with HarnessKit as Resources/themes.json (loaded with Bundle.module): the theme registry,
// the project color presets and the icon set, straight from shared/src so the native app never
// hand-copies a palette. Swift: Themes, ProjectColors, Icons.

import { ICON_PATHS as ICONS } from "../../src/state/icons";
import { PROJECT_COLORS as COLORS } from "../../src/projectColors";
import { DEFAULT_DARK_THEME as DARK, DEFAULT_LIGHT_THEME as LIGHT, THEMES as ALL } from "../../src/themes";

/** Every bundled theme in picker order (light themes, then dark). */
export const THEMES = ALL;
export const DEFAULT_LIGHT_THEME = LIGHT;
export const DEFAULT_DARK_THEME = DARK;
/** Project color presets in swatch order. */
export const PROJECT_COLORS = COLORS;
/** Icon name → 24×24 stroke path data. */
export const ICON_PATHS = ICONS;
/** Icon names in declaration order (JSON objects don't keep order once decoded). */
export const ICON_NAMES = Object.keys(ICONS);

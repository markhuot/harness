// Design constants for the phone. Colors come from the shared theme registry
// (@harness/shared/themes), the same tokens the desktop turns into CSS custom properties;
// useColors() returns the active theme's tokens.

import type { ThemeTokens } from "@harness/shared/themes";

/** The active theme's color tokens (useColors()). */
export type Palette = ThemeTokens;

export const RADIUS = { sm: 5, md: 8, lg: 12, xl: 16 } as const;
export const MONO = "Menlo";
/** Claude Code's orange, used on its driver badge icon (as on desktop). */
export const CLAUDE_ORANGE = "#d97757";

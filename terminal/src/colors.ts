// The terminal's colors from an app theme, for the Mac pane and the iOS sheet (which sends its theme
// tokens to the page).

import type { ResolvedTheme } from "@harness/shared/state";
import { over, toHex, type ThemeTokens } from "@harness/shared/themes";

/** The subset of ghostty-web's ITheme we set (all #rrggbb: its VT core only parses hex and rgb()). */
export interface TerminalColors {
  foreground: string;
  background: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  selectionForeground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

/** ANSI slots the theme tokens have no color for (Harness themes have no blue/cyan or greys of their own). */
const BASE: Record<ResolvedTheme, Pick<TerminalColors, "black" | "blue" | "cyan" | "white" | "brightBlack" | "brightBlue" | "brightCyan" | "brightWhite">> = {
  light: { black: "#1f2328", blue: "#0969da", cyan: "#1b7c83", white: "#6e7781", brightBlack: "#57606a", brightBlue: "#218bff", brightCyan: "#3192aa", brightWhite: "#8c959f" },
  dark: { black: "#484f58", blue: "#58a6ff", cyan: "#39c5cf", white: "#b1bac4", brightBlack: "#6e7681", brightBlue: "#79c0ff", brightCyan: "#56d4dd", brightWhite: "#f0f6fc" },
};

/**
 * The terminal's colors from the theme on screen: the pane background and text, the accent as the
 * cursor, the selection color, and the theme's red/green/amber/violet tones for those ANSI colors.
 * Translucent tokens are flattened over the background.
 */
export function terminalColors(tokens: ThemeTokens, resolved: ResolvedTheme): TerminalColors {
  const bg = toHex(over(tokens.bg, "#ffffff"));
  const hex = (c: string) => toHex(over(c, bg));
  return {
    ...BASE[resolved],
    foreground: hex(tokens.text),
    background: bg,
    cursor: hex(tokens.accent),
    cursorAccent: bg,
    selectionBackground: hex(tokens.selection),
    selectionForeground: hex(tokens.text),
    red: hex(tokens.red),
    green: hex(tokens.green),
    yellow: hex(tokens.amber),
    magenta: hex(tokens.violet),
    brightRed: hex(tokens.red),
    brightGreen: hex(tokens.green),
    brightYellow: hex(tokens.amber),
    brightMagenta: hex(tokens.violet),
  };
}

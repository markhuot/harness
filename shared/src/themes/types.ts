// The semantic token model every theme fills in. The desktop turns these into CSS custom
// properties (CSS_VAR), the phone reads them directly, and plugins receive them over the bridge.

export type ThemeAppearance = "light" | "dark";

export interface ThemeTokens {
  // Surfaces, from the window background up
  /** Main content background (board, transcript) */
  bg: string;
  bgSidebar: string;
  /** Raised surfaces: cards, the ticket panel, popovers, inputs */
  bgElev: string;
  /** Recessed wells: code blocks, tool output, kbd */
  bgSunken: string;
  /** Board column background */
  bgColumn: string;
  /** Translucent overlays for hover / pressed / selected rows */
  bgHover: string;
  bgActive: string;
  border: string;
  borderStrong: string;
  // Text, by emphasis
  text: string;
  text2: string;
  /** Metadata, timestamps, placeholders */
  text3: string;
  // Accent (primary buttons, links, selection, focus)
  accent: string;
  accentHover: string;
  accentSoft: string;
  /** Accent-colored text (links, selected nav items) */
  accentText: string;
  /** Text and icons on an accent fill (primary buttons, count badges) */
  onAccent: string;
  focus: string;
  /** Text selection highlight */
  selection: string;
  shadowSm: string;
  shadow: string;
  shadowLg: string;
  /** Modal scrim */
  overlay: string;
  // Board columns (status dots, conductor progress segments)
  planning: string;
  in_progress: string;
  blocked: string;
  review: string;
  done: string;
  // Tones: success / danger / warning / conductor (violet). Used as text, icons and fills.
  green: string;
  greenSoft: string;
  red: string;
  redSoft: string;
  /** Solid danger button fill */
  redSolid: string;
  /** Text on a solid danger button */
  onDanger: string;
  amber: string;
  amberSoft: string;
  /** Icons on an amber fill (approval badge) */
  onAmber: string;
  violet: string;
  violetSoft: string;
  // Diffs (+/− counts, plugin diff chrome)
  diffAdd: string;
  diffAddSoft: string;
  diffDel: string;
  diffDelSoft: string;
}

export type ThemeToken = keyof ThemeTokens;

export interface Theme {
  /** Stable id, persisted in preferences ("catppuccin-mocha") */
  id: string;
  /** Display name ("Catppuccin Mocha") */
  name: string;
  appearance: ThemeAppearance;
  /** Where the palette comes from */
  source: string;
  /** Shiki / @pierre/diffs theme that matches, when one ships (plugins use it for code) */
  syntaxTheme: string | null;
  tokens: ThemeTokens;
}

/** Token → the CSS custom property the desktop renderer uses. */
export const CSS_VAR: Record<ThemeToken, string> = {
  bg: "--bg",
  bgSidebar: "--bg-sidebar",
  bgElev: "--bg-elev",
  bgSunken: "--bg-sunken",
  bgColumn: "--bg-column",
  bgHover: "--bg-hover",
  bgActive: "--bg-active",
  border: "--border",
  borderStrong: "--border-strong",
  text: "--text",
  text2: "--text-2",
  text3: "--text-3",
  accent: "--accent",
  accentHover: "--accent-hover",
  accentSoft: "--accent-soft",
  accentText: "--accent-text",
  onAccent: "--on-accent",
  focus: "--focus",
  selection: "--selection",
  shadowSm: "--shadow-sm",
  shadow: "--shadow",
  shadowLg: "--shadow-lg",
  overlay: "--overlay",
  planning: "--c-planning",
  in_progress: "--c-in_progress",
  blocked: "--c-blocked",
  review: "--c-review",
  done: "--c-done",
  green: "--green",
  greenSoft: "--green-soft",
  red: "--red",
  redSoft: "--red-soft",
  redSolid: "--red-solid",
  onDanger: "--on-danger",
  amber: "--amber",
  amberSoft: "--amber-soft",
  onAmber: "--on-amber",
  violet: "--violet",
  violetSoft: "--violet-soft",
  diffAdd: "--diff-add",
  diffAddSoft: "--diff-add-soft",
  diffDel: "--diff-del",
  diffDelSoft: "--diff-del-soft",
};

export const TOKEN_KEYS = Object.keys(CSS_VAR) as ThemeToken[];

/** Tokens that hold box-shadow lists rather than a single color. */
export const SHADOW_TOKENS: ThemeToken[] = ["shadowSm", "shadow", "shadowLg"];

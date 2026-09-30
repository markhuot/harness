// Color themes (import from "@harness/shared/themes"). The registry, the default picks, how the
// Appearance preference resolves to one theme, and the CSS custom properties for a theme.
//
// Appearance stays System / Light / Dark. The user also picks one light theme and one dark theme;
// the active theme is the light pick when the resolved appearance is light, the dark pick when dark.

import { harnessDark, harnessLight } from "./harness";
import * as p from "./palettes";
import { CSS_VAR, TOKEN_KEYS, type Theme, type ThemeAppearance, type ThemeTokens } from "./types";

export * from "./types";
export { alpha, contrast, distance, mix, over, parseColor, isColor, toHex } from "./color";
export { harnessDark, harnessLight } from "./harness";
export { projectKeyColors, type ProjectKeyColors } from "./projectColor";
export { PIERRE_DEFAULT, syntaxThemeName, viewerThemes } from "./syntax";

/** Every bundled theme, grouped light-then-dark in picker order. */
export const THEMES: readonly Theme[] = [
  harnessLight,
  p.oneLight,
  p.catppuccinLatte,
  p.solarizedLight,
  p.githubLight,
  p.gruvboxLight,
  p.tokyoNightDay,
  p.rosePineDawn,
  harnessDark,
  p.oneDark,
  p.catppuccinFrappe,
  p.catppuccinMacchiato,
  p.catppuccinMocha,
  p.solarizedDark,
  p.githubDark,
  p.dracula,
  p.nordTheme,
  p.gruvboxDark,
  p.tokyoNight,
  p.rosePine,
];

export const DEFAULT_LIGHT_THEME = harnessLight.id;
export const DEFAULT_DARK_THEME = harnessDark.id;

const BY_ID = new Map(THEMES.map((t) => [t.id, t]));

export function findTheme(id: unknown): Theme | undefined {
  return typeof id === "string" ? BY_ID.get(id) : undefined;
}

export function themesFor(appearance: ThemeAppearance): Theme[] {
  return THEMES.filter((t) => t.appearance === appearance);
}

/** A stored id if it names a theme of that appearance, else the Harness default for it. */
export function themeIdFor(appearance: ThemeAppearance, id: unknown): string {
  const t = findTheme(id);
  return t && t.appearance === appearance ? t.id : appearance === "light" ? DEFAULT_LIGHT_THEME : DEFAULT_DARK_THEME;
}

export type AppearancePreference = "system" | "light" | "dark";

export interface ThemeChoice {
  appearance: AppearancePreference;
  lightTheme: string;
  darkTheme: string;
}

export interface ResolvedThemeChoice {
  /** light | dark after applying System */
  appearance: ThemeAppearance;
  theme: Theme;
}

export function isAppearancePreference(v: unknown): v is AppearancePreference {
  return v === "system" || v === "light" || v === "dark";
}

/** Normalize anything stored (old preference files, hand edits) into a valid choice. */
export function normalizeThemeChoice(v: { appearance?: unknown; lightTheme?: unknown; darkTheme?: unknown } | null | undefined): ThemeChoice {
  return {
    appearance: isAppearancePreference(v?.appearance) ? v.appearance : "system",
    lightTheme: themeIdFor("light", v?.lightTheme),
    darkTheme: themeIdFor("dark", v?.darkTheme),
  };
}

export function resolveThemeChoice(choice: ThemeChoice, systemDark: boolean): ResolvedThemeChoice {
  const appearance: ThemeAppearance = choice.appearance === "system" ? (systemDark ? "dark" : "light") : choice.appearance;
  const theme = findTheme(appearance === "light" ? themeIdFor("light", choice.lightTheme) : themeIdFor("dark", choice.darkTheme))!;
  return { appearance, theme };
}

/** [custom property, value] pairs for a theme. `prefix` namespaces them (plugins get --harness-*). */
export function themeCssVars(tokens: ThemeTokens, prefix = "--"): [string, string][] {
  return TOKEN_KEYS.map((k) => [prefix === "--" ? CSS_VAR[k] : prefix + CSS_VAR[k].slice(2), tokens[k]]);
}

/** A CSS declaration block body ("--bg: #fff; …") for a theme's tokens. */
export function themeCssText(tokens: ThemeTokens, prefix = "--"): string {
  return themeCssVars(tokens, prefix)
    .map(([k, v]) => `${k}: ${v};`)
    .join(" ");
}

/** Minimal style surface (CSSStyleDeclaration or a test double). */
export interface StyleTarget {
  setProperty(name: string, value: string): void;
}

/** Write a theme's tokens as custom properties onto an element's style. */
export function applyThemeVars(style: StyleTarget, tokens: ThemeTokens, prefix = "--"): void {
  for (const [k, v] of themeCssVars(tokens, prefix)) style.setProperty(k, v);
}

/** What plugins receive about the active theme (harness:init / harness:theme, additive). */
export interface PluginThemeInfo {
  appearance: ThemeAppearance;
  themeId: string;
  themeName: string;
  /** Shiki theme name matching the app theme, or null when none ships */
  syntaxTheme: string | null;
  tokens: ThemeTokens;
}

export function pluginThemeInfo(theme: Theme): PluginThemeInfo {
  return { appearance: theme.appearance, themeId: theme.id, themeName: theme.name, syntaxTheme: theme.syntaxTheme, tokens: { ...theme.tokens } };
}

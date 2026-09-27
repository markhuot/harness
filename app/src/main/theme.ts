// Theme preference → resolved theme. Pure (no Electron), shared by the main process and renderer.
//
// The preference ("system" | "light" | "dark") is what the user picks in Settings → Appearance,
// along with one light theme and one dark theme; all three are persisted by the main process.
// The resolved appearance is what's on screen and is always mirrored to
// <html data-theme="light|dark"> (plugins observe that attribute); the active theme — the light
// pick when light, the dark pick when dark — is on <html data-theme-id> and its tokens are the
// CSS custom properties on <html style>.

import { applyThemeVars, findTheme, normalizeThemeChoice, resolveThemeChoice, type StyleTarget, type Theme, type ThemeChoice } from "@harness/shared/themes";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";
export const THEME_PREFERENCES: ThemePreference[] = ["system", "light", "dark"];

export interface ThemeState {
  /** What the user chose (persisted) */
  preference: ThemePreference;
  /** What's actually applied */
  resolved: ResolvedTheme;
  /** Set when HARNESS_THEME / HARNESS_THEME_ID override the preference (screenshot scripts); the picker is informational then */
  forced: ResolvedTheme | null;
  /** The light and dark theme picks (persisted) */
  lightTheme: string;
  darkTheme: string;
  /** The theme on screen */
  themeId: string;
}

/** A change from Settings: any of the three picks. */
export interface ThemePatch {
  preference?: ThemePreference;
  lightTheme?: string;
  darkTheme?: string;
}

export function isThemePreference(v: unknown): v is ThemePreference {
  return v === "system" || v === "light" || v === "dark";
}

/** Read the stored choice from the preferences file contents; anything unusable → the defaults. */
export function parseStoredChoice(fileText: string | null | undefined): ThemeChoice {
  let v: { theme?: unknown; lightTheme?: unknown; darkTheme?: unknown } | null = null;
  try {
    v = fileText ? JSON.parse(fileText) : null;
  } catch {}
  return normalizeThemeChoice(v && typeof v === "object" ? { appearance: v.theme, lightTheme: v.lightTheme, darkTheme: v.darkTheme } : null);
}

/** Read the stored preference from the preferences file contents; anything unusable → "system". */
export function parseStoredPreference(fileText: string | null | undefined): ThemePreference {
  return parseStoredChoice(fileText).appearance;
}

/** The preferences-file fields for a choice (merged into the other preferences). */
export function storedChoiceFields(c: ThemeChoice): { theme: ThemePreference; lightTheme: string; darkTheme: string } {
  return { theme: c.appearance, lightTheme: c.lightTheme, darkTheme: c.darkTheme };
}

/** Apply a patch; ids that don't name a theme of the right appearance are ignored. */
export function applyPatch(c: ThemeChoice, patch: unknown): ThemeChoice {
  if (!patch || typeof patch !== "object") return c;
  const p = patch as Record<string, unknown>;
  const next = { ...c };
  if (isThemePreference(p.preference)) next.appearance = p.preference;
  if (findTheme(p.lightTheme)?.appearance === "light") next.lightTheme = p.lightTheme as string;
  if (findTheme(p.darkTheme)?.appearance === "dark") next.darkTheme = p.darkTheme as string;
  return next;
}

/** HARNESS_THEME=light|dark forces an appearance; any other value is ignored. */
export function parseForcedTheme(env: string | undefined): ResolvedTheme | null {
  return env === "light" || env === "dark" ? env : null;
}

/** HARNESS_THEME_ID=<id> forces one theme (and its appearance); unknown ids are ignored. */
export function parseForcedThemeId(env: string | undefined): Theme | null {
  return findTheme(env) ?? null;
}

export interface Forced {
  appearance: ResolvedTheme | null;
  theme: Theme | null;
}

/** The appearance the forcing implies: a forced theme's own appearance wins over HARNESS_THEME. */
export function forcedAppearance(f: Forced): ResolvedTheme | null {
  return f.theme?.appearance ?? f.appearance;
}

/** The theme source to hand nativeTheme: a forced theme wins over the stored preference. */
export function effectiveSource(preference: ThemePreference, forced: ResolvedTheme | null): ThemePreference {
  return forced ?? preference;
}

export function resolveTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  if (preference === "system") return systemDark ? "dark" : "light";
  return preference;
}

/** The full state for a stored choice, the OS appearance and any forcing. */
export function themeStateFor(choice: ThemeChoice, systemDark: boolean, forced: Forced = { appearance: null, theme: null }): ThemeState {
  const fa = forcedAppearance(forced);
  const eff = { ...choice, appearance: effectiveSource(choice.appearance, fa) };
  const { appearance, theme } = resolveThemeChoice(eff, systemDark);
  const active = forced.theme && forced.theme.appearance === appearance ? forced.theme : theme;
  return { preference: choice.appearance, resolved: appearance, forced: fa, lightTheme: choice.lightTheme, darkTheme: choice.darkTheme, themeId: active.id };
}

/** The theme a state puts on screen. */
export function activeTheme(s: Pick<ThemeState, "themeId" | "resolved">): Theme {
  return findTheme(s.themeId) ?? findTheme(s.resolved === "dark" ? "harness-dark" : "harness-light")!;
}

/** Window background matching --bg, so the first frame (before CSS) doesn't flash. */
export function windowBackground(s: Pick<ThemeState, "themeId" | "resolved">): string {
  return activeTheme(s).tokens.bg;
}

/** The bits of <html> a theme is stamped on (an HTMLElement, or a test double). */
export interface ThemeRoot {
  dataset: Record<string, string | undefined>;
  style: StyleTarget;
}

/**
 * Put a state on screen: data-theme (resolved appearance, the plugin contract), data-theme-id,
 * and the theme's tokens as custom properties. Used by the preload (before first paint) and the
 * renderer (on every change). Returns false when nothing changed.
 */
export function stampTheme(root: ThemeRoot, s: Pick<ThemeState, "themeId" | "resolved">): boolean {
  const theme = activeTheme(s);
  if (root.dataset.theme === s.resolved && root.dataset.themeId === theme.id) return false;
  applyThemeVars(root.style, theme.tokens);
  // Tokens first, attribute last: observers of data-theme (plugin tabs) see the new colors.
  root.dataset.themeId = theme.id;
  root.dataset.theme = s.resolved;
  return true;
}

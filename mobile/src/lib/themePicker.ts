// Model for Settings → Appearance's light/dark theme pickers. Pure, shared by the screen and tests.

import { resolveThemeChoice, themeIdFor, themesFor, type Theme, type ThemeAppearance } from "@harness/shared/themes";
import type { Prefs } from "./prefs";

export interface ThemeOption {
  theme: Theme;
  /** The pick for this appearance (what a radio shows as checked) */
  selected: boolean;
  /** Selected and on screen right now */
  active: boolean;
}

type ThemePrefs = Pick<Prefs, "theme" | "lightTheme" | "darkTheme">;

export function themeOptions(appearance: ThemeAppearance, prefs: ThemePrefs, systemDark: boolean): ThemeOption[] {
  const picked = themeIdFor(appearance, appearance === "light" ? prefs.lightTheme : prefs.darkTheme);
  const onScreen = resolveThemeChoice({ appearance: prefs.theme, lightTheme: prefs.lightTheme, darkTheme: prefs.darkTheme }, systemDark).theme.id;
  return themesFor(appearance).map((theme) => ({ theme, selected: theme.id === picked, active: theme.id === onScreen }));
}

/** The pref key a pick for this appearance writes. */
export const themePrefKey = (appearance: ThemeAppearance) => (appearance === "light" ? "lightTheme" : "darkTheme") as "lightTheme" | "darkTheme";

/** Picker footer: whether this appearance's pick is what's on screen, and when it applies otherwise. */
export function pickerCaption(appearance: ThemeAppearance, prefs: ThemePrefs, systemDark: boolean): string {
  const resolved = resolveThemeChoice({ appearance: prefs.theme, lightTheme: prefs.lightTheme, darkTheme: prefs.darkTheme }, systemDark).appearance;
  if (resolved === appearance) return "In use now.";
  if (prefs.theme === "system") return `Used when iOS is in ${appearance} mode.`;
  return `Used when Theme is ${appearance === "light" ? "Light" : "Dark"}, or System with iOS in ${appearance} mode.`;
}

/**
 * Theme picks from a settings deep link (harness://settings?darkTheme=catppuccin-mocha&theme=dark),
 * used to share a setup and by scripts/sim-check.ts. Only valid values come back; anything else is
 * dropped rather than falling back, so a bad link changes nothing.
 */
export function themeLinkPrefs(params: Record<string, string | string[] | undefined>): Partial<ThemePrefs> {
  const one = (k: string) => (typeof params[k] === "string" ? (params[k] as string) : undefined);
  const out: Partial<ThemePrefs> = {};
  const light = one("lightTheme");
  const dark = one("darkTheme");
  const appearance = one("theme");
  if (light && themeIdFor("light", light) === light) out.lightTheme = light;
  if (dark && themeIdFor("dark", dark) === dark) out.darkTheme = dark;
  if (appearance === "system" || appearance === "light" || appearance === "dark") out.theme = appearance;
  return out;
}

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

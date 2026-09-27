// The preferences blob (persisted by storage.ts in the Keychain). Pure, so it's testable under bun.

import { DEFAULT_DARK_THEME, DEFAULT_LIGHT_THEME, normalizeThemeChoice } from "@harness/shared/themes";
import { HIDE_CHILDREN_DEFAULT } from "@harness/shared/state";

export type ThemePreference = "system" | "light" | "dark";

export interface Prefs {
  /** Appearance: System / Light / Dark */
  theme: ThemePreference;
  /** Theme id used when the resolved appearance is light / dark (see @harness/shared/themes) */
  lightTheme: string;
  darkTheme: string;
  /** Board: hide child tickets (the blocked / awaiting-approval ones always show). First run: hidden, like the desktop. */
  hideChildren: boolean;
  lastProject: string | null;
  /** Board project filter (null = All projects) */
  boardProject: string | null;
  activeServer: string | null;
}

export const DEFAULT_PREFS: Prefs = { theme: "system", lightTheme: DEFAULT_LIGHT_THEME, darkTheme: DEFAULT_DARK_THEME, hideChildren: HIDE_CHILDREN_DEFAULT, lastProject: null, boardProject: null, activeServer: null };

/** Stored prefs (possibly from an older build, or hand-damaged) → valid prefs. */
export function normalizePrefs(stored: Partial<Prefs> | null | undefined): Prefs {
  const p = { ...DEFAULT_PREFS, ...(stored && typeof stored === "object" ? stored : {}) };
  if (typeof p.hideChildren !== "boolean") p.hideChildren = DEFAULT_PREFS.hideChildren;
  const choice = normalizeThemeChoice({ appearance: p.theme, lightTheme: p.lightTheme, darkTheme: p.darkTheme });
  return { ...p, theme: choice.appearance, lightTheme: choice.lightTheme, darkTheme: choice.darkTheme };
}


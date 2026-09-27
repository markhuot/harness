// Theme preference → resolved theme. Pure (no Electron), shared by the main process and renderer.
//
// The preference ("system" | "light" | "dark") is what the user picks in Settings → Appearance
// and is persisted by the main process. The resolved theme is what's on screen, and is always
// mirrored to <html data-theme="light|dark"> (plugins observe that attribute).

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";
export const THEME_PREFERENCES: ThemePreference[] = ["system", "light", "dark"];

export interface ThemeState {
  /** What the user chose (persisted) */
  preference: ThemePreference;
  /** What's actually applied */
  resolved: ResolvedTheme;
  /** Set when HARNESS_THEME overrides the preference (screenshot scripts); the picker is informational then */
  forced: ResolvedTheme | null;
}

export function isThemePreference(v: unknown): v is ThemePreference {
  return v === "system" || v === "light" || v === "dark";
}

/** Read the stored preference from the preferences file contents; anything unusable → "system". */
export function parseStoredPreference(fileText: string | null | undefined): ThemePreference {
  if (!fileText) return "system";
  try {
    const v = (JSON.parse(fileText) as { theme?: unknown } | null)?.theme;
    return isThemePreference(v) ? v : "system";
  } catch {
    return "system";
  }
}

/** HARNESS_THEME=light|dark forces a theme; any other value is ignored. */
export function parseForcedTheme(env: string | undefined): ResolvedTheme | null {
  return env === "light" || env === "dark" ? env : null;
}

/** The theme source to hand nativeTheme: a forced theme wins over the stored preference. */
export function effectiveSource(preference: ThemePreference, forced: ResolvedTheme | null): ThemePreference {
  return forced ?? preference;
}

export function resolveTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  if (preference === "system") return systemDark ? "dark" : "light";
  return preference;
}

/** Window background matching --bg, so the first frame (before CSS) doesn't flash. */
export function windowBackground(theme: ResolvedTheme): string {
  return theme === "dark" ? "#111214" : "#fbfbfc";
}

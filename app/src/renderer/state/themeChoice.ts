// What the app's theme is, read from the document or browser storage: no React, no bridge.

import type { ResolvedTheme } from "@harness/shared/state";
import { pluginThemeInfo, type PluginThemeInfo, type Theme } from "@harness/shared/themes";
import { activeTheme, parseStoredChoice } from "../../main/theme";

export const systemDark = () => typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;

/** localStorage holds either the old bare preference ("dark") or the JSON choice. */
export function parseBrowserChoice(raw: string | null) {
  if (raw === "system" || raw === "light" || raw === "dark") return parseStoredChoice(JSON.stringify({ theme: raw }));
  return parseStoredChoice(raw);
}

/** The resolved theme per the app's contract (<html data-theme>), falling back to the OS preference. */
export function currentTheme(doc: Document = document): ResolvedTheme {
  const t = doc.documentElement.dataset.theme;
  if (t === "light" || t === "dark") return t;
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** The color theme on screen (<html data-theme-id>, else the Harness default for the appearance). */
export function currentColorTheme(doc: Document = document): Theme {
  return activeTheme({ themeId: doc.documentElement.dataset.themeId ?? "", resolved: currentTheme(doc) });
}

/** What plugin tabs receive: the full theme (the bridge still sends the light/dark field too). */
export function currentPluginTheme(doc: Document = document): PluginThemeInfo {
  return pluginThemeInfo(currentColorTheme(doc));
}

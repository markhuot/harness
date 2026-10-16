// Renderer side of the appearance setting. Keeps <html data-theme> equal to the RESOLVED appearance
// at all times (plugin iframes observe it with a MutationObserver), <html data-theme-id> equal to
// the active color theme, and the theme's tokens as custom properties on <html style>. Exposes the
// choice to Settings → Appearance. In Electron the main process owns the choice; in a plain browser
// (dev / ?url=&token=) it falls back to localStorage + prefers-color-scheme.

import { useEffect, useState } from "react";
import { applyPatch, stampTheme, storedChoiceFields, themeStateFor, type ThemePatch, type ThemePreference, type ThemeState } from "../../main/theme";

import { parseBrowserChoice, systemDark } from "./themeChoice";

export * from "./themeChoice";

const LS_KEY = "harness.theme";
const listeners = new Set<(s: ThemeState) => void>();
let current: ThemeState | null = null;

function browserChoice() {
  try {
    return parseBrowserChoice(localStorage.getItem(LS_KEY));
  } catch {
    return parseBrowserChoice(null);
  }
}

function read(): ThemeState {
  if (window.harness?.getTheme) return window.harness.getTheme();
  return themeStateFor(browserChoice(), systemDark());
}

function publish(s: ThemeState) {
  current = s;
  stampTheme(document.documentElement, s);
  for (const fn of listeners) fn(s);
}

let started = false;
/** Apply the theme now and keep it current. Call once, before the first render. */
export function initTheme() {
  if (started) return;
  started = true;
  publish(read());
  window.harness?.onThemeChange(publish);
  // OS appearance flips: nativeTheme also reports these, but re-reading is cheap and covers the browser.
  if (typeof matchMedia === "function") matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => publish(read()));
}

/** Change the appearance and/or the light / dark theme picks. */
export async function updateTheme(patch: ThemePatch) {
  if (window.harness?.setTheme) {
    publish(await window.harness.setTheme(patch));
    return;
  }
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(storedChoiceFields(applyPatch(browserChoice(), patch))));
  } catch {}
  publish(read());
}

export const setThemePreference = (preference: ThemePreference) => updateTheme({ preference });

export function useTheme(): ThemeState {
  const [s, set] = useState<ThemeState>(() => current ?? read());
  useEffect(() => {
    listeners.add(set);
    if (current) set(current);
    return () => void listeners.delete(set);
  }, []);
  return s;
}


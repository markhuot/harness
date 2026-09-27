// Renderer side of the appearance setting. Keeps <html data-theme> equal to the RESOLVED theme at
// all times (plugin iframes observe it with a MutationObserver), and exposes the preference to
// Settings → Appearance. In Electron the main process owns the preference; in a plain browser
// (dev / ?url=&token=) it falls back to localStorage + prefers-color-scheme.

import { useEffect, useState } from "react";
import type { ResolvedTheme } from "@harness/shared/state";
import { isThemePreference, resolveTheme, type ThemePreference, type ThemeState } from "../../main/theme";

const LS_KEY = "harness.theme";
const listeners = new Set<(s: ThemeState) => void>();
let current: ThemeState | null = null;

const systemDark = () => typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;

function browserPreference(): ThemePreference {
  try {
    const v = localStorage.getItem(LS_KEY);
    return isThemePreference(v) ? v : "system";
  } catch {
    return "system";
  }
}

function read(): ThemeState {
  if (window.harness?.getTheme) return window.harness.getTheme();
  const preference = browserPreference();
  return { preference, resolved: resolveTheme(preference, systemDark()), forced: null };
}

function publish(s: ThemeState) {
  current = s;
  if (document.documentElement.dataset.theme !== s.resolved) document.documentElement.dataset.theme = s.resolved;
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

export async function setThemePreference(preference: ThemePreference) {
  if (window.harness?.setTheme) {
    publish(await window.harness.setTheme(preference));
    return;
  }
  try {
    localStorage.setItem(LS_KEY, preference);
  } catch {}
  publish(read());
}

export function useTheme(): ThemeState {
  const [s, set] = useState<ThemeState>(() => current ?? read());
  useEffect(() => {
    listeners.add(set);
    if (current) set(current);
    return () => void listeners.delete(set);
  }, []);
  return s;
}

/** The resolved theme per the app's contract (<html data-theme>), falling back to the OS preference. */
export function currentTheme(doc: Document = document): ResolvedTheme {
  const t = doc.documentElement.dataset.theme;
  if (t === "light" || t === "dark") return t;
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

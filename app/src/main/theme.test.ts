import { describe, expect, test } from "bun:test";
import { CSS_VAR, findTheme } from "@harness/shared/themes";
import {
  activeTheme,
  applyPatch,
  effectiveSource,
  parseForcedTheme,
  parseForcedThemeId,
  parseStoredChoice,
  parseStoredPreference,
  resolveTheme,
  stampTheme,
  storedChoiceFields,
  themeStateFor,
  windowBackground,
} from "./theme";

describe("theme", () => {
  test("system follows the OS; explicit choices ignore it", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  test("stored preference falls back to system on missing, corrupt or unknown values", () => {
    expect(parseStoredPreference('{"theme":"dark"}')).toBe("dark");
    expect(parseStoredPreference('{"theme":"light","other":1}')).toBe("light");
    expect(parseStoredPreference(null)).toBe("system");
    expect(parseStoredPreference("")).toBe("system");
    expect(parseStoredPreference("{not json")).toBe("system");
    expect(parseStoredPreference('{"theme":"sepia"}')).toBe("system");
    expect(parseStoredPreference("null")).toBe("system");
  });

  test("stored theme picks: old files get the Harness defaults, wrong-appearance ids are dropped", () => {
    expect(parseStoredChoice('{"theme":"dark"}')).toEqual({ appearance: "dark", lightTheme: "harness-light", darkTheme: "harness-dark" });
    expect(parseStoredChoice('{"theme":"system","lightTheme":"one-light","darkTheme":"catppuccin-mocha"}')).toEqual({ appearance: "system", lightTheme: "one-light", darkTheme: "catppuccin-mocha" });
    expect(parseStoredChoice('{"lightTheme":"dracula","darkTheme":"solarized-light"}')).toEqual({ appearance: "system", lightTheme: "harness-light", darkTheme: "harness-dark" });
    expect(parseStoredChoice("[1,2]").appearance).toBe("system");
    // Round trip through the file fields keeps the other preferences' shape (theme key unchanged).
    const c = parseStoredChoice('{"theme":"light","lightTheme":"nord"}');
    expect(storedChoiceFields(c)).toEqual({ theme: "light", lightTheme: "harness-light", darkTheme: "harness-dark" });
  });

  test("patches change only valid fields", () => {
    const base = parseStoredChoice(null);
    expect(applyPatch(base, { darkTheme: "dracula" })).toEqual({ ...base, darkTheme: "dracula" });
    expect(applyPatch(base, { darkTheme: "one-light", lightTheme: "bogus", preference: "sepia" })).toEqual(base);
    expect(applyPatch(base, { preference: "dark", lightTheme: "gruvbox-light" })).toEqual({ appearance: "dark", lightTheme: "gruvbox-light", darkTheme: "harness-dark" });
    expect(applyPatch(base, null)).toEqual(base);
  });

  test("HARNESS_THEME overrides the stored preference only when it's light or dark", () => {
    expect(parseForcedTheme("dark")).toBe("dark");
    expect(parseForcedTheme("system")).toBeNull();
    expect(parseForcedTheme(undefined)).toBeNull();
    expect(effectiveSource("light", parseForcedTheme("dark"))).toBe("dark");
    expect(effectiveSource("light", parseForcedTheme("bogus"))).toBe("light");
    expect(resolveTheme(effectiveSource("system", null), true)).toBe("dark");
  });

  test("the active theme is the light pick when light, the dark pick when dark", () => {
    const c = parseStoredChoice('{"theme":"system","lightTheme":"catppuccin-latte","darkTheme":"catppuccin-mocha"}');
    expect(themeStateFor(c, true)).toMatchObject({ preference: "system", resolved: "dark", themeId: "catppuccin-mocha", forced: null });
    expect(themeStateFor(c, false)).toMatchObject({ resolved: "light", themeId: "catppuccin-latte" });
    expect(themeStateFor({ ...c, appearance: "light" }, true).themeId).toBe("catppuccin-latte");
  });

  test("HARNESS_THEME_ID forces a theme and its appearance over the stored choice and HARNESS_THEME", () => {
    const c = parseStoredChoice('{"theme":"light","lightTheme":"one-light"}');
    const mocha = parseForcedThemeId("catppuccin-mocha");
    expect(mocha?.id).toBe("catppuccin-mocha");
    expect(parseForcedThemeId("nope")).toBeNull();
    const s = themeStateFor(c, false, { appearance: "light", theme: mocha });
    expect(s).toMatchObject({ resolved: "dark", forced: "dark", themeId: "catppuccin-mocha", preference: "light", lightTheme: "one-light" });
    // HARNESS_THEME alone keeps the user's pick for that appearance.
    expect(themeStateFor(c, false, { appearance: "dark", theme: null })).toMatchObject({ resolved: "dark", themeId: "harness-dark" });
  });

  test("window background is the active theme's --bg (Harness values unchanged)", () => {
    expect(windowBackground({ themeId: "harness-dark", resolved: "dark" })).toBe("#111214");
    expect(windowBackground({ themeId: "harness-light", resolved: "light" })).toBe("#fbfbfc");
    expect(windowBackground({ themeId: "dracula", resolved: "dark" })).toBe(findTheme("dracula")!.tokens.bg);
    expect(activeTheme({ themeId: "gone", resolved: "dark" }).id).toBe("harness-dark");
  });

  test("stampTheme writes the tokens before the attributes, and skips no-op updates", () => {
    const order: string[] = [];
    const props = new Map<string, string>();
    const dataset: Record<string, string | undefined> = new Proxy({} as Record<string, string | undefined>, {
      set(t, k, v) {
        order.push(`attr:${String(k)}`);
        t[k as string] = v;
        return true;
      },
    });
    const root = { dataset, style: { setProperty: (k: string, v: string) => (props.set(k, v), order.push("prop")) } };
    expect(stampTheme(root, { themeId: "nord", resolved: "dark" })).toBe(true);
    expect(dataset.theme).toBe("dark");
    expect(dataset.themeId).toBe("nord");
    expect(props.get("--bg")).toBe(findTheme("nord")!.tokens.bg);
    expect(props.size).toBe(Object.keys(CSS_VAR).length);
    expect(order.at(-1)).toBe("attr:theme"); // observers of data-theme see the new tokens
    expect(order.indexOf("attr:themeId")).toBeGreaterThan(order.lastIndexOf("prop"));
    order.length = 0;
    expect(stampTheme(root, { themeId: "nord", resolved: "dark" })).toBe(false);
    expect(order).toEqual([]);
    expect(stampTheme(root, { themeId: "catppuccin-mocha", resolved: "dark" })).toBe(true);
    expect(props.get("--bg")).toBe(findTheme("catppuccin-mocha")!.tokens.bg);
  });
});

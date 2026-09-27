import { describe, expect, test } from "bun:test";
import { DEFAULT_PREFS, normalizePrefs } from "./prefs";
import { pickerCaption, themeOptions } from "./themePicker";

describe("prefs normalization", () => {
  test("a blob from before themes (appearance only) gets the Harness defaults", () => {
    expect(normalizePrefs({ theme: "dark", hideChildren: true } as never)).toMatchObject({ theme: "dark", lightTheme: "harness-light", darkTheme: "harness-dark", hideChildren: true });
  });

  test("unknown ids, wrong-appearance ids and bad appearance values fall back", () => {
    const p = normalizePrefs({ theme: "sepia" as never, lightTheme: "catppuccin-mocha", darkTheme: "not-a-theme" });
    expect(p).toMatchObject({ theme: "system", lightTheme: "harness-light", darkTheme: "harness-dark" });
  });

  test("valid picks survive; other prefs pass through untouched", () => {
    const p = normalizePrefs({ theme: "light", lightTheme: "rose-pine-dawn", darkTheme: "dracula", activeServer: "srv-1", boardProject: "p" });
    expect(p).toEqual({ ...DEFAULT_PREFS, theme: "light", lightTheme: "rose-pine-dawn", darkTheme: "dracula", activeServer: "srv-1", boardProject: "p" });
  });

  test("garbage in storage yields the defaults", () => {
    expect(normalizePrefs(null)).toEqual(DEFAULT_PREFS);
    expect(normalizePrefs("x" as never)).toEqual(DEFAULT_PREFS);
  });
});

describe("theme picker", () => {
  const prefs = { theme: "system" as const, lightTheme: "github-light", darkTheme: "catppuccin-mocha" };

  test("lists only themes of that appearance, with the pick selected", () => {
    const dark = themeOptions("dark", prefs, false);
    expect(dark.every((o) => o.theme.appearance === "dark")).toBe(true);
    expect(dark.filter((o) => o.selected).map((o) => o.theme.id)).toEqual(["catppuccin-mocha"]);
    expect(themeOptions("light", prefs, false).filter((o) => o.selected).map((o) => o.theme.id)).toEqual(["github-light"]);
  });

  test("only the pick for the resolved appearance is active", () => {
    expect(themeOptions("dark", prefs, false).some((o) => o.active)).toBe(false);
    expect(themeOptions("light", prefs, false).find((o) => o.active)?.theme.id).toBe("github-light");
    expect(themeOptions("dark", prefs, true).find((o) => o.active)?.theme.id).toBe("catppuccin-mocha");
    // An explicit appearance wins over the OS.
    expect(themeOptions("dark", { ...prefs, theme: "dark" }, false).find((o) => o.active)?.theme.id).toBe("catppuccin-mocha");
  });

  test("a stale pick shows the default as selected", () => {
    const o = themeOptions("dark", { ...prefs, darkTheme: "one-light" }, true);
    expect(o.filter((x) => x.selected).map((x) => x.theme.id)).toEqual(["harness-dark"]);
  });

  test("captions say whether the pick is on screen and when it applies", () => {
    expect(pickerCaption("light", prefs, false)).toBe("In use now.");
    expect(pickerCaption("dark", prefs, false)).toBe("Used when iOS is in dark mode.");
    expect(pickerCaption("dark", { ...prefs, theme: "light" }, true)).toBe("Used when Theme is Dark, or System with iOS in dark mode.");
  });
});

import { describe, expect, test } from "bun:test";
import { currentColorTheme, currentPluginTheme, currentTheme, parseBrowserChoice } from "../../../app/src/renderer/state/themeChoice";

const doc = (dataset: Record<string, string | undefined>) => ({ documentElement: { dataset } }) as unknown as Document;

describe("parseBrowserChoice", () => {
  test("the old bare preferences become that appearance with default themes", () => {
    for (const p of ["system", "light", "dark"] as const) expect(parseBrowserChoice(p)).toEqual({ appearance: p, lightTheme: "harness-light", darkTheme: "harness-dark" });
  });
  test("the JSON choice is read, themes of the wrong appearance replaced", () => {
    expect(parseBrowserChoice('{"theme":"dark","darkTheme":"dracula","lightTheme":"dracula"}')).toEqual({ appearance: "dark", lightTheme: "harness-light", darkTheme: "dracula" });
  });
  test("null, junk and unknown bare words are system with defaults", () => {
    const sys = { appearance: "system" as const, lightTheme: "harness-light", darkTheme: "harness-dark" };
    expect(parseBrowserChoice(null)).toEqual(sys);
    expect(parseBrowserChoice("{bad")).toEqual(sys);
    expect(parseBrowserChoice("sepia")).toEqual(sys);
  });
});

describe("currentTheme", () => {
  test("reads data-theme", () => {
    expect(currentTheme(doc({ theme: "dark" }))).toBe("dark");
    expect(currentTheme(doc({ theme: "light" }))).toBe("light");
  });
  test("an unusable data-theme with no matchMedia (bun) is light", () => {
    expect(typeof matchMedia).toBe("undefined");
    expect(currentTheme(doc({}))).toBe("light");
    expect(currentTheme(doc({ theme: "sepia" }))).toBe("light");
  });
});

describe("currentColorTheme", () => {
  test("data-theme-id picks a bundled theme", () => {
    expect(currentColorTheme(doc({ theme: "dark", themeId: "dracula" })).id).toBe("dracula");
  });
  test("no or unknown id falls back to the Harness theme for the appearance", () => {
    expect(currentColorTheme(doc({ theme: "dark" })).id).toBe("harness-dark");
    expect(currentColorTheme(doc({ theme: "light", themeId: "nope" })).id).toBe("harness-light");
    expect(currentColorTheme(doc({})).id).toBe("harness-light");
  });
});

describe("currentPluginTheme", () => {
  test("carries the on-screen theme's identity, as a detached copy of its tokens", () => {
    const a = currentPluginTheme(doc({ theme: "dark", themeId: "dracula" }));
    expect(a).toMatchObject({ appearance: "dark", themeId: "dracula" });
    a.tokens.bg = "#123456";
    expect(currentPluginTheme(doc({ theme: "dark", themeId: "dracula" })).tokens.bg).not.toBe("#123456");
  });
});

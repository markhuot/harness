import { describe, expect, test } from "bun:test";
import { applyTokens, normalizeTheme, shikiThemes } from "./theme";

describe("normalizeTheme", () => {
  test("a bare token map is tokens with no appearance, and a themed object passes through", () => {
    expect(normalizeTheme({ bg: "#123" })).toEqual({ tokens: { bg: "#123" } });
    expect(normalizeTheme({ appearance: "dark" })).toEqual({ appearance: "dark" });
    expect(normalizeTheme({ syntaxTheme: "nord" })).toEqual({ syntaxTheme: "nord" });
    expect(normalizeTheme(undefined)).toEqual({});
  });
});

describe("shikiThemes", () => {
  test("the app theme's Shiki theme takes the active slot and Pierre's own the other", () => {
    expect(shikiThemes({ appearance: "dark", syntaxTheme: "dracula" })).toEqual({ theme: { light: "pierre-light", dark: "dracula" }, themeType: "dark" });
    expect(shikiThemes({ appearance: "light", syntaxTheme: "one-light" })).toEqual({ theme: { light: "one-light", dark: "pierre-dark" }, themeType: "light" });
  });
  test("no Shiki theme, or one that failed to load, falls back to Pierre's default for the appearance", () => {
    expect(shikiThemes({ appearance: "dark" }).theme.dark).toBe("pierre-dark");
    expect(shikiThemes({}).themeType).toBe("light");
    expect(shikiThemes({ appearance: "dark", syntaxTheme: "dracula" }, new Set(["dracula"])).theme.dark).toBe("pierre-dark");
  });
});

describe("applyTokens", () => {
  test("writes CSS variables and clears the ones a later map leaves out", () => {
    const el = document.createElement("div");
    applyTokens(el, { bg: "#111", text: "#eee" }, undefined);
    expect(el.style.getPropertyValue("--bg")).toBe("#111");
    applyTokens(el, { bg: "#222" }, { bg: "#111", text: "#eee" });
    expect(el.style.getPropertyValue("--bg")).toBe("#222");
    expect(el.style.getPropertyValue("--text")).toBe("");
    applyTokens(el, undefined, { bg: "#222" });
    expect(el.style.getPropertyValue("--bg")).toBe("");
  });
});

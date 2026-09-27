import { expect, test } from "bun:test";
import { currentColorTheme, currentPluginTheme, currentTheme, parseBrowserChoice } from "./theme";

const doc = (theme?: string, themeId?: string) => ({ documentElement: { dataset: { ...(theme ? { theme } : {}), ...(themeId ? { themeId } : {}) } } }) as unknown as Document;

test("currentTheme reads <html data-theme>, else falls back to a resolved theme", () => {
  expect(currentTheme(doc("dark"))).toBe("dark");
  expect(currentTheme(doc("light"))).toBe("light");
  expect(["light", "dark"]).toContain(currentTheme(doc("sepia")));
  expect(["light", "dark"]).toContain(currentTheme(doc()));
});

test("the color theme comes from data-theme-id, else the default for the appearance", () => {
  expect(currentColorTheme(doc("dark", "dracula")).id).toBe("dracula");
  expect(currentColorTheme(doc("dark")).id).toBe("harness-dark");
  expect(currentColorTheme(doc("light", "gone")).id).toBe("harness-light");
  const info = currentPluginTheme(doc("dark", "catppuccin-mocha"));
  expect(info).toMatchObject({ appearance: "dark", themeId: "catppuccin-mocha", syntaxTheme: "catppuccin-mocha" });
  expect(typeof info.tokens.bg).toBe("string");
});

test("browser storage reads the old bare preference and the JSON choice", () => {
  expect(parseBrowserChoice("dark")).toEqual({ appearance: "dark", lightTheme: "harness-light", darkTheme: "harness-dark" });
  expect(parseBrowserChoice('{"theme":"system","darkTheme":"nord"}')).toMatchObject({ appearance: "system", darkTheme: "nord" });
  expect(parseBrowserChoice(null).appearance).toBe("system");
  expect(parseBrowserChoice("garbage").appearance).toBe("system");
});

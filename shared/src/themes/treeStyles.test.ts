import { expect, test } from "bun:test";
import { syntaxThemeName, treeStylesFor, viewerThemes } from "./syntax";

test("uses the host's syntax theme, else Pierre's default for the appearance", () => {
  expect(syntaxThemeName("dark", "catppuccin-mocha")).toBe("catppuccin-mocha");
  expect(syntaxThemeName("dark", null)).toBe("pierre-dark");
  expect(syntaxThemeName("light", undefined)).toBe("pierre-light");
  expect(syntaxThemeName("light", "../../etc")).toBe("pierre-light"); // not a theme name
  expect(syntaxThemeName("dark", "dracula", new Set(["dracula"]))).toBe("pierre-dark"); // known broken
});

test("CodeView gets the chosen theme in the active slot only", () => {
  expect(viewerThemes("dark", "nord")).toEqual({ light: "pierre-light", dark: "nord" });
  expect(viewerThemes("light", "one-light")).toEqual({ light: "one-light", dark: "pierre-dark" });
});

test("tree styles are cached per name and fall back to the Pierre default when a theme fails", async () => {
  const calls: string[] = [];
  const resolve = async (n: string) => {
    calls.push(n);
    if (n === "missing-theme") throw new Error("nope");
    return { "--trees-fg": n };
  };
  const cache = new Map<string, Record<string, string>>();
  const failed = new Set<string>();
  expect(await treeStylesFor("dark", "dracula", cache, failed, resolve)).toEqual({ name: "dracula", styles: { "--trees-fg": "dracula" } });
  await treeStylesFor("dark", "dracula", cache, failed, resolve);
  expect(calls).toEqual(["dracula"]);
  expect(await treeStylesFor("light", "missing-theme", cache, failed, resolve)).toEqual({ name: "pierre-light", styles: { "--trees-fg": "pierre-light" } });
  expect(failed.has("missing-theme")).toBe(true);
  expect(syntaxThemeName("light", "missing-theme", failed)).toBe("pierre-light");
  // Even the default failing leaves an empty (unstyled) tree rather than a rejection.
  const bad = async () => Promise.reject(new Error("offline"));
  expect(await treeStylesFor("dark", "pierre-dark", new Map(), new Set(), bad)).toEqual({ name: "pierre-dark", styles: {} });
});

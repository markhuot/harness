import { describe, expect, test } from "bun:test";
import { createTokenCache, failedSyntaxThemes, markSyntaxThemeFailed, onSyntaxThemeFailed, syntaxThemeFor, type Lines } from "../../../app/src/renderer/state/syntaxTokens";

/** A tokenize whose every call stays pending until the test settles it. */
function manualTokenize() {
  const calls: { text: string; lang: string; theme: string; resolve: (l: Lines) => void; reject: (e: unknown) => void }[] = [];
  const tokenize = (text: string, lang: string, theme: string) =>
    new Promise<Lines>((resolve, reject) => {
      calls.push({ text, lang, theme, resolve, reject });
    });
  return { tokenize, calls };
}
const lines = (s: string): Lines => [[{ text: s }]];

describe("createTokenCache", () => {
  test("concurrent requests for the same block share one tokenize call", async () => {
    const t = manualTokenize();
    const cache = createTokenCache(t.tokenize);
    const a = cache.request("x", "ts", "dark");
    const b = cache.request("x", "ts", "dark");
    expect(t.calls).toHaveLength(1);
    t.calls[0]!.resolve(lines("x"));
    expect(await a).toEqual(lines("x"));
    expect(await b).toEqual(lines("x"));
  });

  test("theme, language and text each make a distinct entry", async () => {
    const t = manualTokenize();
    const cache = createTokenCache(t.tokenize);
    void cache.request("x", "ts", "dark");
    void cache.request("x", "ts", "light");
    void cache.request("x", "js", "dark");
    void cache.request("y", "ts", "dark");
    expect(t.calls).toHaveLength(4);
  });

  test("a finished block is served from the cache without tokenizing again", async () => {
    const t = manualTokenize();
    const cache = createTokenCache(t.tokenize);
    const p = cache.request("x", "ts", "dark");
    expect(cache.get("x", "ts", "dark")).toBeUndefined();
    t.calls[0]!.resolve(lines("x"));
    await p;
    expect(cache.get("x", "ts", "dark")).toEqual(lines("x"));
    expect(await cache.request("x", "ts", "dark")).toEqual(lines("x"));
    expect(t.calls).toHaveLength(1);
    expect(cache.size).toBe(1);
  });

  test("a failed tokenize rejects every waiter, is not cached, and the next request retries", async () => {
    const t = manualTokenize();
    const cache = createTokenCache(t.tokenize);
    const a = cache.request("x", "ts", "dark");
    const b = cache.request("x", "ts", "dark");
    t.calls[0]!.reject(new Error("boom"));
    await expect(a).rejects.toThrow("boom");
    await expect(b).rejects.toThrow("boom");
    expect(cache.size).toBe(0);
    expect(cache.get("x", "ts", "dark")).toBeUndefined();
    const retry = cache.request("x", "ts", "dark");
    expect(t.calls).toHaveLength(2);
    t.calls[1]!.resolve(lines("ok"));
    expect(await retry).toEqual(lines("ok"));
  });

  test("past the limit the least recently used block is evicted", async () => {
    const t = manualTokenize();
    const cache = createTokenCache(t.tokenize, 2);
    const fill = async (text: string) => {
      const p = cache.request(text, "ts", "d");
      t.calls.at(-1)!.resolve(lines(text));
      await p;
    };
    await fill("a");
    await fill("b");
    await fill("c");
    expect(cache.size).toBe(2);
    expect(cache.get("a", "ts", "d")).toBeUndefined();
    expect(cache.get("b", "ts", "d")).toBeDefined();
    expect(cache.get("c", "ts", "d")).toBeDefined();
  });

  test("get refreshes recency, so the touched block outlives a newer untouched one", async () => {
    const t = manualTokenize();
    const cache = createTokenCache(t.tokenize, 2);
    const fill = async (text: string) => {
      const p = cache.request(text, "ts", "d");
      t.calls.at(-1)!.resolve(lines(text));
      await p;
    };
    await fill("a");
    await fill("b");
    cache.get("a", "ts", "d"); // a is now newer than b
    await fill("c");
    expect(cache.get("b", "ts", "d")).toBeUndefined();
    expect(cache.get("a", "ts", "d")).toBeDefined();
    expect(cache.get("c", "ts", "d")).toBeDefined();
  });

  test("a miss in get does not create an entry", () => {
    const cache = createTokenCache(manualTokenize().tokenize);
    expect(cache.get("nope", "ts", "d")).toBeUndefined();
    expect(cache.size).toBe(0);
  });
});

describe("syntaxThemeFor", () => {
  test("uses the active theme's Shiki theme in the active slot, Pierre's default in the other", () => {
    const dark = syntaxThemeFor({ themeId: "dracula", resolved: "dark" });
    expect(dark).toEqual({ appearance: "dark", name: "dracula", theme: { light: "pierre-light", dark: "dracula" }, themeType: "dark" });
  });

  test("a theme Shiki lacks (no syntaxTheme) uses Pierre's default for the appearance", () => {
    const t = syntaxThemeFor({ themeId: "tokyo-night-day", resolved: "light" });
    expect(t.name).toBe("pierre-light");
    expect(t.theme).toEqual({ light: "pierre-light", dark: "pierre-dark" });
  });

  test("an unknown theme id falls back to the Harness theme for the appearance", () => {
    expect(syntaxThemeFor({ themeId: "nope", resolved: "dark" }).name).toBe("pierre-dark");
  });

  test("a name in the failed set is replaced by the Pierre default", () => {
    expect(syntaxThemeFor({ themeId: "dracula", resolved: "dark" }, new Set(["dracula"])).name).toBe("pierre-dark");
  });
});

describe("markSyntaxThemeFailed", () => {
  test("records a new failure once, notifies listeners once, and stops after unsubscribe", () => {
    let hits = 0;
    const off = onSyntaxThemeFailed(() => hits++);
    markSyntaxThemeFailed("l0-test-theme-a");
    markSyntaxThemeFailed("l0-test-theme-a");
    expect(hits).toBe(1);
    expect(failedSyntaxThemes().has("l0-test-theme-a")).toBe(true);
    off();
    markSyntaxThemeFailed("l0-test-theme-b");
    expect(hits).toBe(1);
    expect(failedSyntaxThemes().has("l0-test-theme-b")).toBe(true);
  });

  test("Pierre's own defaults are never marked failed (there is nothing to fall back to)", () => {
    let hits = 0;
    const off = onSyntaxThemeFailed(() => hits++);
    markSyntaxThemeFailed("pierre-light");
    markSyntaxThemeFailed("pierre-dark");
    off();
    expect(hits).toBe(0);
    expect(failedSyntaxThemes().has("pierre-light")).toBe(false);
  });

  test("once marked, syntaxThemeFor with the global set falls back", () => {
    markSyntaxThemeFailed("dracula");
    expect(syntaxThemeFor({ themeId: "dracula", resolved: "dark" }, failedSyntaxThemes()).name).toBe("pierre-dark");
  });
});

import { expect, test } from "bun:test";
import { createTokenCache, syntaxThemeFor, type Lines } from "./syntax";

test("the syntax theme follows the app theme, with Pierre's default when it has none or it failed", () => {
  expect(syntaxThemeFor({ themeId: "harness-dark", resolved: "dark" })).toEqual({
    appearance: "dark",
    name: "pierre-dark",
    theme: { light: "pierre-light", dark: "pierre-dark" },
    themeType: "dark",
  });
  const oneDark = syntaxThemeFor({ themeId: "one-dark", resolved: "dark" });
  expect(oneDark.name).toBe("one-dark-pro");
  expect(oneDark.theme).toEqual({ light: "pierre-light", dark: "one-dark-pro" });
  expect(syntaxThemeFor({ themeId: "tokyo-night-day", resolved: "light" }).name).toBe("pierre-light"); // Shiki has none
  expect(syntaxThemeFor({ themeId: "one-light", resolved: "light" }, new Set(["one-light"])).name).toBe("pierre-light");
  expect(syntaxThemeFor({ themeId: "gone", resolved: "light" }).name).toBe("pierre-light");
});

const lines = (s: string): Lines => [[{ text: s }]];

test("concurrent requests for one block share a tokenize call; later ones hit the cache", async () => {
  const calls: string[] = [];
  const cache = createTokenCache(async (text, lang, theme) => (calls.push(`${theme}/${lang}/${text}`), lines(text)));
  const [a, b] = await Promise.all([cache.request("x", "ts", "t"), cache.request("x", "ts", "t")]);
  expect(a).toBe(b);
  expect(cache.get("x", "ts", "t")).toBe(a);
  await cache.request("x", "ts", "t");
  await cache.request("x", "ts", "other-theme");
  expect(calls).toEqual(["t/ts/x", "other-theme/ts/x"]);
});

test("past the limit the least recently used block is evicted", async () => {
  const cache = createTokenCache(async (text) => lines(text), 2);
  await cache.request("a", "ts", "t");
  await cache.request("b", "ts", "t");
  cache.get("a", "ts", "t"); // touch a, so b is the oldest
  await cache.request("c", "ts", "t");
  expect(cache.size).toBe(2);
  expect(cache.get("b", "ts", "t")).toBeUndefined();
  expect(cache.get("a", "ts", "t")).toBeDefined();
});

test("a failed tokenize isn't cached, so the next request retries", async () => {
  let fail = true;
  const cache = createTokenCache(async (text) => {
    if (fail) throw new Error("theme missing");
    return lines(text);
  });
  await expect(cache.request("x", "ts", "t")).rejects.toThrow("theme missing");
  expect(cache.get("x", "ts", "t")).toBeUndefined();
  fail = false;
  expect(await cache.request("x", "ts", "t")).toEqual(lines("x"));
});

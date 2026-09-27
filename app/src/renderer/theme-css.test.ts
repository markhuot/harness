// The dark tokens exist twice in styles.css (data-theme="dark", and the prefers-color-scheme
// fallback used before the attribute is set). They must never drift apart.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(join(import.meta.dir, "styles.css"), "utf8");

function vars(selectorStart: string): Record<string, string> {
  const i = css.indexOf(selectorStart);
  if (i < 0) throw new Error(`missing ${selectorStart}`);
  const body = css.slice(css.indexOf("{", i) + 1, css.indexOf("}", i));
  return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
}

test("dark tokens are identical in the data-theme block and the pre-attribute fallback", () => {
  const explicit = vars(':root[data-theme="dark"] {');
  const fallback = vars(":root:not([data-theme]) {");
  expect(Object.keys(explicit).length).toBeGreaterThan(20);
  expect(fallback).toEqual(explicit);
});

test("every themed light token has a dark value", () => {
  const light = vars(":root {");
  const dark = vars(':root[data-theme="dark"] {');
  const themed = Object.keys(light).filter((k) => /^--(bg|border|text|accent|focus|shadow|overlay|c-|green|red|amber|violet)/.test(k));
  expect(themed.filter((k) => !(k in dark))).toEqual([]);
});

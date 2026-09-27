// The phone mirrors the desktop's tokens; this fails when styles.css changes without tokens.ts.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CSS_VAR, dark, light, type Palette } from "./tokens";

const css = readFileSync(join(import.meta.dir, "../../../app/src/renderer/styles.css"), "utf8");

function block(selectorStart: string): Record<string, string> {
  const i = css.indexOf(selectorStart);
  if (i < 0) throw new Error(`missing ${selectorStart}`);
  const body = css.slice(css.indexOf("{", i) + 1, css.indexOf("}", i));
  return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim().toLowerCase().replace(/\s+/g, " ")]));
}

const norm = (v: string) => v.toLowerCase().replace(/\s+/g, " ").trim();

function compare(p: Palette, vars: Record<string, string>) {
  const mismatches: string[] = [];
  for (const [key, cssVar] of Object.entries(CSS_VAR) as [keyof Palette, string][]) {
    if (!(cssVar in vars)) mismatches.push(`${cssVar} missing in styles.css`);
    else if (norm(p[key]) !== vars[cssVar]) mismatches.push(`${key}: ${p[key]} ≠ ${cssVar}: ${vars[cssVar]}`);
  }
  return mismatches;
}

test("light palette matches styles.css :root", () => {
  expect(compare(light, block(":root {"))).toEqual([]);
});

test("dark palette matches styles.css :root[data-theme=dark]", () => {
  expect(compare(dark, block(':root[data-theme="dark"] {'))).toEqual([]);
});

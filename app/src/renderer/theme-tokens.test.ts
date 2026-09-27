// The color tokens live in the theme registry (@harness/shared/themes), not in CSS. These keep the
// stylesheets and the registry in step: every var(--x) the renderer uses must be defined by the
// theme, by a stylesheet, or inline by a component; and no stylesheet may define a theme token
// itself (it would shadow the theme and pin that color in every theme).
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { CSS_VAR, THEMES } from "@harness/shared/themes";

const root = import.meta.dir;
function files(dir: string, ext: RegExp): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name), ext) : ext.test(e.name) ? [join(dir, e.name)] : []));
}
const css = files(root, /\.css$/).map((f) => ({ f: relative(root, f), text: readFileSync(f, "utf8") }));
const tsx = files(root, /\.tsx?$/).filter((f) => !f.endsWith(".test.ts")).map((f) => readFileSync(f, "utf8"));
const themeVars = new Set(Object.values(CSS_VAR));

test("every var() the renderer uses is defined somewhere", () => {
  const defined = new Set<string>(themeVars);
  for (const { text } of css) for (const m of text.matchAll(/(--[\w-]+)\s*:/g)) defined.add(m[1]!);
  for (const text of tsx) for (const m of text.matchAll(/["'`](--[\w-]+)["'`]/g)) defined.add(m[1]!);
  const used = new Map<string, string>();
  for (const { f, text } of css) for (const m of text.matchAll(/var\(\s*(--[\w-]+)/g)) used.set(m[1]!, f);
  for (const text of tsx) for (const m of text.matchAll(/var\(\s*(--[\w-]+)/g)) used.set(m[1]!, "tsx");
  // `var(--c-${status})` in a template: the prefix must name a family of defined tokens.
  const ok = (v: string) => (v.endsWith("-") ? [...defined].some((d) => d.startsWith(v)) : defined.has(v));
  const missing = [...used].filter(([v]) => !ok(v)).map(([v, f]) => `${v} (${f})`);
  expect(missing).toEqual([]);
  // Sanity: the scan actually sees the theme tokens in use.
  for (const v of ["--bg", "--text", "--accent", "--on-accent", "--c-blocked", "--selection"]) expect(used.has(v)).toBe(true);
});

test("no stylesheet hard-codes a theme token", () => {
  const shadowing = css.flatMap(({ f, text }) => [...text.matchAll(/(--[\w-]+)\s*:/g)].filter((m) => themeVars.has(m[1]!)).map((m) => `${f}: ${m[1]}`));
  expect(shadowing).toEqual([]);
});

test("the registry covers every token for every theme the picker can show", () => {
  const gaps = THEMES.flatMap((t) => Object.keys(CSS_VAR).filter((k) => !(t.tokens as unknown as Record<string, string>)[k]).map((k) => `${t.id}.${k}`));
  expect(gaps).toEqual([]);
});

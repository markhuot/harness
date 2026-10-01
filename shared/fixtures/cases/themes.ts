// shared/src/themes (index.ts, syntax.ts, projectColor.ts) → ios/HarnessKit Logic/Themes
// (Themes/ThemesTests.swift). The theme data itself ships as Resources/themes.json
// (shared/fixtures/resources/themes.ts); these cases check the logic over it.

import { PROJECT_COLORS } from "../../src/projectColors";
import {
  findTheme,
  isAppearancePreference,
  isColor,
  normalizeThemeChoice,
  parseColor,
  pluginThemeInfo,
  projectKeyColors,
  resolveThemeChoice,
  SHADOW_TOKENS,
  syntaxThemeName,
  THEMES,
  themeIdFor,
  themesFor,
  TOKEN_KEYS,
  viewerThemes,
  type AppearancePreference,
  type ThemeAppearance,
  type ThemeChoice,
} from "../../src/themes";
import type { RGBA } from "../../src/themes/color";
import { cases } from "../case";

/** Token order (ThemeToken.allCases must match) and the tokens that hold box-shadow lists. */
export const tokenKeys = TOKEN_KEYS;
export const shadowTokens = SHADOW_TOKENS;

// Stored values are `unknown` (preference files, hand edits), so non-strings are included.
const ID_INPUTS: Record<string, unknown> = {
  "light theme": "harness-light",
  "dark theme": "catppuccin-mocha",
  "last theme": "rose-pine",
  "wrong case": "Harness-Light",
  "padded": " nord ",
  "unknown": "solarized",
  "empty": "",
  "null": null,
  "number": 42,
  "boolean": true,
  "array of an id": ["dracula"],
  "object": { id: "dracula" },
};

export const findThemeCases = cases((id: unknown) => findTheme(id)?.id ?? null, ID_INPUTS);

export const themesForCases = cases((a: ThemeAppearance) => themesFor(a).map((t) => t.id), { light: "light", dark: "dark" });

export const themeIdForCases = cases(
  ({ appearance, id }: { appearance: ThemeAppearance; id: unknown }) => themeIdFor(appearance, id),
  Object.fromEntries(
    (["light", "dark"] as const).flatMap((appearance) => Object.entries(ID_INPUTS).map(([name, id]) => [`${appearance}: ${name}`, { appearance, id }])),
  ),
);

export const isAppearancePreferenceCases = cases(isAppearancePreference, {
  system: "system",
  light: "light",
  dark: "dark",
  "capitalized rejected": "Light",
  "auto rejected": "auto",
  "padded rejected": " dark",
  empty: "",
  null: null,
  number: 1,
  boolean: false,
});

export const normalizeThemeChoiceCases = cases(normalizeThemeChoice as (v: unknown) => ThemeChoice, {
  "null is all defaults": null,
  "empty object is all defaults": {},
  "valid choice kept": { appearance: "dark", lightTheme: "one-light", darkTheme: "dracula" },
  "system kept": { appearance: "system", lightTheme: "github-light", darkTheme: "nord" },
  "light kept": { appearance: "light", lightTheme: "rose-pine-dawn", darkTheme: "tokyo-night" },
  "swapped appearances fall back": { appearance: "light", lightTheme: "dracula", darkTheme: "one-light" },
  "unknown ids fall back": { appearance: "dark", lightTheme: "nope", darkTheme: "also-nope" },
  "non-string ids fall back": { appearance: "dark", lightTheme: 7, darkTheme: ["dracula"] },
  "bad appearance becomes system": { appearance: "Dark", lightTheme: "one-light", darkTheme: "nord" },
  "non-string appearance becomes system": { appearance: true },
  "extra keys ignored": { appearance: "light", lightTheme: "one-light", darkTheme: "nord", accent: "red" },
  "a string is not a choice": "dark",
  "an array is not a choice": ["dark", "one-light", "nord"],
});

const PREFS: AppearancePreference[] = ["system", "light", "dark"];
export const resolveThemeChoiceCases = cases(
  ({ choice, systemDark }: { choice: ThemeChoice; systemDark: boolean }) => {
    const r = resolveThemeChoice(choice, systemDark);
    return { appearance: r.appearance, themeId: r.theme.id };
  },
  [
    ...PREFS.flatMap((appearance) =>
      [false, true].map((systemDark) => [`${appearance}, system ${systemDark ? "dark" : "light"}`, { choice: { appearance, lightTheme: "solarized-light", darkTheme: "gruvbox-dark" }, systemDark }] as const),
    ),
    ["light with an unknown light pick", { choice: { appearance: "light", lightTheme: "gone", darkTheme: "nord" }, systemDark: true }] as const,
    ["dark with a light theme as the dark pick", { choice: { appearance: "dark", lightTheme: "one-light", darkTheme: "one-light" }, systemDark: false }] as const,
    ["system dark with a dark theme as the light pick", { choice: { appearance: "system", lightTheme: "dracula", darkTheme: "dracula" }, systemDark: true }] as const,
    ["system light with a dark theme as the light pick", { choice: { appearance: "system", lightTheme: "dracula", darkTheme: "dracula" }, systemDark: false }] as const,
  ],
);

export const pluginThemeInfoCases = cases((id: string) => pluginThemeInfo(findTheme(id)!), Object.fromEntries(THEMES.map((t) => [t.id, t.id])));

type SyntaxInput = { appearance: ThemeAppearance; syntaxTheme: string | null; failed: string[] };
export const syntaxThemeNameCases = cases(({ appearance, syntaxTheme, failed }: SyntaxInput) => syntaxThemeName(appearance, syntaxTheme, new Set(failed)), {
  ...Object.fromEntries(THEMES.map((t) => [`theme ${t.id}`, { appearance: t.appearance, syntaxTheme: t.syntaxTheme, failed: [] }])),
  "null light": { appearance: "light", syntaxTheme: null, failed: [] },
  "null dark": { appearance: "dark", syntaxTheme: null, failed: [] },
  "empty string": { appearance: "dark", syntaxTheme: "", failed: [] },
  "failed to resolve": { appearance: "dark", syntaxTheme: "dracula", failed: ["nord", "dracula"] },
  "another theme failed": { appearance: "dark", syntaxTheme: "dracula", failed: ["nord"] },
  "upper case rejected": { appearance: "light", syntaxTheme: "Dracula", failed: [] },
  "leading dash rejected": { appearance: "light", syntaxTheme: "-dracula", failed: [] },
  "leading digit accepted": { appearance: "light", syntaxTheme: "1c-light", failed: [] },
  "single character": { appearance: "light", syntaxTheme: "a", failed: [] },
  "64 characters accepted": { appearance: "light", syntaxTheme: "a".repeat(64), failed: [] },
  "65 characters rejected": { appearance: "light", syntaxTheme: "a".repeat(65), failed: [] },
  "underscore rejected": { appearance: "light", syntaxTheme: "one_dark", failed: [] },
  "dot rejected": { appearance: "light", syntaxTheme: "one.dark", failed: [] },
  "trailing newline rejected": { appearance: "light", syntaxTheme: "dracula\n", failed: [] },
  "space rejected": { appearance: "light", syntaxTheme: "one dark", failed: [] },
  "non-ascii letter rejected": { appearance: "light", syntaxTheme: "drácula", failed: [] },
});

export const viewerThemesCases = cases(({ appearance, name }: { appearance: ThemeAppearance; name: string }) => viewerThemes(appearance, name), {
  light: { appearance: "light", name: "github-light-default" },
  dark: { appearance: "dark", name: "dracula" },
});

// Every preset on every theme (light and dark washes, AA nudging toward black or white), plus
// custom hex, no color, and colors that need the most nudging.
type KeyInput = { color: string | null; themeId: string };
export const projectKeyColorsCases = cases(({ color, themeId }: KeyInput) => projectKeyColors(color, findTheme(themeId)!.tokens), [
  ...THEMES.flatMap((t) => PROJECT_COLORS.map((c) => [`${c.id} on ${t.id}`, { color: c.id, themeId: t.id }] as const)),
  ["no color is the accent badge", { color: null, themeId: "harness-light" }] as const,
  ["empty is the accent badge", { color: "", themeId: "harness-dark" }] as const,
  ["unusable value is the accent badge", { color: "bogus", themeId: "dracula" }] as const,
  ["custom hex", { color: "#123456", themeId: "harness-dark" }] as const,
  ["custom hex3 upper case", { color: "#F0A", themeId: "one-light" }] as const,
  ["white on a light theme nudges all the way", { color: "#ffffff", themeId: "harness-light" }] as const,
  ["black on a dark theme nudges all the way", { color: "#000000", themeId: "harness-dark" }] as const,
  ["black on a light theme is already readable", { color: "#000000", themeId: "solarized-light" }] as const,
  ["white on a dark theme is already readable", { color: "#ffffff", themeId: "nord" }] as const,
]);

// Box shadows. The TS app hands shadow tokens to CSS as-is, so there's no TS parser: this is the
// reference for BoxShadow.parseList in Swift, covering the syntax the theme tokens use
// (`[inset] <x> <y> [blur] [spread] [color]`, comma-separated layers).
interface BoxShadow {
  x: number;
  y: number;
  blur: number;
  spread: number;
  /** null: no color given (CSS currentColor) */
  color: RGBA | null;
  inset: boolean;
}

const LENGTH = /^(-?)(\d+(?:\.\d+)?|\.\d+)(px)?$/;

function splitLayers(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function parseLayer(layer: string): BoxShadow | null {
  const tokens = layer.match(/[a-z]+\([^)]*\)|[^\s]+/gi) ?? [];
  let inset = false;
  let color: RGBA | null = null;
  const lengths: number[] = [];
  let lengthsDone = false;
  for (const tok of tokens) {
    if (tok.toLowerCase() === "inset") {
      if (inset) return null;
      inset = true;
      if (lengths.length) lengthsDone = true;
      continue;
    }
    const m = LENGTH.exec(tok);
    if (m) {
      const n = Number(m[1]! + m[2]!);
      if (!m[3] && n !== 0) return null;
      if (lengthsDone) return null;
      lengths.push(n === 0 ? 0 : n);
      continue;
    }
    if (isColor(tok)) {
      if (color) return null;
      color = parseColor(tok);
      if (lengths.length) lengthsDone = true;
      continue;
    }
    return null;
  }
  if (lengths.length < 2 || lengths.length > 4) return null;
  const [x, y, blur = 0, spread = 0] = lengths as [number, number, number?, number?];
  if (blur < 0) return null;
  return { x, y, blur, spread, color, inset };
}

function parseBoxShadows(s: string): BoxShadow[] | null {
  const layers = splitLayers(s).map(parseLayer);
  return layers.every((l): l is BoxShadow => l !== null) ? layers : null;
}

const realShadows: [string, string][] = [];
for (const t of THEMES) for (const k of SHADOW_TOKENS) if (!realShadows.some(([, v]) => v === t.tokens[k])) realShadows.push([`${t.id} ${k}`, t.tokens[k]]);

export const boxShadowCases = cases(parseBoxShadows, [
  ...realShadows,
  ["inset ring", "inset 0 0 0 1px #fff"],
  ["inset last, negative offsets", "-1px -2px 4px 1px rgba(0,0,0,.5) inset"],
  ["upper-case inset", "INSET 0 1px #000"],
  ["color first", "#00000080 0 2px 4px"],
  ["no color", "2px 3px"],
  ["fractional lengths", "1.5px .5px 0 #000"],
  ["negative zero", "-0 0 #000"],
  ["no space after comma", "0 1px #000,0 2px #111"],
  ["none rejected", "none"],
  ["empty rejected", ""],
  ["one length rejected", "1px #000"],
  ["five lengths rejected", "0 1px 2px 3px 4px #000"],
  ["negative blur rejected", "0 1px -2px #000"],
  ["unitless non-zero rejected", "5 5 #000"],
  ["em rejected", "0 1em #000"],
  ["named color rejected", "0 1px 2px red"],
  ["two colors rejected", "0 1px 2px #000 #fff"],
  ["double inset rejected", "inset inset 0 1px #000"],
  ["length after color rejected", "0 1px rgba(0, 0, 0, 0.5) 3px"],
  ["empty layer rejected", "0 1px #000, "],
  ["bad layer anywhere rejects the list", "0 1px #000, bogus"],
]);

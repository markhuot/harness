// Build a full token set from a theme's palette. A theme names its surfaces, text levels, accent
// and hues straight from the official palette; everything else (hover washes, soft fills, focus,
// shadows, on-colors) is derived here the same way for every theme, so the themes stay consistent
// with each other and with the Harness defaults.
//
// Readability is part of the mapping: text, accent text and tone text are nudged toward the
// theme's ink only as far as WCAG AA (4.5:1) requires, status dots toward 3:1 (non-text UI).
// Colors that already pass are used verbatim. themes.test.ts re-checks the final tokens.

import { alpha, contrast, luminance, mix, over, parseColor, readable, toHex } from "./color";
import type { Theme, ThemeAppearance, ThemeTokens } from "./types";

export interface ThemeSpec {
  id: string;
  name: string;
  appearance: ThemeAppearance;
  source: string;
  syntaxTheme: string | null;
  bg: string;
  bgSidebar: string;
  bgElev: string;
  bgSunken: string;
  bgColumn: string;
  border: string;
  borderStrong: string;
  text: string;
  text2: string;
  text3: string;
  accent: string;
  /** Defaults to the accent */
  accentText?: string;
  /** The strongest ink to nudge text toward when the palette's own text misses AA (default: text) */
  ink?: string;
  planning: string;
  in_progress: string;
  blocked: string;
  review: string;
  done: string;
  green: string;
  red: string;
  amber: string;
  violet: string;
  /** Escape hatch for a token the derivation gets wrong for this palette */
  overrides?: Partial<ThemeTokens>;
}

export const AA = 4.5;
export const AA_NON_TEXT = 3;
/** What body text aims for (WCAG AAA) where the palette allows */
export const TEXT_TARGET = 7;

const SHADOWS: Record<ThemeAppearance, Pick<ThemeTokens, "shadowSm" | "shadow" | "shadowLg" | "overlay">> = {
  light: {
    shadowSm: "0 1px 2px rgba(15, 17, 22, 0.06)",
    shadow: "0 1px 2px rgba(15, 17, 22, 0.05), 0 4px 12px rgba(15, 17, 22, 0.05)",
    shadowLg: "0 8px 30px rgba(15, 17, 22, 0.14), 0 2px 6px rgba(15, 17, 22, 0.06)",
    overlay: "rgba(20, 21, 26, 0.28)",
  },
  dark: {
    shadowSm: "0 1px 2px rgba(0, 0, 0, 0.3)",
    shadow: "0 1px 2px rgba(0, 0, 0, 0.35), 0 4px 14px rgba(0, 0, 0, 0.25)",
    shadowLg: "0 12px 40px rgba(0, 0, 0, 0.5), 0 2px 8px rgba(0, 0, 0, 0.3)",
    overlay: "rgba(0, 0, 0, 0.5)",
  },
};

const lum = (c: string) => luminance(parseColor(c).rgb);

export function defineTheme(s: ThemeSpec): Theme {
  const light = s.appearance === "light";
  const surfaces = [s.bg, s.bgElev, s.bgSidebar, s.bgColumn, s.bgSunken];
  // The theme's dark ink: its text (light themes) or its page (dark themes).
  const dark = lum(s.text) < lum(s.bg) ? s.text : s.bg;
  const flat = (c: string, backdrop = s.bgElev) => toHex(over(c, backdrop));
  const soft = (c: string) => alpha(c, light ? 0.12 : 0.15);

  // Nudge targets: text levels move toward the text color (keeps their tint); hues move toward
  // black or white, which keeps them recognizably the palette's hue.
  const inkMax = light ? "#000000" : "#ffffff";
  // Body text aims for 7:1 so the secondary levels have room under it; text-3 must reach AA, and
  // text-2 sits at least halfway (geometrically) between the two so the hierarchy survives
  // palettes whose muted grays all bunch up just under 4.5:1.
  const textBacks = [...surfaces, flat(alpha(s.text, light ? 0.085 : 0.1), s.bgSidebar)];
  const text = readable(s.text, textBacks, TEXT_TARGET, s.ink ?? inkMax);
  const text3 = readable(s.text3, surfaces, AA, text);
  const floor = (c: string) => Math.min(...surfaces.map((b) => contrast(c, b)));
  const text2 = readable(s.text2, surfaces, Math.max(AA, Math.sqrt(floor(text) * floor(text3))), text);

  const accentSoft = alpha(s.accent, light ? 0.12 : 0.18);
  const accentText = readable(s.accentText ?? s.accent, [...surfaces, flat(accentSoft)], AA, inkMax);

  // On-colors: white or the theme's dark ink, whichever reads better; if neither reaches AA, the
  // fill darkens (under white) or lightens (under the dark ink) until it does. The hue stays.
  const onFor = (fill: string) => (contrast("#ffffff", fill) >= contrast(dark, fill) ? "#ffffff" : dark);
  const away = (on: string) => (on === "#ffffff" ? "#000000" : "#ffffff");
  const onAccent = onFor(s.accent);
  const accent = readable(s.accent, [onAccent], AA, away(onAccent));
  const accentHover = readable(mix(accent, light ? "#000000" : "#ffffff", 0.1), [onAccent], AA, away(onAccent));

  // Tones are used as text on the surfaces and inside their own soft pills (on cards and the page).
  const tone = (c: string) => readable(c, [s.bg, s.bgElev, s.bgColumn, flat(soft(c)), flat(soft(c), s.bg)], AA, inkMax);
  const green = tone(s.green);
  const amber = tone(s.amber);
  const violet = tone(s.violet);
  const red = tone(s.red);
  // Solid danger buttons get their own fill, so red text can stay readable on dark surfaces.
  const onDanger = onFor(s.red);
  const redSolid = readable(s.red, [onDanger], AA, away(onDanger));
  const onAmber = onFor(amber);

  const status = (c: string) => readable(c, [s.bgColumn, s.bgElev], AA_NON_TEXT, inkMax);

  const tokens: ThemeTokens = {
    bg: s.bg,
    bgSidebar: s.bgSidebar,
    bgElev: s.bgElev,
    bgSunken: s.bgSunken,
    bgColumn: s.bgColumn,
    bgHover: alpha(s.text, light ? 0.05 : 0.06),
    bgActive: alpha(s.text, light ? 0.085 : 0.1),
    border: s.border,
    borderStrong: s.borderStrong,
    text,
    text2,
    text3,
    accent,
    accentHover,
    accentSoft,
    accentText,
    onAccent,
    focus: alpha(s.accent, light ? 0.35 : 0.45),
    selection: alpha(s.accent, light ? 0.2 : 0.3),
    ...SHADOWS[s.appearance],
    planning: status(s.planning),
    in_progress: status(s.in_progress),
    blocked: status(s.blocked),
    review: status(s.review),
    done: status(s.done),
    green,
    greenSoft: soft(s.green),
    red,
    redSoft: soft(s.red),
    redSolid,
    onDanger,
    amber,
    amberSoft: soft(s.amber),
    onAmber,
    violet,
    violetSoft: soft(s.violet),
    diffAdd: green,
    diffAddSoft: soft(s.green),
    diffDel: red,
    diffDelSoft: soft(s.red),
    ...s.overrides,
  };
  return { id: s.id, name: s.name, appearance: s.appearance, source: s.source, syntaxTheme: s.syntaxTheme, tokens };
}

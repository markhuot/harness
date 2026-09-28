// A project key badge in the active theme: a soft wash of the project's color with the color as
// text, nudged toward the theme's ink only as far as AA needs on every surface the badge sits on.
// No color → the theme's accent badge, as before projects had colors.

import { projectColorHex } from "../projectColors";
import { alpha, luminance, over, parseColor, readable, toHex } from "./color";
import type { ThemeTokens } from "./types";

const AA = 4.5;

export interface ProjectKeyColors {
  bg: string;
  fg: string;
}

const cache = new Map<string, ProjectKeyColors>();

export function projectKeyColors(color: string | null | undefined, tokens: ThemeTokens): ProjectKeyColors {
  const hex = projectColorHex(color);
  if (!hex) return { bg: tokens.accentSoft, fg: tokens.accentText };
  const id = `${hex}|${tokens.bg}|${tokens.bgElev}|${tokens.bgSidebar}|${tokens.bgColumn}`;
  const hit = cache.get(id);
  if (hit) return hit;
  const light = luminance(parseColor(tokens.bg).rgb) > 0.5;
  const bg = alpha(hex, light ? 0.14 : 0.2);
  // Sidebar, board, cards and headers: the wash composited over each.
  const backdrops = [tokens.bg, tokens.bgElev, tokens.bgSidebar, tokens.bgColumn].map((s) => toHex(over(bg, s)));
  const fg = readable(hex, backdrops, AA, light ? "#000000" : "#ffffff");
  const out = { bg, fg };
  if (cache.size > 500) cache.clear();
  cache.set(id, out);
  return out;
}

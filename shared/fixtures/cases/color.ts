// shared/src/themes/color.ts → ios/HarnessKit Logic/Themes/CSSColor.swift (ThemeColorTests.swift).

import { alpha, contrast, distance, isColor, luminance, mix, oklab, over, parseColor, readable, toHex, type RGB, type RGBA } from "../../src/themes/color";
import { cases } from "../case";

function tryParse(s: string): RGBA | null {
  try {
    return parseColor(s);
  } catch {
    return null;
  }
}

const COLOR_INPUTS: Record<string, string> = {
  "hex3 lower": "#fff",
  "hex3 upper": "#FFF",
  "hex3 mixed": "#a1C",
  "hex4 alpha expands": "#0008",
  "hex6": "#5e6ad2",
  "hex6 upper": "#5E6AD2",
  "hex8 half alpha": "#00000080",
  "hex8 zero alpha": "#12345600",
  "hex8 full alpha": "#123456ff",
  "hex2 rejected": "#12",
  "hex5 rejected": "#12345",
  "hex7 rejected": "#1234567",
  "hex9 rejected": "#123456789",
  "non-hex digit rejected": "#gggggg",
  "bare hash rejected": "#",
  "no hash rejected": "ffffff",
  "surrounding spaces trimmed": "  #abc  ",
  "nbsp and bom trimmed": " #abc﻿",
  "crlf trimmed": "\r\n#abc\r\n",
  "line separator trimmed": " #abc ",
  "NEL is not JS whitespace": "\u0085#abc",
  "rgb tight": "rgb(1,2,3)",
  "rgb upper": "RGB(1, 2, 3)",
  "rgba token style": "rgba(15, 17, 22, 0.045)",
  "rgb with alpha accepted": "rgb(1, 2, 3, 0.5)",
  "rgba without alpha accepted": "rgba(1, 2, 3)",
  "spaces around everything": "rgba(  1 , 2 ,3 , 1  )",
  "tabs and newlines inside": "rgb(\t1,\n2,\r3)",
  "nbsp inside counts as whitespace": "rgb( 1, 2, 3)",
  "NEL inside rejected": "rgb(\u00851, 2, 3)",
  "channels over 255 kept": "rgb(300, 0, 0)",
  "alpha over 1 kept": "rgba(0, 0, 0, 2)",
  "alpha zero": "rgba(0, 0, 0, 0)",
  "fractional channels": "rgb(1.5, 2.25, .5)",
  "trailing dot": "rgb(1., 2, 3)",
  "leading zeros": "rgb(007, 010, 0.50)",
  "two dots parse as NaN": "rgb(1.2.3, 0, 0)",
  "lone dot parses as NaN": "rgba(0, 0, 0, .)",
  "negative rejected": "rgb(-1, 0, 0)",
  "percent rejected": "rgb(1%, 2, 3)",
  "exponent rejected": "rgb(1e2, 0, 0)",
  "space separated rejected": "rgb(1 2 3)",
  "slash alpha rejected": "rgb(1 2 3 / 0.5)",
  "five args rejected": "rgba(1, 2, 3, 4, 5)",
  "two args rejected": "rgb(1, 2)",
  "trailing junk rejected": "rgb(1, 2, 3)x",
  "unclosed rejected": "rgb(1, 2, 3",
  "space before paren rejected": "rgb (1, 2, 3)",
  "rgbaa rejected": "rgbaa(1, 2, 3)",
  "arabic-indic digit rejected": "rgb(١, 2, 3)",
  "fullwidth digit rejected": "rgb(１, 2, 3)",
  "hsl rejected": "hsl(0, 0%, 0%)",
  "named color rejected": "red",
  "transparent rejected": "transparent",
  "css var rejected": "var(--bg)",
  "empty rejected": "",
  "whitespace only rejected": "   ",
  "shadow list rejected": "0 1px 2px rgba(0, 0, 0, 0.3)",
};

export const parseColorCases = cases(tryParse, COLOR_INPUTS);
export const isColorCases = cases(isColor, COLOR_INPUTS);

export const toHexCases = cases(toHex, {
  black: [0, 0, 0] as RGB,
  white: [255, 255, 255] as RGB,
  "halves round up": [0.5, 1.5, 2.5] as RGB,
  "just under a half rounds down": [0.49999999999999994, 127.49, 254.4999] as RGB,
  "clamped high": [255.4, 255.5, 1000] as RGB,
  "clamped low": [-0.5, -0.6, -1000] as RGB,
  "single digit pads": [1, 10, 15] as RGB,
});

export const overCases = cases(({ fg, backdrop }: { fg: string; backdrop: string }) => over(fg, backdrop), {
  "opaque fg wins": { fg: "#5e6ad2", backdrop: "#ffffff" },
  "half black over white": { fg: "rgba(0, 0, 0, 0.5)", backdrop: "#ffffff" },
  "token over dark": { fg: "rgba(94, 106, 210, 0.12)", backdrop: "#111214" },
  "translucent backdrop composited over white first": { fg: "rgba(0, 0, 0, 0.5)", backdrop: "rgba(0, 0, 0, 0.5)" },
  "hex8 fg": { fg: "#ff000080", backdrop: "#0000ff" },
  "alpha above 1 extrapolates": { fg: "rgba(100, 100, 100, 2)", backdrop: "#000000" },
  "alpha zero is the backdrop": { fg: "rgba(255, 0, 0, 0)", backdrop: "#123456" },
});

export const mixCases = cases(({ a, b, amount }: { a: string; b: string; amount: number }) => mix(a, b, amount), {
  "none of b": { a: "#ff0000", b: "#0000ff", amount: 0 },
  "all of b": { a: "#ff0000", b: "#0000ff", amount: 1 },
  "half": { a: "#000000", b: "#ffffff", amount: 0.5 },
  "rounding on odd steps": { a: "#e5484d", b: "#000000", amount: 0.14 },
  "translucent inputs composited over white": { a: "rgba(0, 0, 0, 0.5)", b: "#000000", amount: 0.5 },
  "amount above 1 clamps": { a: "#808080", b: "#ffffff", amount: 3 },
  "negative amount clamps": { a: "#808080", b: "#ffffff", amount: -3 },
});

export const alphaCases = cases(({ c, a }: { c: string; a: number }) => alpha(c, a), {
  "light badge": { c: "#e5484d", a: 0.14 },
  "dark badge": { c: "#0090ff", a: 0.2 },
  "zero": { c: "#000000", a: 0 },
  "one prints as integer": { c: "#ffffff", a: 1 },
  "float noise kept": { c: "#123456", a: 0.1 + 0.2 },
  "tiny uses exponent": { c: "#123456", a: 1e-7 },
  "one millionth stays decimal": { c: "#123456", a: 0.000001 },
  "hundred-thousandth": { c: "#123456", a: 0.00001 },
  "negative": { c: "#123456", a: -0.25 },
  "large integer": { c: "#123456", a: 123456789 },
  "huge uses exponent": { c: "#123456", a: 1e21 },
  "just under 1e21 stays integer": { c: "#123456", a: 1e20 },
  "translucent source composited over white": { c: "rgba(0, 0, 0, 0.5)", a: 0.5 },
  "channels over 255 clamp": { c: "rgb(300, 0, 0)", a: 0.5 },
});

export const luminanceCases = cases(luminance, {
  black: [0, 0, 0] as RGB,
  white: [255, 255, 255] as RGB,
  "linear segment boundary": [10, 10, 10] as RGB,
  "just past the boundary": [11, 11, 11] as RGB,
  accent: [94, 106, 210] as RGB,
});

export const contrastCases = cases(({ fg, bg }: { fg: string; bg: string }) => contrast(fg, bg), {
  "black on white": { fg: "#000000", bg: "#ffffff" },
  "same color": { fg: "#ffffff", bg: "#ffffff" },
  "AA gray passes": { fg: "#767676", bg: "#ffffff" },
  "AA gray fails": { fg: "#777777", bg: "#ffffff" },
  "order does not matter": { fg: "#ffffff", bg: "#767676" },
  "translucent fg over bg": { fg: "rgba(0, 0, 0, 0.5)", bg: "#ffffff" },
  "translucent bg over white": { fg: "#000000", bg: "rgba(0, 0, 0, 0.5)" },
});

export const oklabCases = cases(oklab, { black: "#000000", white: "#ffffff", red: "#ff0000", accent: "#5e6ad2", translucent: "rgba(0, 0, 0, 0.5)" });

export const distanceCases = cases(({ a, b }: { a: string; b: string }) => distance(a, b), {
  "identical": { a: "#5e6ad2", b: "#5e6ad2" },
  "black to white": { a: "#000000", b: "#ffffff" },
  "near neighbors": { a: "#5e6ad2", b: "#515cc4" },
});

export const readableCases = cases(
  ({ color, backdrops, min, toward }: { color: string; backdrops: string[]; min: number; toward: string }) => readable(color, backdrops, min, toward),
  {
    "already readable is unchanged": { color: "#000000", backdrops: ["#ffffff"], min: 4.5, toward: "#000000" },
    "nudged toward black": { color: "#f5c400", backdrops: ["#ffffff", "#fbfbfc"], min: 4.5, toward: "#000000" },
    "nudged toward white": { color: "#3e63dd", backdrops: ["#111214", "#1a1b1e"], min: 4.5, toward: "#ffffff" },
    "every backdrop must pass": { color: "#8a8c94", backdrops: ["#ffffff", "#8a8c94"], min: 3, toward: "#000000" },
    "unreachable returns toward": { color: "#808080", backdrops: ["#808080"], min: 22, toward: "#000000" },
    "no backdrops is trivially readable": { color: "#ffff00", backdrops: [], min: 4.5, toward: "#000000" },
    "exactly at the minimum passes": { color: "#000000", backdrops: ["#ffffff"], min: 21, toward: "#ffffff" },
  },
);

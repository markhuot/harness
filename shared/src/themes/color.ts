// Small color toolkit for theme definitions and their tests: parse #hex / rgb() / rgba(), mix,
// alpha, WCAG 2.x contrast and OKLab distance. Pure; no DOM.

export type RGB = [number, number, number];
export interface RGBA {
  rgb: RGB;
  a: number;
}

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FN = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i;

/** Parse "#rgb", "#rrggbb", "#rrggbbaa", "rgb(r, g, b)" or "rgba(r, g, b, a)". Throws on anything else. */
export function parseColor(input: string): RGBA {
  const s = input.trim();
  const h = HEX.exec(s);
  if (h) {
    let v = h[1]!;
    if (v.length <= 4) v = [...v].map((x) => x + x).join("");
    const n = (i: number) => parseInt(v.slice(i, i + 2), 16);
    return { rgb: [n(0), n(2), n(4)], a: v.length === 8 ? n(6) / 255 : 1 };
  }
  const f = FN.exec(s);
  if (f) return { rgb: [Number(f[1]), Number(f[2]), Number(f[3])], a: f[4] === undefined ? 1 : Number(f[4]) };
  throw new Error(`unparseable color: ${input}`);
}

export function isColor(input: string): boolean {
  try {
    parseColor(input);
    return true;
  } catch {
    return false;
  }
}

const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
const hex2 = (n: number) => clamp(n).toString(16).padStart(2, "0");

export function toHex(rgb: RGB): string {
  return `#${hex2(rgb[0])}${hex2(rgb[1])}${hex2(rgb[2])}`;
}

/** Composite a (possibly translucent) color over an opaque backdrop. */
export function over(fg: string, backdrop: string): RGB {
  const f = parseColor(fg);
  const b = composite(backdrop);
  return [0, 1, 2].map((i) => f.rgb[i]! * f.a + b[i]! * (1 - f.a)) as RGB;
}

/** An opaque color's RGB (a translucent one is composited over white, like an unpainted page). */
function composite(c: string): RGB {
  const p = parseColor(c);
  return p.a >= 1 ? p.rgb : ([0, 1, 2].map((i) => p.rgb[i]! * p.a + 255 * (1 - p.a)) as RGB);
}

/** `amount` of `b` mixed into `a`, in sRGB (like CSS color-mix(in srgb, a, b amount)). Returns #hex. */
export function mix(a: string, b: string, amount: number): string {
  const x = composite(a);
  const y = composite(b);
  return toHex([0, 1, 2].map((i) => x[i]! + (y[i]! - x[i]!) * amount) as RGB);
}

/** rgba() of a color at the given alpha, formatted like the hand-written tokens. */
export function alpha(c: string, a: number): string {
  const [r, g, b] = composite(c);
  return `rgba(${clamp(r)}, ${clamp(g)}, ${clamp(b)}, ${a})`;
}

function channel(v: number) {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function luminance(rgb: RGB): number {
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

/** WCAG 2.x contrast ratio of fg over bg. Translucent colors are composited: fg over bg, bg over white. */
export function contrast(fg: string, bg: string): number {
  const b = composite(bg);
  const f = over(fg, toHex(b));
  const [hi, lo] = [luminance(f), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** OKLab coordinates, for perceptual distance between two (opaque) colors. */
export function oklab(c: string): [number, number, number] {
  const [r, g, b] = composite(c).map(channel) as RGB;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

export function distance(a: string, b: string): number {
  const x = oklab(a);
  const y = oklab(b);
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

/**
 * The palette color, nudged toward `toward` (the theme's text or background) in small steps only
 * as far as needed to reach `min` contrast on every backdrop. Returns the color unchanged when it
 * already passes, so faithful palette colors survive wherever they're readable.
 */
export function readable(color: string, backdrops: string[], min: number, toward: string): string {
  for (let step = 0; step <= 50; step++) {
    const c = step === 0 ? color : mix(color, toward, step / 50);
    if (backdrops.every((b) => contrast(c, b) >= min)) return c;
  }
  return toward;
}

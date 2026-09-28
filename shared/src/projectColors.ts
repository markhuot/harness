// Project colors: a project's key badge (the "HAR" chip in the sidebar, on cards, in headers)
// takes the project's color. A project stores one of the preset ids below, a custom "#rrggbb", or
// null for the theme's accent. The presets are ids rather than hex so they read the same in
// every client; the hex is the swatch, and each theme derives a readable badge from it
// (projectKeyColors in @harness/shared/themes).

export const PROJECT_COLORS = [
  { id: "red", name: "Red", hex: "#e5484d" },
  { id: "orange", name: "Orange", hex: "#f76b15" },
  { id: "yellow", name: "Yellow", hex: "#f5c400" },
  { id: "lime", name: "Lime", hex: "#8bc53f" },
  { id: "green", name: "Green", hex: "#30a46c" },
  { id: "teal", name: "Teal", hex: "#12a594" },
  { id: "cyan", name: "Cyan", hex: "#00a2c7" },
  { id: "blue", name: "Blue", hex: "#0090ff" },
  { id: "indigo", name: "Indigo", hex: "#3e63dd" },
  { id: "purple", name: "Purple", hex: "#8e4ec6" },
  { id: "pink", name: "Pink", hex: "#d6409f" },
] as const;

export type ProjectColorId = (typeof PROJECT_COLORS)[number]["id"];

const BY_ID = new Map<string, (typeof PROJECT_COLORS)[number]>(PROJECT_COLORS.map((c) => [c.id, c]));
const HEX6 = /^#[0-9a-f]{6}$/i;
const HEX3 = /^#[0-9a-f]{3}$/i;

export function isProjectColorId(v: unknown): v is ProjectColorId {
  return typeof v === "string" && BY_ID.has(v);
}

/**
 * The stored form of a color the user picked: a preset id, a lower-case "#rrggbb" ("#abc"
 * expands), or null for none (null or ""). Anything else is undefined, which callers refuse.
 */
export function normalizeProjectColor(v: unknown): string | null | undefined {
  if (v === null) return null;
  if (typeof v !== "string") return undefined;
  const s = v.trim().toLowerCase();
  if (s === "") return null;
  if (BY_ID.has(s)) return s;
  if (HEX6.test(s)) return s;
  if (HEX3.test(s)) return `#${[...s.slice(1)].map((x) => x + x).join("")}`;
  return undefined;
}

/** The swatch hex for a stored color (preset or custom), or null for none / unusable values. */
export function projectColorHex(color: string | null | undefined): string | null {
  const n = normalizeProjectColor(color ?? null);
  if (!n) return null;
  return BY_ID.get(n)?.hex ?? n;
}

/** Display name: the preset's name, "Custom" for a hex, "Default" for none. */
export function projectColorName(color: string | null | undefined): string {
  const n = normalizeProjectColor(color ?? null);
  if (!n) return "Default";
  return BY_ID.get(n)?.name ?? "Custom";
}

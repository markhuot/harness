import { expect, test } from "bun:test";
import { normalizeProjectColor, PROJECT_COLORS, projectColorHex, projectColorName } from "./projectColors";
import { contrast, over, projectKeyColors, THEMES } from "./themes";
import { toHex } from "./themes/color";

test("eleven presets with distinct ids and hexes", () => {
  expect(PROJECT_COLORS).toHaveLength(11);
  expect(new Set(PROJECT_COLORS.map((c) => c.id)).size).toBe(11);
  expect(new Set(PROJECT_COLORS.map((c) => c.hex)).size).toBe(11);
});

test("normalizeProjectColor: presets, hex forms, clearing and refusals", () => {
  expect(normalizeProjectColor("blue")).toBe("blue");
  expect(normalizeProjectColor(" Blue ")).toBe("blue");
  expect(normalizeProjectColor("#AbCdEf")).toBe("#abcdef");
  expect(normalizeProjectColor("#abc")).toBe("#aabbcc");
  expect(normalizeProjectColor(null)).toBeNull();
  expect(normalizeProjectColor("")).toBeNull();
  expect(normalizeProjectColor("  ")).toBeNull();
  for (const bad of ["chartreuse", "#12345", "#1234567", "abcdef", "#ggg", "rgb(1,2,3)", 7, undefined, {}]) expect(normalizeProjectColor(bad)).toBeUndefined();
});

test("projectColorHex / projectColorName resolve presets, keep custom hex, and fall back for none", () => {
  expect(projectColorHex("red")).toBe("#e5484d");
  expect(projectColorHex("#123456")).toBe("#123456");
  expect(projectColorHex(null)).toBeNull();
  expect(projectColorHex("junk")).toBeNull();
  expect(projectColorName("purple")).toBe("Purple");
  expect(projectColorName("#123456")).toBe("Custom");
  expect(projectColorName(null)).toBe("Default");
});

test("no color → the theme's accent badge", () => {
  for (const t of THEMES) expect(projectKeyColors(null, t.tokens)).toEqual({ bg: t.tokens.accentSoft, fg: t.tokens.accentText });
});

test("every preset and awkward custom colors stay readable (AA) on every surface of every theme", () => {
  const colors = [...PROJECT_COLORS.map((c) => c.id), "#ffff00", "#ffffff", "#000000", "#101010", "#f0f0f0", "#00ff00"];
  const failures: string[] = [];
  for (const t of THEMES) {
    const k = t.tokens;
    for (const color of colors) {
      const { bg, fg } = projectKeyColors(color, k);
      for (const surface of [k.bg, k.bgElev, k.bgSidebar, k.bgColumn]) {
        const ratio = contrast(fg, toHex(over(bg, surface)));
        if (ratio < 4.5) failures.push(`${t.id} ${color} on ${surface}: ${ratio.toFixed(2)}`);
      }
    }
  }
  expect(failures).toEqual([]);
});

test("a readable preset keeps its own hue as text instead of washing out to the ink", () => {
  const dark = THEMES.find((t) => t.id === "harness-dark")!;
  expect(projectKeyColors("yellow", dark.tokens).fg).toBe("#f5c400");
});

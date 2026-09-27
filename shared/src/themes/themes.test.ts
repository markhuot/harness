import { describe, expect, test } from "bun:test";
import { contrast, distance, isColor, mix, over, parseColor, toHex } from "./color";
import {
  DEFAULT_DARK_THEME,
  DEFAULT_LIGHT_THEME,
  findTheme,
  harnessDark,
  harnessLight,
  normalizeThemeChoice,
  pluginThemeInfo,
  resolveThemeChoice,
  SHADOW_TOKENS,
  THEMES,
  themeCssText,
  themeIdFor,
  themesFor,
  TOKEN_KEYS,
  type Theme,
} from "./index";

// --- color math ---------------------------------------------------------------------------------

describe("color", () => {
  test("parses hex (3/6/8) and rgb()/rgba(), rejects junk", () => {
    expect(parseColor("#fff")).toEqual({ rgb: [255, 255, 255], a: 1 });
    expect(parseColor("#5e6ad2").rgb).toEqual([94, 106, 210]);
    expect(parseColor("#00000080").a).toBeCloseTo(0.502, 2);
    expect(parseColor("rgba(15, 17, 22, 0.045)")).toEqual({ rgb: [15, 17, 22], a: 0.045 });
    expect(() => parseColor("var(--bg)")).toThrow();
    expect(() => parseColor("#12")).toThrow();
  });

  test("contrast matches the WCAG reference values", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    expect(contrast("#767676", "#ffffff")).toBeCloseTo(4.54, 2); // the classic AA-passing gray
    expect(contrast("#777777", "#ffffff")).toBeLessThan(4.5);
  });

  test("translucent foregrounds are composited over the backdrop", () => {
    expect(toHex(over("rgba(0, 0, 0, 0.5)", "#ffffff"))).toBe("#808080");
    expect(contrast("rgba(0, 0, 0, 0)", "#ffffff")).toBeCloseTo(1, 5);
    expect(mix("#000000", "#ffffff", 0.5)).toBe("#808080");
  });
});

// --- registry -----------------------------------------------------------------------------------

const REQUIRED = [
  "harness-light",
  "harness-dark",
  "one-light",
  "one-dark",
  "catppuccin-latte",
  "catppuccin-frappe",
  "catppuccin-macchiato",
  "catppuccin-mocha",
  "solarized-light",
  "solarized-dark",
  "github-light",
  "github-dark",
  "dracula",
  "nord",
  "gruvbox-light",
  "gruvbox-dark",
  "tokyo-night",
  "tokyo-night-day",
  "rose-pine",
  "rose-pine-dawn",
];

describe("registry", () => {
  test("ships every required theme, with unique ids and names", () => {
    const ids = THEMES.map((t) => t.id);
    expect(ids.filter((id) => !REQUIRED.includes(id))).toEqual([]);
    expect(REQUIRED.filter((id) => !ids.includes(id))).toEqual([]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(THEMES.map((t) => t.name)).size).toBe(ids.length);
  });

  test("every theme defines every token with a parseable value", () => {
    const problems: string[] = [];
    for (const t of THEMES) {
      for (const k of TOKEN_KEYS) {
        const v = t.tokens[k];
        if (typeof v !== "string" || !v) problems.push(`${t.id}.${k} missing`);
        else if (!SHADOW_TOKENS.includes(k) && !isColor(v)) problems.push(`${t.id}.${k} = ${v}`);
      }
      const extra = Object.keys(t.tokens).filter((k) => !(TOKEN_KEYS as string[]).includes(k));
      if (extra.length) problems.push(`${t.id} has unknown tokens ${extra.join(",")}`);
      if (!t.source) problems.push(`${t.id} has no source`);
    }
    expect(problems).toEqual([]);
  });

  test("appearance matches the page: light themes have a light bg, dark themes a dark one", () => {
    const wrong = THEMES.filter((t) => (contrast(t.tokens.bg, "#000000") > contrast(t.tokens.bg, "#ffffff")) !== (t.appearance === "light")).map((t) => t.id);
    expect(wrong).toEqual([]);
    expect(themesFor("light").every((t) => t.appearance === "light")).toBe(true);
    expect(themesFor("dark").length + themesFor("light").length).toBe(THEMES.length);
  });

  test("the Harness defaults are exactly the original styles.css tokens", () => {
    // Snapshot of the hard-coded blocks the registry replaced (styles.css before themes).
    const OLD_LIGHT = "--bg: #fbfbfc; --bg-sidebar: #f3f3f5; --bg-elev: #ffffff; --bg-sunken: #f5f5f7; --bg-column: #f4f4f6; --bg-hover: rgba(15, 17, 22, 0.045); --bg-active: rgba(15, 17, 22, 0.075); --border: #e4e4e8; --border-strong: #d4d4da; --text: #1a1b1f; --text-2: #55575f; --text-3: #8a8c94; --accent: #5e6ad2; --accent-hover: #515cc4; --accent-soft: rgba(94, 106, 210, 0.12); --accent-text: #4b56c0; --focus: rgba(94, 106, 210, 0.35); --shadow-sm: 0 1px 2px rgba(15, 17, 22, 0.06); --shadow: 0 1px 2px rgba(15, 17, 22, 0.05), 0 4px 12px rgba(15, 17, 22, 0.05); --shadow-lg: 0 8px 30px rgba(15, 17, 22, 0.14), 0 2px 6px rgba(15, 17, 22, 0.06); --overlay: rgba(20, 21, 26, 0.28); --c-planning: #8a8c94; --c-in_progress: #d99a1e; --c-blocked: #e5484d; --c-review: #8e4ec6; --c-done: #30a46c; --green: #2f9a63; --green-soft: rgba(48, 164, 108, 0.12); --red: #d93d42; --red-soft: rgba(229, 72, 77, 0.1); --amber: #b7791f; --amber-soft: rgba(217, 154, 30, 0.13); --violet-soft: rgba(142, 78, 198, 0.11); --violet: #7d45b3;";
    const OLD_DARK = "--bg: #111214; --bg-sidebar: #0c0d0f; --bg-elev: #1a1b1e; --bg-sunken: #0e0f11; --bg-column: #151619; --bg-hover: rgba(255, 255, 255, 0.05); --bg-active: rgba(255, 255, 255, 0.085); --border: #26272c; --border-strong: #34363c; --text: #e8e8eb; --text-2: #a4a6ae; --text-3: #6f717a; --accent: #6e79d6; --accent-hover: #7f89e0; --accent-soft: rgba(110, 121, 214, 0.18); --accent-text: #a3abf0; --focus: rgba(110, 121, 214, 0.45); --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.3); --shadow: 0 1px 2px rgba(0, 0, 0, 0.35), 0 4px 14px rgba(0, 0, 0, 0.25); --shadow-lg: 0 12px 40px rgba(0, 0, 0, 0.5), 0 2px 8px rgba(0, 0, 0, 0.3); --overlay: rgba(0, 0, 0, 0.5); --c-planning: #7c7e87; --c-in_progress: #f0b43c; --c-blocked: #f2555a; --c-review: #a86fe0; --c-done: #3fba7d; --green: #4cc38a; --green-soft: rgba(76, 195, 138, 0.14); --red: #f2555a; --red-soft: rgba(242, 85, 90, 0.13); --amber: #f0b43c; --amber-soft: rgba(240, 180, 60, 0.13); --violet-soft: rgba(168, 111, 224, 0.15); --violet: #bf93ec;";
    const decls = (s: string) => Object.fromEntries([...s.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
    const now = (t: Theme) => decls(themeCssText(t.tokens));
    for (const [theme, old] of [
      [harnessLight, OLD_LIGHT],
      [harnessDark, OLD_DARK],
    ] as const) {
      const cur = now(theme);
      const want = decls(old);
      expect(Object.fromEntries(Object.keys(want).map((k) => [k, cur[k]]))).toEqual(want);
      // Tokens added with themes reproduce what those spots hard-coded before.
      expect(cur["--on-accent"]).toBe("#ffffff");
      expect(cur["--on-danger"]).toBe("#ffffff");
      expect(cur["--on-amber"]).toBe("#ffffff");
      expect(cur["--selection"]).toBe(want["--accent-soft"]!);
      expect(cur["--diff-add"]).toBe(want["--green"]!);
      expect(cur["--diff-del"]).toBe(want["--red"]!);
      expect(cur["--red-solid"]).toBe(want["--red"]!);
    }
  });

  test("defaults are the Harness themes", () => {
    expect(DEFAULT_LIGHT_THEME).toBe("harness-light");
    expect(DEFAULT_DARK_THEME).toBe("harness-dark");
  });
});

// --- resolution ---------------------------------------------------------------------------------

describe("resolution", () => {
  const choice = { appearance: "system" as const, lightTheme: "catppuccin-latte", darkTheme: "catppuccin-mocha" };

  test("System picks the light or dark theme by the OS; explicit appearance ignores it", () => {
    expect(resolveThemeChoice(choice, true)).toMatchObject({ appearance: "dark", theme: { id: "catppuccin-mocha" } });
    expect(resolveThemeChoice(choice, false)).toMatchObject({ appearance: "light", theme: { id: "catppuccin-latte" } });
    expect(resolveThemeChoice({ ...choice, appearance: "light" }, true).theme.id).toBe("catppuccin-latte");
    expect(resolveThemeChoice({ ...choice, appearance: "dark" }, false).theme.id).toBe("catppuccin-mocha");
  });

  test("a theme id of the wrong appearance, unknown or missing falls back to the Harness default", () => {
    expect(themeIdFor("dark", "catppuccin-latte")).toBe("harness-dark");
    expect(themeIdFor("light", "nope")).toBe("harness-light");
    expect(themeIdFor("light", undefined)).toBe("harness-light");
    expect(resolveThemeChoice({ appearance: "dark", lightTheme: "x", darkTheme: "one-light" }, false).theme.id).toBe("harness-dark");
  });

  test("normalizes stored choices (old files have only appearance)", () => {
    expect(normalizeThemeChoice(null)).toEqual({ appearance: "system", lightTheme: "harness-light", darkTheme: "harness-dark" });
    expect(normalizeThemeChoice({ appearance: "dark" })).toEqual({ appearance: "dark", lightTheme: "harness-light", darkTheme: "harness-dark" });
    expect(normalizeThemeChoice({ appearance: "sepia", lightTheme: "one-light", darkTheme: 7 })).toEqual({ appearance: "system", lightTheme: "one-light", darkTheme: "harness-dark" });
  });

  test("plugin theme info is a detached copy carrying the syntax theme", () => {
    const info = pluginThemeInfo(findTheme("dracula")!);
    expect(info).toMatchObject({ appearance: "dark", themeId: "dracula", themeName: "Dracula", syntaxTheme: "dracula" });
    info.tokens.bg = "#000000";
    expect(findTheme("dracula")!.tokens.bg).not.toBe("#000000");
  });
});

// --- accessibility ------------------------------------------------------------------------------

const AA = 4.5;
const NON_TEXT = 3;

/** Every contrast pair the UI relies on, with the minimum it must meet. */
function pairs(t: Theme): { name: string; fg: string; bg: string; min: number }[] {
  const k = t.tokens;
  const flat = (c: string, on = k.bgElev) => toHex(over(c, on));
  const surfaces = { bg: k.bg, elev: k.bgElev, sidebar: k.bgSidebar, column: k.bgColumn, sunken: k.bgSunken };
  const out: { name: string; fg: string; bg: string; min: number }[] = [];
  for (const [sn, s] of Object.entries(surfaces)) {
    for (const tk of ["text", "text2", "text3", "accentText"] as const) out.push({ name: `${tk} on ${sn}`, fg: k[tk], bg: s, min: AA });
  }
  out.push({ name: "text on selected row", fg: k.text, bg: flat(k.bgActive, k.bgSidebar), min: AA });
  out.push({ name: "accentText on accentSoft", fg: k.accentText, bg: flat(k.accentSoft), min: AA });
  out.push({ name: "onAccent on accent", fg: k.onAccent, bg: k.accent, min: AA });
  out.push({ name: "onAccent on accentHover", fg: k.onAccent, bg: k.accentHover, min: AA });
  out.push({ name: "onDanger on redSolid", fg: k.onDanger, bg: k.redSolid, min: AA });
  out.push({ name: "onAmber on amber (icon)", fg: k.onAmber, bg: k.amber, min: NON_TEXT });
  for (const [tone, soft] of [
    ["green", "greenSoft"],
    ["red", "redSoft"],
    ["amber", "amberSoft"],
    ["violet", "violetSoft"],
  ] as const) {
    out.push({ name: `${tone} on ${soft} pill`, fg: k[tone], bg: flat(k[soft]), min: AA });
    out.push({ name: `${tone} on elev`, fg: k[tone], bg: k.bgElev, min: AA });
    out.push({ name: `${tone} on bg`, fg: k[tone], bg: k.bg, min: AA });
  }
  out.push({ name: "diffAdd on diffAddSoft", fg: k.diffAdd, bg: flat(k.diffAddSoft, k.bg), min: AA });
  out.push({ name: "diffDel on diffDelSoft", fg: k.diffDel, bg: flat(k.diffDelSoft, k.bg), min: AA });
  for (const st of ["planning", "in_progress", "blocked", "review", "done"] as const) {
    out.push({ name: `${st} dot on column`, fg: k[st], bg: k.bgColumn, min: NON_TEXT });
    out.push({ name: `${st} dot on card`, fg: k[st], bg: k.bgElev, min: NON_TEXT });
  }
  return out;
}

function failures(t: Theme) {
  return pairs(t)
    .map((p) => ({ ...p, ratio: contrast(p.fg, p.bg) }))
    .filter((p) => p.ratio < p.min)
    .map((p) => `${p.name} ${p.ratio.toFixed(2)}`);
}

// The Harness defaults must stay pixel-identical, and a few of their original pairs sit under AA.
// They're pinned here exactly: fixing one (or regressing another) fails until this list is updated,
// so the exceptions can't grow silently. No other theme gets exceptions.
const HARNESS_EXCEPTIONS: Record<string, string[]> = {
  "harness-light": [
    "text3 on bg 3.24",
    "text3 on elev 3.35",
    "text3 on sidebar 3.03",
    "text3 on column 3.05",
    "text3 on sunken 3.08",
    "green on greenSoft pill 3.13",
    "green on elev 3.55",
    "green on bg 3.43",
    "red on redSoft pill 3.93",
    "red on elev 4.47",
    "red on bg 4.32",
    "amber on amberSoft pill 3.27",
    "amber on elev 3.64",
    "amber on bg 3.52",
    "diffAdd on diffAddSoft 3.05",
    "diffDel on diffDelSoft 3.81",
    "onDanger on redSolid 4.47",
    "in_progress dot on column 2.23",
    "in_progress dot on card 2.44",
    "done dot on column 2.87",
  ],
  "harness-dark": [
    "text3 on bg 3.85",
    "text3 on elev 3.54",
    "text3 on sidebar 4.00",
    "text3 on column 3.72",
    "text3 on sunken 3.94",
    "onAccent on accent 3.91",
    "onAccent on accentHover 3.20",
    "onDanger on redSolid 3.37",
    "onAmber on amber (icon) 1.86",
    "red on redSoft pill 4.37",
  ],
};

describe("contrast (WCAG AA)", () => {
  for (const t of THEMES) {
    test(`${t.name}: text, buttons, pills and status dots meet AA`, () => {
      expect(failures(t).sort()).toEqual([...(HARNESS_EXCEPTIONS[t.id] ?? [])].sort());
    });
  }

  // OKLab ΔE; ~0.02 is a just-noticeable difference, so 0.08 keeps 10px dots clearly apart.
  // (Harness' own closest pair is 0.139; low-chroma palettes like Rosé Pine Dawn top out near 0.085.)
  const MIN_STATUS_DISTANCE = 0.08;
  test("status colors stay distinguishable from each other in every theme", () => {
    const close: string[] = [];
    for (const t of THEMES) {
      const st = (["planning", "in_progress", "blocked", "review", "done"] as const).map((s) => [s, t.tokens[s]] as const);
      for (let i = 0; i < st.length; i++)
        for (let j = i + 1; j < st.length; j++) {
          const d = distance(st[i]![1], st[j]![1]);
          if (d < MIN_STATUS_DISTANCE) close.push(`${t.id}: ${st[i]![0]}/${st[j]![0]} ${d.toFixed(3)}`);
        }
    }
    expect(close).toEqual([]);
  });

  test("text levels keep their order on every surface (text > text-2 > text-3)", () => {
    const flat: string[] = [];
    for (const t of THEMES) {
      const k = t.tokens;
      for (const [sn, s] of Object.entries({ bg: k.bg, elev: k.bgElev, sidebar: k.bgSidebar, column: k.bgColumn })) {
        const [a, b, c] = [contrast(k.text, s), contrast(k.text2, s), contrast(k.text3, s)];
        if (!(a > b * 1.1 && b > c * 1.1)) flat.push(`${t.id} on ${sn}: ${a.toFixed(2)} / ${b.toFixed(2)} / ${c.toFixed(2)}`);
      }
    }
    expect(flat).toEqual([]);
  });

  test("the accent reads apart from the danger color", () => {
    const close = THEMES.filter((t) => distance(t.tokens.accent, t.tokens.red) < 0.1).map((t) => t.id);
    expect(close).toEqual([]);
  });
});

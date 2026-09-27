// The bundled themes beyond the Harness defaults. Each maps an official palette onto the semantic
// tokens (see define.ts for what's derived). Where a palette has no shade for a surface the app
// needs (a card lighter than the page, a column between the two), it's a mix of two palette
// colors, written as mix(a, b, t) so the source colors stay visible.
//
// Mapping conventions, so the themes feel related:
//   light: sidebar a step darker than the page, columns recessed, cards the lightest surface
//   dark:  sidebar the darkest, columns a step lighter than the page, cards lighter again
//   status: planning = the palette's comment/gray, in progress = yellow, blocked = red,
//           review = purple/pink, done = green; violet (conductor) = the purple

import { mix } from "./color";
import { defineTheme } from "./define";

// ---------------------------------------------------------------------------------------------
// One — Atom's One Light / One Dark.
// Source: atom/atom packages one-light-syntax, one-dark-syntax (colors.less) and one-light-ui /
// one-dark-ui; dark surfaces per the base16 "onedark" scheme (base00 #282c34 … base07 #c8ccd4).
// ---------------------------------------------------------------------------------------------

export const oneLight = defineTheme({
  id: "one-light",
  name: "One Light",
  appearance: "light",
  source: "Atom One Light — github.com/atom/atom/tree/master/packages/one-light-syntax",
  syntaxTheme: "one-light",
  bg: "#fafafa", // syntax-bg / base-background
  bgSidebar: "#eaeaeb", // ui level-2
  bgElev: "#ffffff",
  bgSunken: "#f0f0f1",
  bgColumn: mix("#fafafa", "#eaeaeb", 0.5),
  border: "#dbdbdc", // ui level-3
  borderStrong: "#c8c8ca",
  text: "#383a42", // mono-1
  text2: "#696c77", // mono-2
  text3: "#a0a1a7", // mono-3
  accent: "#4078f2", // hue-2 blue
  planning: "#a0a1a7",
  in_progress: "#c18401", // hue-6-2
  blocked: "#e45649", // hue-5
  review: "#a626a4", // hue-3
  done: "#50a14f", // hue-4
  green: "#50a14f",
  red: "#e45649",
  amber: "#986801", // hue-6
  violet: "#a626a4",
});

export const oneDark = defineTheme({
  id: "one-dark",
  name: "Atom One Dark",
  appearance: "dark",
  source: "Atom One Dark — github.com/atom/atom/tree/master/packages/one-dark-syntax; base16 onedark",
  syntaxTheme: "one-dark-pro",
  bg: "#282c34", // syntax-bg
  bgSidebar: "#21252b", // ui base (tree view, tabs)
  bgElev: "#353b45", // base01
  bgSunken: "#21252b",
  bgColumn: "#2c313a", // ui hover / level-2
  border: "#3e4451", // base02 (selection)
  borderStrong: "#545862", // base03
  text: "#d7dae0", // ui text-highlighted
  text2: "#abb2bf", // mono-1
  text3: "#828997", // mono-2
  accent: "#61afef", // hue-2 blue
  planning: "#5c6370", // mono-3 (comments)
  in_progress: "#e5c07b", // hue-6-2
  blocked: "#e06c75", // hue-5
  review: "#c678dd", // hue-3
  done: "#98c379", // hue-4
  green: "#98c379",
  red: "#e06c75",
  amber: "#d19a66", // hue-6
  violet: "#c678dd",
});

// ---------------------------------------------------------------------------------------------
// Catppuccin — github.com/catppuccin/palette (palette.json, v1). Accent: mauve, Catppuccin's
// signature; review uses pink so it reads apart from the accent. The dark flavors mark done with
// teal: their yellow and green are too close to tell apart as small dots.
// ---------------------------------------------------------------------------------------------

interface Catppuccin {
  rosewater: string;
  pink: string;
  mauve: string;
  red: string;
  peach: string;
  yellow: string;
  green: string;
  teal: string;
  blue: string;
  lavender: string;
  text: string;
  subtext1: string;
  subtext0: string;
  overlay2: string;
  overlay1: string;
  overlay0: string;
  surface2: string;
  surface1: string;
  surface0: string;
  base: string;
  mantle: string;
  crust: string;
}

const latte: Catppuccin = {
  rosewater: "#dc8a78",
  pink: "#ea76cb",
  mauve: "#8839ef",
  red: "#d20f39",
  peach: "#fe640b",
  yellow: "#df8e1d",
  green: "#40a02b",
  teal: "#179299",
  blue: "#1e66f5",
  lavender: "#7287fd",
  text: "#4c4f69",
  subtext1: "#5c5f77",
  subtext0: "#6c6f85",
  overlay2: "#7c7f93",
  overlay1: "#8c8fa1",
  overlay0: "#9ca0b0",
  surface2: "#acb0be",
  surface1: "#bcc0cc",
  surface0: "#ccd0da",
  base: "#eff1f5",
  mantle: "#e6e9ef",
  crust: "#dce0e8",
};
const frappe: Catppuccin = {
  rosewater: "#f2d5cf",
  pink: "#f4b8e4",
  mauve: "#ca9ee6",
  red: "#e78284",
  peach: "#ef9f76",
  yellow: "#e5c890",
  green: "#a6d189",
  teal: "#81c8be",
  blue: "#8caaee",
  lavender: "#babbf1",
  text: "#c6d0f5",
  subtext1: "#b5bfe2",
  subtext0: "#a5adce",
  overlay2: "#949cbb",
  overlay1: "#838ba7",
  overlay0: "#737994",
  surface2: "#626880",
  surface1: "#51576d",
  surface0: "#414559",
  base: "#303446",
  mantle: "#292c3c",
  crust: "#232634",
};
const macchiato: Catppuccin = {
  rosewater: "#f4dbd6",
  pink: "#f5bde6",
  mauve: "#c6a0f6",
  red: "#ed8796",
  peach: "#f5a97f",
  yellow: "#eed49f",
  green: "#a6da95",
  teal: "#8bd5ca",
  blue: "#8aadf4",
  lavender: "#b7bdf8",
  text: "#cad3f5",
  subtext1: "#b8c0e0",
  subtext0: "#a5adcb",
  overlay2: "#939ab7",
  overlay1: "#8087a2",
  overlay0: "#6e738d",
  surface2: "#5b6078",
  surface1: "#494d64",
  surface0: "#363a4f",
  base: "#24273a",
  mantle: "#1e2030",
  crust: "#181926",
};
const mocha: Catppuccin = {
  rosewater: "#f5e0dc",
  pink: "#f5c2e7",
  mauve: "#cba6f7",
  red: "#f38ba8",
  peach: "#fab387",
  yellow: "#f9e2af",
  green: "#a6e3a1",
  teal: "#94e2d5",
  blue: "#89b4fa",
  lavender: "#b4befe",
  text: "#cdd6f4",
  subtext1: "#bac2de",
  subtext0: "#a6adc8",
  overlay2: "#9399b2",
  overlay1: "#7f849c",
  overlay0: "#6c7086",
  surface2: "#585b70",
  surface1: "#45475a",
  surface0: "#313244",
  base: "#1e1e2e",
  mantle: "#181825",
  crust: "#11111b",
};

const CATPPUCCIN = "Catppuccin — github.com/catppuccin/palette";

export const catppuccinLatte = defineTheme({
  id: "catppuccin-latte",
  name: "Catppuccin Latte",
  appearance: "light",
  source: CATPPUCCIN,
  syntaxTheme: "catppuccin-latte",
  bg: latte.base,
  bgSidebar: latte.mantle,
  bgElev: mix(latte.base, "#ffffff", 0.6),
  bgSunken: latte.mantle,
  bgColumn: latte.mantle,
  border: latte.surface0,
  borderStrong: latte.surface1,
  text: latte.text,
  text2: latte.subtext0,
  text3: latte.overlay1,
  accent: latte.mauve,
  planning: latte.overlay1,
  in_progress: latte.yellow,
  blocked: latte.red,
  review: latte.pink,
  done: latte.green,
  green: latte.green,
  red: latte.red,
  amber: latte.peach,
  violet: latte.mauve,
});

function catppuccinDark(id: string, name: string, p: Catppuccin) {
  return defineTheme({
    id,
    name,
    appearance: "dark",
    source: CATPPUCCIN,
    syntaxTheme: id,
    bg: p.mantle,
    bgSidebar: p.crust,
    bgElev: p.surface0,
    bgSunken: p.crust,
    bgColumn: p.base,
    border: p.surface1,
    borderStrong: p.surface2,
    text: p.text,
    text2: p.subtext0,
    text3: p.overlay1,
    accent: p.mauve,
    planning: p.overlay1,
    in_progress: p.yellow,
    blocked: p.red,
    review: p.pink,
    done: p.teal,
    green: p.green,
    red: p.red,
    amber: p.peach,
    violet: p.mauve,
  });
}

export const catppuccinFrappe = catppuccinDark("catppuccin-frappe", "Catppuccin Frappé", frappe);
export const catppuccinMacchiato = catppuccinDark("catppuccin-macchiato", "Catppuccin Macchiato", macchiato);
export const catppuccinMocha = catppuccinDark("catppuccin-mocha", "Catppuccin Mocha", mocha);

// ---------------------------------------------------------------------------------------------
// Solarized — ethanschoonover.com/solarized (base03 … base3 + 8 accents). Solarized's body text
// (base00 on base3, base0 on base03) sits just under 4.5:1, so body text uses the emphasized
// tone (base01 / base1) and secondary text is nudged toward it; the page stays the real base.
// ---------------------------------------------------------------------------------------------

const sol = {
  base03: "#002b36",
  base02: "#073642",
  base01: "#586e75",
  base00: "#657b83",
  base0: "#839496",
  base1: "#93a1a1",
  base2: "#eee8d5",
  base3: "#fdf6e3",
  yellow: "#b58900",
  orange: "#cb4b16",
  red: "#dc322f",
  magenta: "#d33682",
  violet: "#6c71c4",
  blue: "#268bd2",
  cyan: "#2aa198",
  green: "#859900",
};
const SOLARIZED = "Solarized — ethanschoonover.com/solarized";

export const solarizedLight = defineTheme({
  id: "solarized-light",
  name: "Solarized Light",
  appearance: "light",
  source: SOLARIZED,
  syntaxTheme: "solarized-light",
  bg: sol.base3,
  bgSidebar: sol.base2,
  bgElev: mix(sol.base3, "#ffffff", 0.5),
  bgSunken: sol.base2,
  bgColumn: mix(sol.base3, sol.base2, 0.55),
  border: mix(sol.base2, sol.base1, 0.3),
  borderStrong: mix(sol.base2, sol.base1, 0.55),
  text: sol.base01,
  ink: sol.base03,
  text2: sol.base00,
  text3: sol.base1,
  accent: sol.blue,
  planning: sol.base01,
  in_progress: sol.yellow,
  blocked: sol.red,
  review: sol.violet,
  done: sol.cyan,
  green: sol.green,
  red: sol.red,
  amber: sol.orange,
  violet: sol.violet,
});

export const solarizedDark = defineTheme({
  id: "solarized-dark",
  name: "Solarized Dark",
  appearance: "dark",
  source: SOLARIZED,
  syntaxTheme: "solarized-dark",
  bg: sol.base03,
  bgSidebar: "#00212b", // the sidebar shade of the official VS Code port
  bgElev: sol.base02,
  bgSunken: "#00212b",
  bgColumn: mix(sol.base03, sol.base02, 0.5),
  border: mix(sol.base02, sol.base01, 0.3),
  borderStrong: mix(sol.base02, sol.base01, 0.55),
  text: sol.base1,
  ink: sol.base3,
  text2: sol.base0,
  text3: sol.base01,
  accent: sol.blue,
  planning: sol.base01,
  in_progress: sol.yellow,
  blocked: sol.red,
  review: sol.violet,
  done: sol.cyan,
  green: sol.green,
  red: sol.red,
  amber: sol.orange,
  violet: sol.violet,
});

// ---------------------------------------------------------------------------------------------
// GitHub — Primer primitives (github.com/primer/primitives, functional color tokens) for the
// light and dark default themes.
// ---------------------------------------------------------------------------------------------

const PRIMER = "GitHub Primer — github.com/primer/primitives";

export const githubLight = defineTheme({
  id: "github-light",
  name: "GitHub Light",
  appearance: "light",
  source: PRIMER,
  syntaxTheme: "github-light-default",
  bg: "#ffffff", // bgColor.default
  bgSidebar: "#f6f8fa", // bgColor.muted
  bgElev: "#ffffff",
  bgSunken: "#f6f8fa",
  bgColumn: "#f6f8fa",
  border: "#d1d9e0", // borderColor.default
  borderStrong: "#afb8c1",
  text: "#1f2328", // fgColor.default
  text2: "#59636e", // fgColor.muted
  text3: "#818b98", // fgColor.disabled-ish (neutral scale)
  accent: "#0969da", // accent.emphasis
  planning: "#818b98",
  in_progress: "#bf8700", // attention.emphasis
  blocked: "#cf222e", // danger.emphasis
  review: "#8250df", // done.emphasis
  done: "#1a7f37", // success.fg
  green: "#1a7f37",
  red: "#d1242f", // danger.fg
  amber: "#9a6700", // attention.fg
  violet: "#8250df",
});

export const githubDark = defineTheme({
  id: "github-dark",
  name: "GitHub Dark",
  appearance: "dark",
  source: PRIMER,
  syntaxTheme: "github-dark-default",
  bg: "#0d1117", // bgColor.default
  bgSidebar: "#010409", // bgColor.inset
  bgElev: "#151b23", // bgColor.muted
  bgSunken: "#010409",
  bgColumn: mix("#0d1117", "#151b23", 0.5),
  border: "#3d444d", // borderColor.default
  borderStrong: "#656c76",
  text: "#f0f6fc", // fgColor.default
  text2: "#9198a1", // fgColor.muted
  text3: "#656c76",
  accent: "#1f6feb", // accent.emphasis
  accentText: "#4493f8", // accent.fg
  planning: "#656c76",
  in_progress: "#d29922", // attention.fg
  blocked: "#f85149", // danger.fg
  review: "#ab7df8", // done.fg
  done: "#3fb950", // success.fg
  green: "#3fb950",
  red: "#f85149",
  amber: "#d29922",
  violet: "#ab7df8",
});

// ---------------------------------------------------------------------------------------------
// Dracula — draculatheme.com/contribute (Background #282a36, Current Line #44475a, Foreground
// #f8f8f2, Comment #6272a4, the six hues). Deeper surfaces (#21222c, #191a21) and #343746 /
// #424450 come from the official VS Code theme (dracula-theme/visual-studio-code).
// ---------------------------------------------------------------------------------------------

export const dracula = defineTheme({
  id: "dracula",
  name: "Dracula",
  appearance: "dark",
  source: "Dracula — draculatheme.com/contribute",
  syntaxTheme: "dracula",
  bg: "#21222c", // BGDark
  bgSidebar: "#191a21", // BGDarker
  bgElev: "#343746", // BGLight
  bgSunken: "#191a21",
  bgColumn: "#282a36", // Background
  border: "#424450", // BGLighter
  borderStrong: "#6272a4", // Comment
  text: "#f8f8f2", // Foreground
  text2: mix("#f8f8f2", "#6272a4", 0.35),
  text3: "#6272a4", // Comment
  accent: "#bd93f9", // Purple
  planning: "#6272a4",
  in_progress: "#f1fa8c", // Yellow
  blocked: "#ff5555", // Red
  review: "#ff79c6", // Pink
  done: "#50fa7b", // Green
  green: "#50fa7b",
  red: "#ff5555",
  amber: "#ffb86c", // Orange
  violet: "#bd93f9",
});

// ---------------------------------------------------------------------------------------------
// Nord — nordtheme.com/docs/colors-and-palettes (Polar Night nord0–3, Snow Storm nord4–6,
// Frost nord7–10, Aurora nord11–15). Accent: nord8, Nord's primary UI accent.
// ---------------------------------------------------------------------------------------------

const nord = {
  n0: "#2e3440",
  n1: "#3b4252",
  n2: "#434c5e",
  n3: "#4c566a",
  n4: "#d8dee9",
  n5: "#e5e9f0",
  n6: "#eceff4",
  n7: "#8fbcbb",
  n8: "#88c0d0",
  n9: "#81a1c1",
  n10: "#5e81ac",
  n11: "#bf616a",
  n12: "#d08770",
  n13: "#ebcb8b",
  n14: "#a3be8c",
  n15: "#b48ead",
};

export const nordTheme = defineTheme({
  id: "nord",
  name: "Nord",
  appearance: "dark",
  source: "Nord — nordtheme.com/docs/colors-and-palettes",
  syntaxTheme: "nord",
  bg: nord.n0,
  bgSidebar: mix(nord.n0, "#000000", 0.12),
  bgElev: nord.n1,
  bgSunken: mix(nord.n0, "#000000", 0.12),
  bgColumn: mix(nord.n0, nord.n1, 0.45),
  border: nord.n2,
  borderStrong: nord.n3,
  text: nord.n6,
  text2: nord.n4,
  text3: mix(nord.n4, nord.n3, 0.45),
  accent: nord.n8,
  planning: nord.n4, // a light neutral dot: nord3 sits too close to the muted Aurora hues
  in_progress: nord.n13,
  blocked: nord.n11,
  review: nord.n9,
  done: nord.n14,
  green: nord.n14,
  red: nord.n11,
  amber: nord.n12,
  violet: nord.n15,
});

// ---------------------------------------------------------------------------------------------
// Gruvbox — github.com/morhetz/gruvbox (README palette). Dark uses the bright hues, light the
// faded ones, as the original does. Accent: blue.
// ---------------------------------------------------------------------------------------------

const GRUVBOX = "Gruvbox — github.com/morhetz/gruvbox";

export const gruvboxLight = defineTheme({
  id: "gruvbox-light",
  name: "Gruvbox Light",
  appearance: "light",
  source: GRUVBOX,
  syntaxTheme: "gruvbox-light-medium",
  bg: "#fbf1c7", // bg0
  bgSidebar: "#f2e5bc", // bg0_s
  bgElev: "#f9f5d7", // bg0_h
  bgSunken: "#f2e5bc",
  bgColumn: mix("#fbf1c7", "#f2e5bc", 0.6),
  border: "#d5c4a1", // bg2
  borderStrong: "#bdae93", // bg3
  text: "#3c3836", // fg1
  ink: "#282828", // fg0
  text2: "#665c54", // fg3
  text3: "#7c6f64", // fg4
  accent: "#076678", // faded blue
  planning: "#7c6f64", // fg4
  in_progress: "#d65d0e", // neutral orange (the faded yellow is too close to the gray and green)
  blocked: "#9d0006", // faded red
  review: "#8f3f71", // faded purple
  done: "#98971a", // neutral green
  green: "#79740e", // faded green
  red: "#9d0006",
  amber: "#b57614", // faded yellow
  violet: "#8f3f71",
});

export const gruvboxDark = defineTheme({
  id: "gruvbox-dark",
  name: "Gruvbox Dark",
  appearance: "dark",
  source: GRUVBOX,
  syntaxTheme: "gruvbox-dark-medium",
  bg: "#282828", // bg0
  bgSidebar: "#1d2021", // bg0_h
  bgElev: "#3c3836", // bg1
  bgSunken: "#1d2021",
  bgColumn: "#32302f", // bg0_s
  border: "#504945", // bg2
  borderStrong: "#665c54", // bg3
  text: "#ebdbb2", // fg1
  ink: "#fbf1c7", // fg0
  text2: "#bdae93", // fg3
  text3: "#a89984", // fg4
  accent: "#83a598", // bright blue
  planning: "#928374", // gray
  in_progress: "#fabd2f", // bright yellow
  blocked: "#fb4934", // bright red
  review: "#d3869b", // bright purple
  done: "#b8bb26", // bright green
  green: "#b8bb26",
  red: "#fb4934",
  amber: "#fe8019", // bright orange
  violet: "#d3869b",
});

// ---------------------------------------------------------------------------------------------
// Tokyo Night — github.com/folke/tokyonight.nvim (colors/night.lua, colors/day.lua); the night
// surfaces match enkia/tokyo-night-vscode-theme.
// ---------------------------------------------------------------------------------------------

const TOKYO = "Tokyo Night — github.com/folke/tokyonight.nvim";

export const tokyoNight = defineTheme({
  id: "tokyo-night",
  name: "Tokyo Night",
  appearance: "dark",
  source: TOKYO,
  syntaxTheme: "tokyo-night",
  bg: "#1a1b26", // bg
  bgSidebar: "#16161e", // bg_dark
  bgElev: "#24283b", // storm bg (bg_float in storm)
  bgSunken: "#16161e",
  bgColumn: mix("#1a1b26", "#24283b", 0.4),
  border: "#292e42", // bg_highlight
  borderStrong: "#3b4261", // fg_gutter
  text: "#c0caf5", // fg
  text2: "#a9b1d6", // fg_dark
  text3: "#737aa2", // dark5
  accent: "#7aa2f7", // blue
  planning: "#565f89", // comment
  in_progress: "#e0af68", // yellow
  blocked: "#f7768e", // red
  review: "#bb9af7", // magenta
  done: "#9ece6a", // green
  green: "#9ece6a",
  red: "#f7768e",
  amber: "#ff9e64", // orange
  violet: "#bb9af7",
});

export const tokyoNightDay = defineTheme({
  id: "tokyo-night-day",
  name: "Tokyo Night Day",
  appearance: "light",
  source: TOKYO,
  syntaxTheme: null, // Shiki has no Tokyo Night Day; plugins fall back to their light default
  bg: "#e1e2e7", // bg
  bgSidebar: "#d0d5e3", // bg_dark
  bgElev: mix("#e1e2e7", "#ffffff", 0.6),
  bgSunken: "#d0d5e3",
  bgColumn: mix("#e1e2e7", "#d0d5e3", 0.5),
  border: "#c4c8da", // bg_highlight
  borderStrong: "#a8aecb", // fg_gutter
  text: "#3760bf", // fg
  text2: "#6172b0", // fg_dark
  text3: "#68709a", // dark5
  accent: "#2e7de9", // blue
  planning: "#848cb5", // comment
  in_progress: "#b15c00", // orange
  blocked: "#f52a65", // red
  review: "#9854f1", // magenta
  done: "#587539", // green
  green: "#587539",
  red: "#f52a65",
  amber: "#8c6c3e", // yellow
  violet: "#9854f1",
});

// ---------------------------------------------------------------------------------------------
// Rosé Pine — rosepinetheme.com/palette (main + dawn). Rosé Pine has no green: done/success use
// foam / pine, as the official ports do for git additions. Accent: pine (links: foam on
// the dark variant); review and the conductor use iris.
// ---------------------------------------------------------------------------------------------

const ROSE_PINE = "Rosé Pine — rosepinetheme.com/palette";

export const rosePine = defineTheme({
  id: "rose-pine",
  name: "Rosé Pine",
  appearance: "dark",
  source: ROSE_PINE,
  syntaxTheme: "rose-pine",
  bg: "#191724", // base
  bgSidebar: mix("#191724", "#000000", 0.15),
  bgElev: "#26233a", // overlay
  bgSunken: mix("#191724", "#000000", 0.15),
  bgColumn: "#1f1d2e", // surface
  border: "#403d52", // highlight med
  borderStrong: "#524f67", // highlight high
  text: "#e0def4", // text
  text2: "#908caa", // subtle
  text3: "#6e6a86", // muted
  accent: "#31748f", // pine
  accentText: "#9ccfd8", // foam
  planning: "#908caa", // subtle
  in_progress: "#f6c177", // gold
  blocked: "#eb6f92", // love
  review: "#c4a7e7", // iris
  done: "#9ccfd8", // foam
  green: "#9ccfd8",
  red: "#eb6f92",
  amber: "#f6c177",
  violet: "#c4a7e7",
});

export const rosePineDawn = defineTheme({
  id: "rose-pine-dawn",
  name: "Rosé Pine Dawn",
  appearance: "light",
  source: ROSE_PINE,
  syntaxTheme: "rose-pine-dawn",
  bg: "#faf4ed", // base
  bgSidebar: "#f2e9e1", // overlay
  bgElev: "#fffaf3", // surface
  bgSunken: "#f2e9e1",
  bgColumn: "#f4ede8", // highlight low
  border: "#dfdad9", // highlight med
  borderStrong: "#cecacd", // highlight high
  text: "#575279", // text
  text2: "#797593", // subtle
  text3: "#9893a5", // muted
  accent: "#286983", // pine
  planning: "#797593", // subtle
  in_progress: "#ea9d34", // gold
  blocked: "#b4637a", // love
  review: "#56949f", // foam (iris sits too close to the grays and love at dot size)
  done: "#286983", // pine
  green: "#286983",
  red: "#b4637a",
  amber: "#ea9d34",
  violet: "#907aa9",
});

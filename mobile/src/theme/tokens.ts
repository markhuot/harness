// Design tokens, mirrored from the desktop's app/src/renderer/styles.css (light :root and
// :root[data-theme="dark"]). tokens.test.ts fails if the two drift apart.

export interface Palette {
  bg: string;
  bgSidebar: string;
  bgElev: string;
  bgSunken: string;
  bgColumn: string;
  bgHover: string;
  bgActive: string;
  border: string;
  borderStrong: string;
  text: string;
  text2: string;
  text3: string;
  accent: string;
  accentHover: string;
  accentSoft: string;
  accentText: string;
  focus: string;
  overlay: string;
  planning: string;
  in_progress: string;
  blocked: string;
  review: string;
  done: string;
  green: string;
  greenSoft: string;
  red: string;
  redSoft: string;
  amber: string;
  amberSoft: string;
  violet: string;
  violetSoft: string;
}

/** Palette key → the CSS custom property it mirrors. */
export const CSS_VAR: Record<keyof Palette, string> = {
  bg: "--bg",
  bgSidebar: "--bg-sidebar",
  bgElev: "--bg-elev",
  bgSunken: "--bg-sunken",
  bgColumn: "--bg-column",
  bgHover: "--bg-hover",
  bgActive: "--bg-active",
  border: "--border",
  borderStrong: "--border-strong",
  text: "--text",
  text2: "--text-2",
  text3: "--text-3",
  accent: "--accent",
  accentHover: "--accent-hover",
  accentSoft: "--accent-soft",
  accentText: "--accent-text",
  focus: "--focus",
  overlay: "--overlay",
  planning: "--c-planning",
  in_progress: "--c-in_progress",
  blocked: "--c-blocked",
  review: "--c-review",
  done: "--c-done",
  green: "--green",
  greenSoft: "--green-soft",
  red: "--red",
  redSoft: "--red-soft",
  amber: "--amber",
  amberSoft: "--amber-soft",
  violet: "--violet",
  violetSoft: "--violet-soft",
};

export const light: Palette = {
  bg: "#fbfbfc",
  bgSidebar: "#f3f3f5",
  bgElev: "#ffffff",
  bgSunken: "#f5f5f7",
  bgColumn: "#f4f4f6",
  bgHover: "rgba(15, 17, 22, 0.045)",
  bgActive: "rgba(15, 17, 22, 0.075)",
  border: "#e4e4e8",
  borderStrong: "#d4d4da",
  text: "#1a1b1f",
  text2: "#55575f",
  text3: "#8a8c94",
  accent: "#5e6ad2",
  accentHover: "#515cc4",
  accentSoft: "rgba(94, 106, 210, 0.12)",
  accentText: "#4b56c0",
  focus: "rgba(94, 106, 210, 0.35)",
  overlay: "rgba(20, 21, 26, 0.28)",
  planning: "#8a8c94",
  in_progress: "#d99a1e",
  blocked: "#e5484d",
  review: "#8e4ec6",
  done: "#30a46c",
  green: "#2f9a63",
  greenSoft: "rgba(48, 164, 108, 0.12)",
  red: "#d93d42",
  redSoft: "rgba(229, 72, 77, 0.1)",
  amber: "#b7791f",
  amberSoft: "rgba(217, 154, 30, 0.13)",
  violet: "#7d45b3",
  violetSoft: "rgba(142, 78, 198, 0.11)",
};

export const dark: Palette = {
  bg: "#111214",
  bgSidebar: "#0c0d0f",
  bgElev: "#1a1b1e",
  bgSunken: "#0e0f11",
  bgColumn: "#151619",
  bgHover: "rgba(255, 255, 255, 0.05)",
  bgActive: "rgba(255, 255, 255, 0.085)",
  border: "#26272c",
  borderStrong: "#34363c",
  text: "#e8e8eb",
  text2: "#a4a6ae",
  text3: "#6f717a",
  accent: "#6e79d6",
  accentHover: "#7f89e0",
  accentSoft: "rgba(110, 121, 214, 0.18)",
  accentText: "#a3abf0",
  focus: "rgba(110, 121, 214, 0.45)",
  overlay: "rgba(0, 0, 0, 0.5)",
  planning: "#7c7e87",
  in_progress: "#f0b43c",
  blocked: "#f2555a",
  review: "#a86fe0",
  done: "#3fba7d",
  green: "#4cc38a",
  greenSoft: "rgba(76, 195, 138, 0.14)",
  red: "#f2555a",
  redSoft: "rgba(242, 85, 90, 0.13)",
  amber: "#f0b43c",
  amberSoft: "rgba(240, 180, 60, 0.13)",
  violet: "#bf93ec",
  violetSoft: "rgba(168, 111, 224, 0.15)",
};

export const RADIUS = { sm: 5, md: 8, lg: 12, xl: 16 } as const;
export const MONO = "Menlo";
/** Claude Code's orange, used on its driver badge icon (as on desktop). */
export const CLAUDE_ORANGE = "#d97757";

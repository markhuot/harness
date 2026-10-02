// The preferences blob (mobile/src/lib/prefs.ts) for HarnessKit's Prefs.swift. Inputs are anything
// storage could hand back: older builds' blobs, hand-damaged JSON, non-objects.
import { DEFAULT_PREFS, normalizePrefs } from "../../../mobile/src/lib/prefs";
import { HIDE_CHILDREN_DEFAULT } from "../../src/state";
import { cases } from "../case";

export const defaults = { DEFAULT_PREFS, HIDE_CHILDREN_DEFAULT };

export const normalizePrefsCases = cases((stored: unknown) => normalizePrefs(stored as never), {
  null: null,
  "empty object": {},
  "a string": "x",
  "a number": 3,
  "true": true,
  "an array (spread as indexes, no version)": ["dark"],
  "v2 keeps hideChildren false": { hideChildren: false, version: 2 },
  "v2 keeps hideChildren true": { hideChildren: true, version: 2 },
  "v2 junk hideChildren falls back to hidden": { hideChildren: "no", version: 2 },
  "v2 null hideChildren falls back to hidden": { hideChildren: null, version: 2 },
  "pre-v2 blob resets hideChildren once, keeps the rest": { hideChildren: false, theme: "dark" },
  "version 1 resets": { hideChildren: false, version: 1 },
  "fractional version under 2 resets": { hideChildren: false, version: 1.5 },
  "a newer version keeps the choice and is written as 2": { hideChildren: false, version: 3 },
  "string version counts as 0": { hideChildren: false, version: "2" },
  "a blob from before themes": { theme: "dark", hideChildren: true },
  "unknown ids, wrong-appearance ids and bad appearance fall back": { theme: "sepia", lightTheme: "catppuccin-mocha", darkTheme: "not-a-theme" },
  "valid picks survive, other prefs pass through": {
    theme: "light",
    lightTheme: "rose-pine-dawn",
    darkTheme: "dracula",
    activeServer: "srv-1",
    boardProject: "p",
    lastProject: "q",
    version: 2,
  },
  "non-string theme fields fall back": { theme: 1, lightTheme: ["github-light"], darkTheme: { id: "dracula" } },
  "null theme fields fall back": { theme: null, lightTheme: null, darkTheme: null },
  "upper-case appearance isn't one": { theme: "Dark" },
  "explicit nulls stay null": { lastProject: null, boardProject: null, activeServer: null, version: 2, hideChildren: false },
  "unknown keys are ignored": { hideChildren: false, version: 2, legacyFlag: true },
  // TS passes these through untyped; Swift keeps only strings (a non-string becomes null).
  "non-string ids pass through in TS": { lastProject: 5, boardProject: { id: "p" }, activeServer: false, version: 2 },
});

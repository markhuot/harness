// Settings → Appearance's theme pickers (mobile/src/lib/themePicker.ts) for HarnessKit's
// ThemePicker.swift. themeOptions outputs keep only the theme id (the themes themselves are pinned
// by the themes fixtures).
import type { Prefs } from "../../../mobile/src/lib/prefs";
import { pickerCaption, themeLinkPrefs, themeOptions, themePrefKey } from "../../../mobile/src/lib/themePicker";
import type { ThemeAppearance } from "../../src/themes";
import { cases } from "../case";

type ThemePrefs = Pick<Prefs, "theme" | "lightTheme" | "darkTheme">;
interface PickerIn {
  appearance: ThemeAppearance;
  prefs: ThemePrefs;
  systemDark: boolean;
}

const prefs: ThemePrefs = { theme: "system", lightTheme: "github-light", darkTheme: "catppuccin-mocha" };

const pickerInputs: Record<string, PickerIn> = {};
for (const theme of ["system", "light", "dark"] as const) {
  for (const appearance of ["light", "dark"] as const) {
    for (const systemDark of [false, true]) {
      pickerInputs[`${appearance} picker, theme ${theme}, system ${systemDark ? "dark" : "light"}`] = { appearance, prefs: { ...prefs, theme }, systemDark };
    }
  }
}
pickerInputs["a stale dark pick shows the default selected"] = { appearance: "dark", prefs: { ...prefs, darkTheme: "one-light" }, systemDark: true };
pickerInputs["an unknown light pick shows the default selected and active"] = { appearance: "light", prefs: { ...prefs, lightTheme: "nope" }, systemDark: false };
pickerInputs["a light theme picked as dark"] = { appearance: "light", prefs: { theme: "dark", lightTheme: "github-light", darkTheme: "github-light" }, systemDark: false };

export const themeOptionsCases = cases(
  ({ appearance, prefs, systemDark }: PickerIn) => themeOptions(appearance, prefs, systemDark).map((o) => ({ id: o.theme.id, appearance: o.theme.appearance, selected: o.selected, active: o.active })),
  pickerInputs,
);

export const pickerCaptionCases = cases(({ appearance, prefs, systemDark }: PickerIn) => pickerCaption(appearance, prefs, systemDark), pickerInputs);

export const themePrefKeyCases = cases(themePrefKey, { light: "light", dark: "dark" } as Record<string, ThemeAppearance>);

export const themeLinkPrefsCases = cases(themeLinkPrefs, {
  "takes valid picks and appearance": { darkTheme: "catppuccin-mocha", lightTheme: "rose-pine-dawn", theme: "dark" },
  "drops unknown ids, wrong-appearance ids and bad appearances": { darkTheme: "one-light", lightTheme: "nope", theme: "sepia" },
  "drops repeated params (arrays)": { darkTheme: ["dracula", "nord"] },
  "nothing": {},
  "empty values are dropped": { darkTheme: "", lightTheme: "", theme: "" },
  "only the appearance": { theme: "system" },
  "upper-case appearance is dropped": { theme: "Light" },
  "unrelated params are ignored": { tab: "appearance", lightTheme: "github-light" },
  "a dark id is not a light pick": { lightTheme: "dracula" },
});

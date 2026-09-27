import { describe, expect, test } from "bun:test";
import { effectiveSource, parseForcedTheme, parseStoredPreference, resolveTheme } from "./theme";

describe("theme", () => {
  test("system follows the OS; explicit choices ignore it", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  test("stored preference falls back to system on missing, corrupt or unknown values", () => {
    expect(parseStoredPreference('{"theme":"dark"}')).toBe("dark");
    expect(parseStoredPreference('{"theme":"light","other":1}')).toBe("light");
    expect(parseStoredPreference(null)).toBe("system");
    expect(parseStoredPreference("")).toBe("system");
    expect(parseStoredPreference("{not json")).toBe("system");
    expect(parseStoredPreference('{"theme":"sepia"}')).toBe("system");
    expect(parseStoredPreference("null")).toBe("system");
  });

  test("HARNESS_THEME overrides the stored preference only when it's light or dark", () => {
    expect(parseForcedTheme("dark")).toBe("dark");
    expect(parseForcedTheme("system")).toBeNull();
    expect(parseForcedTheme(undefined)).toBeNull();
    expect(effectiveSource("light", parseForcedTheme("dark"))).toBe("dark");
    expect(effectiveSource("light", parseForcedTheme("bogus"))).toBe("light");
    expect(resolveTheme(effectiveSource("system", null), true)).toBe("dark");
  });
});

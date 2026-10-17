import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { buildThemes, THEMES_JSON } from "../../../shared/scripts/export-themes";

// HarnessKit loads this file at runtime, so a stale one ships old palettes to every iPhone without
// failing a single Swift test.
test("the bundled themes.json is what shared/src generates", () => {
  expect(readFileSync(THEMES_JSON, "utf8")).toBe(buildThemes());
});

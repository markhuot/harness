import { expect, test } from "bun:test";
import { normalizePrefs } from "./prefs";

test("child tickets: hidden on first run; a stored choice wins either way; junk falls back to hidden", () => {
  expect(normalizePrefs(null).hideChildren).toBe(true);
  expect(normalizePrefs({}).hideChildren).toBe(true);
  expect(normalizePrefs({ hideChildren: false }).hideChildren).toBe(false);
  expect(normalizePrefs({ hideChildren: true }).hideChildren).toBe(true);
  expect(normalizePrefs({ hideChildren: "no" as unknown as boolean }).hideChildren).toBe(true);
});

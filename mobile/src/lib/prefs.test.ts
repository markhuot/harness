import { expect, test } from "bun:test";
import { normalizePrefs } from "./prefs";

test("child tickets: hidden on first run; a v2 stored choice wins either way; junk falls back to hidden", () => {
  expect(normalizePrefs(null).hideChildren).toBe(true);
  expect(normalizePrefs({}).hideChildren).toBe(true);
  expect(normalizePrefs({ hideChildren: false, version: 2 }).hideChildren).toBe(false);
  expect(normalizePrefs({ hideChildren: true, version: 2 }).hideChildren).toBe(true);
  expect(normalizePrefs({ hideChildren: "no" as unknown as boolean, version: 2 }).hideChildren).toBe(true);
});

test("pre-v2 blobs (which saved hideChildren: false as a side effect) reset to hidden once, then stick", () => {
  const migrated = normalizePrefs({ hideChildren: false, theme: "dark" });
  expect(migrated.hideChildren).toBe(true);
  expect(migrated.version).toBe(2);
  expect(migrated.theme).toBe("dark"); // other prefs survive the migration
  // After migrating, the user's own choice is respected.
  expect(normalizePrefs({ ...migrated, hideChildren: false }).hideChildren).toBe(false);
});

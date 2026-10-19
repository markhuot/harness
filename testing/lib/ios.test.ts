import { expect, test } from "bun:test";
import { savedAfter } from "./ios";

// What `simctl spawn <sim> defaults read <bundle>` prints for a string preference holding JSON.
const read = (savedAt: number) => `{
    "harness.restore.abc" = "{\\"version\\":1,\\"savedAt\\":${savedAt},\\"docked\\":false,\\"sheets\\":[]}";
    HarnessSkipNotificationPrompt = 1;
}`;

test("a saved state counts only when its time is from after the Home press", () => {
  expect(savedAfter(read(1_800_000_100.5), 1_800_000_100)).toBe(true);
  expect(savedAfter(read(1_800_000_099), 1_800_000_100)).toBe(false);
});

test("preferences with no saved state (an empty string, no key) never count", () => {
  expect(savedAfter('{ "harness.restore.abc" = ""; }', 0)).toBe(false);
  expect(savedAfter("{ HarnessSkipNotificationPrompt = 1; }", 0)).toBe(false);
});

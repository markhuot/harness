import { expect, test } from "bun:test";
import { savedAfter } from "./ios";

// What `plutil -convert json` prints for the app's preferences: the state is a JSON string inside the JSON.
const read = (savedAt: number) =>
  JSON.stringify({ HarnessSkipNotificationPrompt: true, "harness.restore.abc": JSON.stringify({ version: 1, savedAt, docked: false, sheets: [] }) });

test("a saved state counts only when its time is from after the Home press", () => {
  expect(savedAfter(read(1_800_000_100.5), 1_800_000_100)).toBe(true);
  expect(savedAfter(read(1_800_000_099), 1_800_000_100)).toBe(false);
});

test("preferences with no saved state (an empty string, no key) never count", () => {
  expect(savedAfter('{"harness.restore.abc":""}', 0)).toBe(false);
  expect(savedAfter('{"HarnessSkipNotificationPrompt":true}', 0)).toBe(false);
});

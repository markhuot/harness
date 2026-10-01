import { expect, test } from "bun:test";
import { parseLabels, screenKey, screenState } from "./axe";

test("reads AXLabels as they show on screen, unescaping AXe's \\/", () => {
  const out = `[{ "AXLabel" : "Harness", "children" : [{ "AXLabel" : "path: src\\/app.ts" }, { "AXLabel" : null }, { "AXLabel" : "" }] }]`;
  expect(parseLabels(out)).toEqual(["Harness", "path: src/app.ts", ""]);
});

test("the Open in “Harness”? prompt wins over whatever is behind it", () => {
  expect(screenState(["Harness", "Planning, 1", "Open in “Harness”?", "Cancel", "Open"])).toBe("prompt");
  expect(screenState(["Open in “Harness”?", "Cancel", "Open"])).toBe("prompt");
});

test("the board counts as paired only with a column chip", () => {
  expect(screenState(["Harness", "Planning, 1", "GREET-2 Write a page", "Tab Bar"])).toBe("board");
  expect(screenState(["Harness", "In progress, 0", "Done, 12"])).toBe("board");
  // A chip-like title elsewhere isn't a chip.
  expect(screenState(["Harness", "Planning, soon", "Coming soon"])).toBe("app");
});

test("a failed pair is told apart from the pairing spinner", () => {
  expect(screenState(["Harness", "Pairing", "Couldn't pair, The service rejected the token (401).", "Try again"])).toBe("pairFailed");
  expect(screenState(["Harness", "Pairing", "Connecting to 127.0.0.1:7717…"])).toBe("app");
});

test("SpringBoard and the splash aren't the app", () => {
  expect(screenState([])).toBe("other");
  expect(screenState(["Harness"])).toBe("other");
  expect(screenState(["Fitness", "Watch", "Harness"])).toBe("other");
});

test("live numbers don't make a new screen, but different text does", () => {
  expect(screenKey(["Harness", "started 47s ago"])).toBe(screenKey(["Harness", "started 48s ago"]));
  expect(screenKey(["Harness", "Ticket", "key: GREET-1"])).not.toBe(screenKey(["Harness", "Prompt", "id: run.review"]));
});

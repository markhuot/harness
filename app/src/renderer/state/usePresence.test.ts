import { describe, expect, test } from "bun:test";
import { reportedPresence } from "./usePresence";

describe("reportedPresence", () => {
  test("away reports nothing on screen even when the window is visible", () => {
    expect(reportedPresence(true, true, ["HARNESS-1", "HARNESS-2"])).toEqual({ visible: false, tickets: [] });
  });

  test("back, a visible window reports its tickets again", () => {
    expect(reportedPresence(true, false, ["HARNESS-1"])).toEqual({ visible: true, tickets: ["HARNESS-1"] });
  });

  test("a hidden window stays hidden when the person is back", () => {
    expect(reportedPresence(false, false, ["HARNESS-1"]).visible).toBe(false);
  });
});

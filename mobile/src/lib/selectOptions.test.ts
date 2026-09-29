import { describe, expect, test } from "bun:test";
import { selectedLabel } from "./selectOptions";

describe("selectedLabel", () => {
  const opts = [{ value: "", label: "Default" }, { value: "a", label: "Alpha" }];
  test("the empty value is a real option, not a miss", () => {
    expect(selectedLabel(opts, "", "Choose…")).toBe("Default");
  });
  test("a value that isn't listed falls back", () => {
    expect(selectedLabel(opts, "gone", "gone-driver")).toBe("gone-driver");
  });
});

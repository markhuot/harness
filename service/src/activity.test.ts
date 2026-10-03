import { describe, expect, test } from "bun:test";
import { activityLine } from "./activity";

describe("activityLine", () => {
  test("takes the first non-empty line, without a heading, list or quote marker", () => {
    expect(activityLine("\n\n## Problems\n- one\n- two")).toBe("Problems");
    expect(activityLine("- `a.ts:12`: assert a real decode\n- more")).toBe("`a.ts:12`: assert a real decode");
    expect(activityLine("1. First fix\n2. Second")).toBe("First fix");
    expect(activityLine("> quoted reason")).toBe("quoted reason");
  });

  test("collapses whitespace and keeps a short line as it is", () => {
    expect(activityLine("  Fixed   the\tbackoff  ")).toBe("Fixed the backoff");
  });

  test("never shortens a long line: 400 characters is a recommendation, not a cap", () => {
    const long = `${"word ".repeat(200)}end`;
    expect(activityLine(long)).toBe(long);
  });

  test("blank text is empty", () => {
    expect(activityLine(" \n \n")).toBe("");
  });
});

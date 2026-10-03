import { describe, expect, test } from "bun:test";
import { ACTIVITY_LINE_MAX, activityLine, oneLineError } from "./activity";

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

  test("cuts a long line on a word boundary with an ellipsis, within the cap", () => {
    const long = `${"word ".repeat(200)}end`;
    const line = activityLine(long);
    expect(line.length).toBeLessThanOrEqual(ACTIVITY_LINE_MAX);
    expect(line).toEndWith("word…");
    expect(activityLine("x".repeat(ACTIVITY_LINE_MAX))).toBe("x".repeat(ACTIVITY_LINE_MAX));
    expect(activityLine("x".repeat(ACTIVITY_LINE_MAX + 1))).toBe(`${"x".repeat(ACTIVITY_LINE_MAX - 1)}…`);
  });

  test("blank text is empty", () => {
    expect(activityLine(" \n \n")).toBe("");
  });
});

describe("oneLineError", () => {
  test("a short line passes, surrounding blank lines included", () => {
    expect(oneLineError("The note", "Fixed the backoff because runs hammered the API.")).toBeNull();
    expect(oneLineError("The note", "\nFixed it.\n\n")).toBeNull();
    expect(oneLineError("The note", "x".repeat(ACTIVITY_LINE_MAX))).toBeNull();
  });

  test("two lines or an over-long line is refused, saying what to do", () => {
    expect(oneLineError("The note", "Fixed it.\n\nDetails follow.")).toContain("this one is 2 lines");
    const long = oneLineError("The submit note", "x".repeat(ACTIVITY_LINE_MAX + 1));
    expect(long).toContain(`this one is ${ACTIVITY_LINE_MAX + 1} characters`);
    expect(long).toStartWith("The submit note goes into the ticket's Activity");
    expect(long).toContain("edit_spec");
  });
});

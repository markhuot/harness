import { expect, test } from "bun:test";
import { activityLine } from "../../service/src/activity";

test("takes the first non-empty line and strips heading, list and quote markers", () => {
  expect(activityLine("\n\n## Fixed the retry\nmore detail")).toBe("Fixed the retry");
  expect(activityLine("- item one\n- item two")).toBe("item one");
  expect(activityLine("1. first step")).toBe("first step");
  expect(activityLine("> quoted note")).toBe("quoted note");
  expect(activityLine("- > ## nested markers")).toBe("nested markers");
});

test("collapses whitespace and never shortens a long line", () => {
  const long = "word ".repeat(200).trim();
  expect(activityLine(`  a   b\t c  `)).toBe("a b c");
  expect(activityLine(long)).toBe(long);
});

test("a marker-only first line is skipped for the next real one; empty text gives empty", () => {
  expect(activityLine("## \n- \nreal")).toBe("real");
  expect(activityLine("   \n\n")).toBe("");
  expect(activityLine("")).toBe("");
});

test("handles CRLF line endings", () => {
  expect(activityLine("first\r\nsecond")).toBe("first");
});

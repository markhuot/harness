import { describe, expect, test } from "bun:test";
import { stepAttachment } from "./attachments";

describe("stepAttachment", () => {
  test("moves within the list", () => {
    expect(stepAttachment(1, 1, 4)).toBe(2);
    expect(stepAttachment(2, -1, 4)).toBe(1);
  });

  test("wraps past either end", () => {
    expect(stepAttachment(3, 1, 4)).toBe(0);
    expect(stepAttachment(0, -1, 4)).toBe(3);
  });

  test("stays put with a single attachment, and returns 0 for none", () => {
    expect(stepAttachment(0, 1, 1)).toBe(0);
    expect(stepAttachment(0, -1, 1)).toBe(0);
    expect(stepAttachment(0, 1, 0)).toBe(0);
  });
});

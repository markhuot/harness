import { describe, expect, test } from "bun:test";
import { parseEventRetentionDays } from "../../../shared/src/protocol";

describe("parseEventRetentionDays", () => {
  test("whole days pass, fractions round, and the ends clamp to a day and a year", () => {
    expect(parseEventRetentionDays("30")).toBe(30);
    expect(parseEventRetentionDays(" 7 ")).toBe(7);
    expect(parseEventRetentionDays("2.6")).toBe(3);
    expect(parseEventRetentionDays("0")).toBe(1);
    expect(parseEventRetentionDays("-4")).toBe(1);
    expect(parseEventRetentionDays("9999")).toBe(365);
  });

  test("blank and non-numeric text save nothing", () => {
    for (const text of ["", "   ", "soon", "NaN", "Infinity"]) expect(parseEventRetentionDays(text)).toBeNull();
  });
});

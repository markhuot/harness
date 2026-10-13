import { describe, expect, test } from "bun:test";
import { formatSkips, skipReasons, summarizeSkips } from "./skip";
import { skipLines } from "./parallel";

describe("skipReasons", () => {
  test("reads each distinct reason once, wherever the marker sits in the line", () => {
    const out = "@harness/service test: HARNESS-SKIP: Chrome not found\nnoise\nHARNESS-SKIP: Chrome not found\nHARNESS-SKIP: no LAN address\n";
    expect(skipReasons(out)).toEqual(["Chrome not found", "no LAN address"]);
  });
  test("a bare marker with no reason is ignored", () => {
    expect(skipReasons("HARNESS-SKIP:   \n")).toEqual([]);
  });
});

describe("skipLines", () => {
  test("lists only files that skipped, naming undeclared skips instead of hiding them", () => {
    const lines = skipLines([
      { file: "a.test.ts", skip: 0, reasons: [] },
      { file: "b.test.ts", skip: 2, reasons: ["Chrome not found", "x"] },
      { file: "c.test.ts", skip: 1, reasons: [] },
    ]);
    expect(lines).toEqual([
      "HARNESS-SKIP: Chrome not found; x [2 skipped in b.test.ts]",
      "HARNESS-SKIP: no reason declared [1 skipped in c.test.ts]",
    ]);
  });
});

describe("summarizeSkips / formatSkips", () => {
  test("sums per-package skip counts and carries the reasons through", () => {
    const out = [
      "@harness/service test:  2000 pass",
      "@harness/service test:  3 skip",
      "@harness/app test:  1 skip",
      "@harness/editor test:  0 skip",
      "@harness/service test:   HARNESS-SKIP: Chrome not found [3 skipped in a.test.ts]",
    ].join("\n");
    const s = summarizeSkips(out);
    expect(s.total).toBe(4);
    expect(s.byPackage).toEqual({ "@harness/service": 3, "@harness/app": 1, "@harness/editor": 0 });
    expect(formatSkips(s)).toBe("Skipped: 4 tests (service 3, app 1).\n  - Chrome not found [3 skipped in a.test.ts]");
  });
  test("nothing skipped says so; skips with no declared reason are flagged", () => {
    expect(formatSkips(summarizeSkips("@harness/app test:  5 pass"))).toBe("Skipped: 0 tests.");
    expect(formatSkips(summarizeSkips("@harness/app test:  1 skip"))).toContain("no reason declared");
  });
});

import { describe, expect, test } from "bun:test";
import { orderFiles, parseCounts, pool, splitArgs } from "./parallel";

describe("orderFiles", () => {
  test("unrecorded files first, then slowest first, ties by name", () => {
    const times = { "a.test.ts": 100, "b.test.ts": 9000, "c.test.ts": 100 };
    expect(orderFiles(["a.test.ts", "c.test.ts", "new.test.ts", "b.test.ts"], times)).toEqual(["new.test.ts", "b.test.ts", "a.test.ts", "c.test.ts"]);
  });
});

describe("parseCounts", () => {
  test("reads bun test's summary lines, not counts inside other output", () => {
    const out = "error: expected 3 pass\n 12 pass\n 1 skip\n 2 fail\n 40 expect() calls\nRan 15 tests across 1 file. [1.00s]\n";
    expect(parseCounts(out)).toEqual({ pass: 12, fail: 2, skip: 1 });
  });

  test("a run that printed no summary (a crash before any test) counts nothing", () => {
    expect(parseCounts("SyntaxError: Unexpected token\n")).toEqual({ pass: 0, fail: 0, skip: 0 });
  });
});

describe("splitArgs", () => {
  test("a value-taking flag keeps its value; other bare words are filters", () => {
    expect(splitArgs(["--timeout", "30000", "--update-snapshots", "src/api", "-t", "rebinds"])).toEqual({
      flags: ["--timeout", "30000", "--update-snapshots", "-t", "rebinds"],
      filters: ["src/api"],
    });
  });

  test("--flag=value is one argument", () => {
    expect(splitArgs(["--timeout=5000"])).toEqual({ flags: ["--timeout=5000"], filters: [] });
  });
});

describe("pool", () => {
  test("never runs more than jobs at once, starts in order, and keeps results in input order", async () => {
    let running = 0;
    let peak = 0;
    const started: number[] = [];
    const results = await pool([30, 5, 20, 1, 10], 2, async (ms) => {
      started.push(ms);
      peak = Math.max(peak, ++running);
      await Bun.sleep(ms);
      running--;
      return ms * 2;
    });
    expect(peak).toBe(2);
    expect(started).toEqual([30, 5, 20, 1, 10]);
    expect(results).toEqual([60, 10, 40, 2, 20]);
  });

  test("an empty list resolves without running anything", async () => {
    expect(await pool([], 4, async () => 1)).toEqual([]);
  });
});

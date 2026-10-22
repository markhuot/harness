import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./builders/tmp";
import { currentBuild, failureLines, parseArgs, testCount } from "./ios";

describe("the build stamp", () => {
  const stamp = (dir: string, hash: string, xctestrun: string) => {
    const path = join(dir, "stamp.json");
    writeFileSync(path, JSON.stringify({ hash, xctestrun }));
    return path;
  };

  test("a matching hash with its products still on disk is reused", () => {
    const dir = tempDir();
    const run = join(dir, "x.xctestrun");
    writeFileSync(run, "");
    expect(currentBuild("abc", stamp(dir, "abc", run))).toBe(run);
  });

  test("a changed source hash means rebuild", () => {
    const dir = tempDir();
    const run = join(dir, "x.xctestrun");
    writeFileSync(run, "");
    expect(currentBuild("def", stamp(dir, "abc", run))).toBeNull();
  });

  test("products that were cleaned away mean rebuild, even when the hash matches", () => {
    const dir = tempDir();
    expect(currentBuild("abc", stamp(dir, "abc", join(dir, "gone.xctestrun")))).toBeNull();
  });

  test("no stamp, or a damaged one, means rebuild", () => {
    const dir = tempDir();
    expect(currentBuild("abc", join(dir, "missing.json"))).toBeNull();
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{");
    expect(currentBuild("abc", bad)).toBeNull();
  });
});

describe("testing ios arguments", () => {
  test("no device flag runs both devices; flags pick one", () => {
    expect(parseArgs([]).devices).toEqual(["iphone", "ipad", "duo"]);
    expect(parseArgs(["--ipad"]).devices).toEqual(["ipad"]);
    expect(parseArgs(["--duo"]).devices).toEqual(["duo"]);
    expect(parseArgs(["--ipad", "--iphone", "--ipad"]).devices).toEqual(["ipad", "iphone"]);
  });

  test("references are written only with --record", () => {
    expect(parseArgs([]).record).toBe(false);
    expect(parseArgs(["--record"]).record).toBe(true);
  });

  test("--only takes a class or a class/test and nothing a shell could read as more", () => {
    expect(parseArgs(["--only=ScreenTests/testBoard"]).only).toBe("ScreenTests/testBoard");
    expect(() => parseArgs(["--only=ScreenTests/testBoard; rm -rf /"])).toThrow("--only takes");
    expect(() => parseArgs(["--only=a/b/c"])).toThrow("--only takes");
  });

  test("an unknown option fails instead of being ignored", () => {
    expect(() => parseArgs(["--recrod"])).toThrow("unknown option --recrod");
  });
});

describe("failure output", () => {
  test("keeps the lines that say what differs and where the images are", () => {
    const output = ["Test Suite 'All tests' started", "x.swift:1: error: board: 12 of 100 pixels differ", "  actual:    /tmp/board.actual.png", "noise", "  diff:      /tmp/board.diff.png"].join("\n");
    expect(failureLines(output)).toEqual(["x.swift:1: error: board: 12 of 100 pixels differ", "  actual:    /tmp/board.actual.png", "  diff:      /tmp/board.diff.png"]);
  });
});

describe("the test count", () => {
  test("is the run's total, the last Executed line, not the first suite's", () => {
    const out = ["\t Executed 6 tests, with 0 failures (0 unexpected) in 26.1 (26.1) seconds", "\t Executed 34 tests, with 0 failures (0 unexpected) in 132.9 (132.9) seconds"].join("\n");
    expect(testCount(out)).toBe("34");
  });

  test("names the skips, and is unknown when xcodebuild printed no total", () => {
    expect(testCount("\t Executed 34 tests, with 4 tests skipped and 0 failures (0 unexpected) in 1 (1) seconds")).toBe("34 (4 skipped)");
    expect(testCount("\t Executed 1 test, with 1 test skipped and 0 failures (0 unexpected) in 1 (1) seconds")).toBe("1 (1 skipped)");
    expect(testCount("** TEST FAILED **")).toBe("?");
  });
});

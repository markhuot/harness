import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dispositionOf } from "./report-dispositions";
import { extractAppChecks, extractBunTests, extractSimChecks, extractSnapshotTests, extractSwiftTests } from "./report-extract";
import { REPORT_PATH, areaOf, buildReport, collectRows, listFiles, rowsForFile } from "./report";

const root = join(import.meta.dir, "..");

describe("extractors", () => {
  test("bun tests carry their describe path, and a name on the next line is found", () => {
    const rows = extractBunTests("a.test.ts", [
      'describe("outer", () => {',
      '  describe("inner", () => {',
      '    test("one", () => {});',
      "  });",
      '  test("two", () => {});',
      "  it(",
      '    "three",',
      "  );",
      "});",
      'test("top", () => {});',
    ].join("\n"));
    expect(rows.map((r) => [r.group, r.name])).toEqual([
      ["outer › inner", "one"],
      ["outer", "two"],
      ["outer", "three"],
      ["", "top"],
    ]);
  });

  test("test.each keeps the name after its table; template names stay as templates", () => {
    const rows = extractBunTests("a.test.ts", ['test.each([1, 2])("case %i", (n) => {});', "test(`${kind}: gets tools`, () => {});"].join("\n"));
    expect(rows.map((r) => r.name)).toEqual(["case %i", "${kind}: gets tools"]);
  });

  test("a describe is not a test", () => {
    expect(extractBunTests("a.test.ts", 'describe("only", () => {});')).toEqual([]);
  });

  test("swift tests take the display name, else the func, even when the argument table spans lines", () => {
    const rows = extractSwiftTests("T.swift", [
      "@Suite struct DeepLinkTests {",
      '    @Test("shows the board") func board() {}',
      "    @Test(arguments: [",
      '        ("a", 1),',
      "    ])",
      "    func parses(_ x: String, _ y: Int) {}",
      "    @Test func plain() {}",
      "}",
    ].join("\n"));
    expect(rows.map((r) => [r.group, r.name])).toEqual([
      ["DeepLinkTests", "shows the board"],
      ["DeepLinkTests", "parses"],
      ["DeepLinkTests", "plain"],
    ]);
  });

  test("snapshot tests are the XCTest funcs, per class", () => {
    const rows = extractSnapshotTests("S.swift", ["final class ScreenSnapshotTests: XCTestCase {", "    func testBoard() {}", "    func helper() {}", "}"].join("\n"));
    expect(rows.map((r) => [r.group, r.name])).toEqual([["ScreenSnapshotTests", "testBoard"]]);
  });

  test("sim-check names resolve through constants and keep the enclosing function; the declaration itself isn't a check", () => {
    const rows = extractSimChecks("sim-check.ts", [
      'const OPEN = "a ticket link opens";',
      "async function check(name: string) {}",
      "async function sheetChecks() {",
      '  await check("sheet one", async () => true);',
      "  await check(OPEN, async () => true);",
      "  await check(`${tab} opens`, async () => true);",
      "}",
    ].join("\n"));
    expect(rows.map((r) => [r.group, r.name])).toEqual([
      ["sheetChecks", "sheet one"],
      ["sheetChecks", "a ticket link opens"],
      ["sheetChecks", "${tab} opens"],
    ]);
  });

  test("Mac checks find a name on the line after `check(`", () => {
    const rows = extractAppChecks("x-check.ts", ['check("one", ok);', "check(", '  "two",', "  ok);"].join("\n"));
    expect(rows.map((r) => r.name)).toEqual(["one", "two"]);
  });
});

describe("dispositions", () => {
  const sim = (group: string, name = "n") => ({ kind: "sim-check" as const, file: "ios/Tools/sim-check.ts", group, name });

  test("the named losses are losses, everything undecided is open", () => {
    expect(dispositionOf(sim("sheetChecks")).status).toBe("loss");
    expect(dispositionOf(sim("keyboardChecksWithSoftwareKeyboard")).status).toBe("loss");
    expect(dispositionOf(sim("stickChecks")).status).toBe("loss");
    expect(dispositionOf(sim("interactionChains", "state survives a relaunch")).status).toBe("loss");
    expect(dispositionOf(sim("interactionChains", "the palette opens")).status).toBe("open");
    expect(dispositionOf({ kind: "bun", file: "service/src/x.test.ts", group: "", name: "x" }).status).toBe("open");
  });

  test("HarnessKit's swift tests are kept", () => {
    expect(dispositionOf({ kind: "swift", file: "ios/HarnessKit/Tests/X.swift", group: "", name: "x" }).status).toBe("kept");
  });
});

describe("report", () => {
  test("rows come only from the old suite: the new suite and non-test files add none", () => {
    expect(rowsForFile("next/orchestrator/run-path.test.ts", 'test("x", () => {});')).toEqual([]);
    expect(rowsForFile("service/src/a.ts", 'test("x", () => {});')).toEqual([]);
    expect(rowsForFile("service/src/a.test.ts", 'test("x", () => {});')).toHaveLength(1);
  });

  test("a Mac script with no checks still gets a row, so it can't go unaccounted for", () => {
    expect(rowsForFile("app/scripts/shoot.ts", "const shots = [];")).toHaveLength(1);
    expect(rowsForFile("app/scripts/lib/drive.ts", "const shots = [];")).toEqual([]);
  });

  test("areas split service and shared by package directory", () => {
    expect(areaOf({ kind: "bun", file: "service/src/orchestrator/a.test.ts", group: "", name: "" })).toBe("service/src/orchestrator");
    expect(areaOf({ kind: "sim-check", file: "ios/Tools/sim-check.ts", group: "", name: "" })).toBe("ios sim-check");
  });

  test("an area is deletable only when it has no open rows", () => {
    const md = buildReport([
      { kind: "swift", file: "ios/HarnessKit/Tests/A.swift", group: "", name: "a" },
      { kind: "bun", file: "service/src/x/a.test.ts", group: "", name: "a" },
    ]);
    expect(md).toContain("| ios/HarnessKit (swift) | 1 | 0 | 0 | 0 | 0 | 1 | yes |");
    expect(md).toContain("| service/src/x | 1 | 1 | 0 | 0 | 0 | 0 |  |");
  });

  test("every old test file in the repo is accounted for in the report", () => {
    const files = listFiles().filter((f) => !f.startsWith("next/") && /\.test\.tsx?$/.test(f) && existsSync(join(root, f)));
    const md = readFileSync(join(root, REPORT_PATH), "utf8");
    const missing = files.filter((f) => extractBunTests(f, readFileSync(join(root, f), "utf8")).length > 0 && !md.includes(`#### ${f}:`));
    expect(missing).toEqual([]);
  });

  test("the committed report is current: regenerate it with `bun scripts/report.ts` after adding or moving a test", () => {
    expect(readFileSync(join(root, REPORT_PATH), "utf8") === buildReport(collectRows())).toBe(true);
  });
});

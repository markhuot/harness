import { expect, test } from "bun:test";
import { parseArgs, UsageError } from "./dev-sim";

test("takes --flag value and --flag=value, and keeps repeated links in order", () => {
  const o = parseArgs(["--link=harness://board", "--link", "harness://ticket/GREET-1?tab=details", "--shot", "details"]);
  expect(o.links).toEqual(["harness://board", "harness://ticket/GREET-1?tab=details"]);
  expect(o.shot).toBe("details");
  expect(o.build).toBe(true);
});

test("--app installs that app without building", () => {
  const o = parseArgs(["--app", "/tmp/Harness.app"]);
  expect(o.build).toBe(false);
  expect(o.app).toBe("/tmp/Harness.app");
});

test("uses the shared simulator unless told otherwise, and never sim-check's", () => {
  expect(parseArgs([]).sim).toBe("harness-shared");
  expect(parseArgs(["--sim", "other"]).sim).toBe("other");
  expect(parseArgs(["--sim=other"]).sim).toBe("other");
  expect(() => parseArgs(["--sim", "sim-check 1"])).toThrow(UsageError);
  expect(() => parseArgs(["--sim", "sim-check 1"])).toThrow(/belongs to sim-check/);
});

test("--seed-only needs no simulator and refuses the simulator flags", () => {
  expect(parseArgs(["--seed-only", "--keep"])).toMatchObject({ seedOnly: true, keep: true });
  expect(() => parseArgs(["--seed-only", "--sim", "x"])).toThrow(/only --keep/);
  expect(() => parseArgs(["--seed-only", "--sim", "harness-shared"])).toThrow(/only --keep/);
  expect(() => parseArgs(["--seed-only", "--no-build"])).toThrow(/only --keep/);
});

test("refuses bad values", () => {
  expect(() => parseArgs(["--sim"])).toThrow(/needs a value/);
  expect(() => parseArgs(["--sim", "--keep"])).toThrow(/needs a value/);
  expect(() => parseArgs(["--link", "https://example.com"])).toThrow(/harness:\/\//);
  expect(() => parseArgs(["--shot", "../escape"])).toThrow(/plain file name/);
  expect(() => parseArgs(["--keep=yes"])).toThrow(/doesn't take a value/);
  expect(() => parseArgs(["--bogus"])).toThrow(/unknown option/);
  expect(() => parseArgs(["stray"])).toThrow(/unexpected argument/);
});

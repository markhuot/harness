import { expect, test } from "bun:test";
import { dfAvailableGiB, parseArgs, UsageError } from "./dev-sim";

test("takes --flag value and --flag=value, and keeps repeated links in order", () => {
  const o = parseArgs(["--sim", "harness-HARNESS-140", "--link=harness://board", "--link", "harness://ticket/GREET-1?tab=details", "--shot", "details"]);
  expect(o.sim).toBe("harness-HARNESS-140");
  expect(o.links).toEqual(["harness://board", "harness://ticket/GREET-1?tab=details"]);
  expect(o.shot).toBe("details");
  expect(o.build).toBe(true);
});

test("--app installs that app without building", () => {
  const o = parseArgs(["--sim", "harness-X", "--app", "/tmp/Harness.app"]);
  expect(o.build).toBe(false);
  expect(o.app).toBe("/tmp/Harness.app");
});

test("needs a simulator of the ticket's own, never sim-check's", () => {
  expect(() => parseArgs([])).toThrow(UsageError);
  expect(() => parseArgs(["--sim", "sim-check 1"])).toThrow(/belongs to sim-check/);
});

test("--seed-only needs no simulator and refuses the simulator flags", () => {
  expect(parseArgs(["--seed-only", "--keep"])).toMatchObject({ seedOnly: true, keep: true });
  expect(() => parseArgs(["--seed-only", "--sim", "harness-X"])).toThrow(/only --keep/);
  expect(() => parseArgs(["--seed-only", "--no-build"])).toThrow(/only --keep/);
});

test("refuses bad values", () => {
  expect(() => parseArgs(["--sim"])).toThrow(/needs a value/);
  expect(() => parseArgs(["--sim", "--keep"])).toThrow(/needs a value/);
  expect(() => parseArgs(["--sim", "x", "--link", "https://example.com"])).toThrow(/harness:\/\//);
  expect(() => parseArgs(["--sim", "x", "--shot", "../escape"])).toThrow(/plain file name/);
  expect(() => parseArgs(["--sim", "x", "--keep=yes"])).toThrow(/doesn't take a value/);
  expect(() => parseArgs(["--sim", "x", "--bogus"])).toThrow(/unknown option/);
  expect(() => parseArgs(["--sim", "x", "stray"])).toThrow(/unexpected argument/);
});

test("reads the Available column of df -k", () => {
  const df = [
    "Filesystem    1024-blocks      Used Available Capacity iused      ifree %iused  Mounted on",
    "/dev/disk3s5    482797652 423592404  14680064    97% 9600000 147000000    6%   /System/Volumes/Data",
  ].join("\n");
  expect(dfAvailableGiB(df)).toBe(14);
  expect(dfAvailableGiB("df: /nope: No such file or directory")).toBeNull();
});

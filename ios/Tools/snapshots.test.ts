import { expect, test } from "bun:test";
import { failureLines, parseSnapshotArgs, testCommand } from "./snapshots";

test("with no device flag both simulators run, and flags are collected", () => {
  expect(parseSnapshotArgs([])).toEqual({ devices: ["iphone", "ipad"], record: false, out: undefined, only: undefined });
  const o = parseSnapshotArgs(["--ipad", "--ipad", "--record", "--out=shots", "--only=ScreenSnapshotTests/testBoard"]);
  expect(o.devices).toEqual(["ipad"]);
  expect(o.record).toBe(true);
  expect(o.out?.endsWith("/shots")).toBe(true);
  expect(o.only).toBe("ScreenSnapshotTests/testBoard");
});

test("unknown options and a --only that could smuggle an xcodebuild flag are refused", () => {
  expect(() => parseSnapshotArgs(["--shot=x"])).toThrow(/unknown option/);
  expect(() => parseSnapshotArgs(["--only=A/b -resultBundlePath=/x"])).toThrow(/--only takes/);
});

test("the test command targets the device and hands the modes to the test process with the TEST_RUNNER_ prefix", () => {
  const plain = testCommand(parseSnapshotArgs([]), "/x.xctestrun", "UDID-1", "iphone");
  expect(plain.cmd).toEqual(["xcodebuild", "test-without-building", "-xctestrun", "/x.xctestrun", "-destination", "id=UDID-1"]);
  expect(plain.env).toEqual({});
  const o = parseSnapshotArgs(["--record", "--out=/tmp/o", "--only=ScreenSnapshotTests"]);
  const ipad = testCommand(o, "/x.xctestrun", "UDID-2", "ipad");
  expect(ipad.cmd.at(-1)).toBe("-only-testing:HarnessSnapshotTests/ScreenSnapshotTests");
  // Each device writes into its own folder, so an iPhone and an iPad run don't overwrite each other.
  expect(ipad.env).toEqual({ TEST_RUNNER_SNAPSHOT_RECORD: "1", TEST_RUNNER_SNAPSHOT_OUT: "/tmp/o/ipad" });
});

test("failureLines keeps the assertion messages and drops the noise", () => {
  const output = [
    "Unable to update Font Descriptor's weight",
    "/a/ScreenSnapshotTests.swift:51: error: -[T testBoard] : failed - board-light: 5 of 100 pixels differ (5.00%).",
    "  diff:      /a/board-light.diff.png",
    "Test Case passed",
  ].join("\n");
  expect(failureLines(output)).toEqual(output.split("\n").slice(1, 3));
});

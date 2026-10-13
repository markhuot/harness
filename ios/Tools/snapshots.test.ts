import { expect, test } from "bun:test";
import { tempDir } from "@harness/shared/testing";
import { acquireSnapshotDevice, failureLines, parseSnapshotArgs, testCommand } from "./snapshots";
import { lockHolder, tryLock, type Simctl } from "./sim";

const RT = "com.apple.CoreSimulator.SimRuntime.iOS-27-0";
const dev = (name: string, udid: string) => ({ udid, name, state: "Booted", isAvailable: true });
const simctlWith = (devices: ReturnType<typeof dev>[]): Simctl => async (...args) => {
  if (args[0] === "list" && args[1] === "runtimes") return JSON.stringify({ runtimes: [{ identifier: RT, version: "27.0", isAvailable: true }] });
  if (args[0] === "list") return JSON.stringify({ devices: { [RT]: devices } });
  return "";
};
const pool = (dir: string, devices: ReturnType<typeof dev>[]) => ({ dir, pollMs: 10, timeoutMs: 500, devices: async () => devices, freeGiB: () => 100 });

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

test("no two reference images in a device folder are identical (a screen that rendered the wrong thing)", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const { createHash } = await import("node:crypto");
  const root = new URL("../HarnessSnapshotTests/References/", import.meta.url).pathname;
  for (const device of readdirSync(root)) {
    const seen = new Map<string, string>();
    for (const file of readdirSync(`${root}${device}`).filter((f) => f.endsWith(".png"))) {
      const hash = createHash("md5").update(readFileSync(`${root}${device}/${file}`)).digest("hex");
      expect(seen.get(hash) ? `${device}/${file} duplicates ${device}/${seen.get(hash)}` : "").toBe("");
      seen.set(hash, file);
    }
  }
});

test("an iPhone snapshot run takes the free pool slot while slot 1 is held, instead of queueing on it", async () => {
  const dir = tempDir();
  const devices = [dev("harness-shared", "U1"), dev("harness-shared-2", "U2")];
  expect(tryLock("harness-shared", dir)).toBe(true);
  const got = await acquireSnapshotDevice("iphone", pool(dir, devices), { simctl: simctlWith(devices), lockDir: dir, freeGiB: () => 100, log: () => {} });
  expect([got.name, got.udid]).toEqual(["harness-shared-2", "U2"]);
  expect(lockHolder("harness-shared-2", dir)).not.toBeNull();
  got.release();
  expect(lockHolder("harness-shared-2", dir)).toBeNull();
});

test("under sim with-lock the snapshot run uses the slot its parent holds and locks nothing more", async () => {
  const dir = tempDir();
  const devices = [dev("harness-shared", "U1"), dev("harness-shared-2", "U2")];
  const before = process.env.HARNESS_SIM_LOCKED;
  process.env.HARNESS_SIM_LOCKED = "harness-shared-2";
  try {
    const got = await acquireSnapshotDevice("iphone", pool(dir, devices), { simctl: simctlWith(devices), lockDir: dir, freeGiB: () => 100, log: () => {} });
    expect([got.name, got.udid]).toEqual(["harness-shared-2", "U2"]);
    expect(lockHolder("harness-shared", dir)).toBeNull();
    expect(lockHolder("harness-shared-2", dir)).toBeNull(); // the parent's lock, not this process's
    got.release();
  } finally {
    if (before === undefined) delete process.env.HARNESS_SIM_LOCKED;
    else process.env.HARNESS_SIM_LOCKED = before;
  }
});

test("the iPad snapshot run locks the single shared iPad", async () => {
  const dir = tempDir();
  const devices = [dev("harness-shared-ipad", "UI")];
  const got = await acquireSnapshotDevice("ipad", pool(dir, devices), { simctl: simctlWith(devices), lockDir: dir, freeGiB: () => 100, log: () => {} });
  expect([got.name, got.udid]).toEqual(["harness-shared-ipad", "UI"]);
  expect(lockHolder("harness-shared-ipad", dir)).not.toBeNull();
  got.release();
  expect(lockHolder("harness-shared-ipad", dir)).toBeNull();
});

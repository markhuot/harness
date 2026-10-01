import { expect, test } from "bun:test";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@harness/shared/testing";
import { acquire, checkDisk, deviceTypeFor, ensureDevice, lockHolder, pinnedRuntime, processStart, releaseLock, tryLock, withLock, type Runtime, type Simctl } from "./sim";

const iphone = { identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro", name: "iPhone 18 Pro" };
const ipad = { identifier: "com.apple.CoreSimulator.SimDeviceType.iPad-Pro-11-inch-M5-12GB", name: "iPad Pro 11-inch (M5)" };
const runtime = (version: string, extra: Partial<Runtime> = {}): Runtime => ({
  identifier: `com.apple.CoreSimulator.SimRuntime.iOS-${version.replace(/\./g, "-")}`,
  version,
  platform: "iOS",
  isAvailable: true,
  supportedDeviceTypes: [iphone, ipad],
  ...extra,
});

// ---------------------------------------------------------------- runtime pinning

test("pinnedRuntime picks iOS 27.0 even when a newer and an older runtime are installed", () => {
  expect(pinnedRuntime([runtime("27.1"), runtime("27.0"), runtime("18.6")]).version).toBe("27.0");
  expect(pinnedRuntime([runtime("27.0.1"), runtime("27.1")]).version).toBe("27.0.1");
});

test("pinnedRuntime refuses when only other runtimes exist, and names them", () => {
  expect(() => pinnedRuntime([runtime("27.1"), runtime("18.6"), runtime("27.10")])).toThrow(/iOS 27\.0 simulator runtime isn't installed \(installed iOS runtimes: 27\.1, 18\.6, 27\.10\)/);
  expect(() => pinnedRuntime([])).toThrow(/installed iOS runtimes: none/);
});

test("pinnedRuntime ignores an unavailable 27.0 and other platforms' 27.0", () => {
  expect(() => pinnedRuntime([runtime("27.0", { isAvailable: false }), runtime("27.1")])).toThrow(/27\.0 \(unavailable\)/);
  expect(() => pinnedRuntime([runtime("27.0", { platform: "watchOS", identifier: "com.apple.CoreSimulator.SimRuntime.watchOS-27-0" })])).toThrow(/none/);
});

test("deviceTypeFor prefers the iPhone 18 Pro and an iPad Pro 11-inch, else any of the kind", () => {
  expect(deviceTypeFor(runtime("27.0"), "iphone")).toEqual(iphone);
  expect(deviceTypeFor(runtime("27.0"), "ipad")).toEqual(ipad);
  const other = runtime("27.0", { supportedDeviceTypes: [{ identifier: "x.iPad-mini", name: "iPad mini (A17 Pro)" }, { identifier: "x.iPhone-17", name: "iPhone 17" }] });
  expect(deviceTypeFor(other, "iphone").name).toBe("iPhone 17");
  expect(deviceTypeFor(other, "ipad").name).toBe("iPad mini (A17 Pro)");
  expect(() => deviceTypeFor(runtime("27.0", { supportedDeviceTypes: [iphone] }), "ipad")).toThrow(/no iPad/);
});

test("checkDisk stops below the minimum", () => {
  expect(() => checkDisk(5, 4.9)).toThrow(/only 4\.9 GiB/);
  expect(() => checkDisk(5, 5)).not.toThrow();
});

// ---------------------------------------------------------------- locks

/** A PID that belonged to a process which has since exited. */
function deadPid(): number {
  const p = Bun.spawnSync(["true"]);
  expect(processStart(p.pid)).toBeNull();
  return p.pid;
}

/** A separate process that takes the lock, prints "locked", holds it for `ms`, then exits (letting go via its exit hook). */
async function holdInChild(dir: string, name: string, ms: number) {
  const script = `import { tryLock } from ${JSON.stringify(join(import.meta.dir, "sim.ts"))};
if (!tryLock(${JSON.stringify(name)}, ${JSON.stringify(dir)})) { console.log("busy"); process.exit(2); }
console.log("locked"); await Bun.sleep(${ms});`;
  const child = Bun.spawn(["bun", "-e", script], { stdout: "pipe" });
  const reader = child.stdout.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  expect(first.trim()).toBe("locked");
  return child;
}

test("a held lock can't be taken a second time, and is free again once released", () => {
  const dir = tempDir();
  expect(tryLock("dev", dir)).toBe(true);
  expect(tryLock("dev", dir)).toBe(false);
  expect(lockHolder("dev", dir)?.pid).toBe(process.pid);
  releaseLock("dev", dir);
  expect(lockHolder("dev", dir)).toBeNull();
  expect(tryLock("dev", dir)).toBe(true);
  releaseLock("dev", dir);
});

test("acquire waits while another process holds the lock, then gets it when that process exits", async () => {
  const dir = tempDir();
  const child = await holdInChild(dir, "dev", 600);
  expect(tryLock("dev", dir)).toBe(false);
  expect(lockHolder("dev", dir)?.pid).toBe(child.pid);
  let waitedFor: number | undefined;
  const t0 = Date.now();
  const release = await acquire("dev", { dir, pollMs: 25, timeoutMs: 10_000, onWait: (h) => (waitedFor = h?.pid) });
  expect(waitedFor).toBe(child.pid);
  expect(Date.now() - t0).toBeGreaterThan(300);
  expect(lockHolder("dev", dir)?.pid).toBe(process.pid);
  release();
  await child.exited;
});

test("acquire times out while the holder is alive", async () => {
  const dir = tempDir();
  const child = await holdInChild(dir, "dev", 5000);
  await expect(acquire("dev", { dir, pollMs: 25, timeoutMs: 200 })).rejects.toThrow(new RegExp(`timed out .*held by pid ${child.pid}`));
  child.kill();
  await child.exited;
});

test("a lock left by a process that died is taken over", async () => {
  const dir = tempDir();
  const child = await holdInChild(dir, "dev", 60_000);
  child.kill("SIGKILL"); // no exit hook runs, so the lock file stays
  await child.exited;
  expect(readdirSync(dir)).toContain("dev.lock");
  expect(lockHolder("dev", dir)).toBeNull();
  expect(tryLock("dev", dir)).toBe(true);
  releaseLock("dev", dir);
});

test("a dead PID, or a live PID with another start time (reused), counts as gone", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "a.lock"), JSON.stringify({ pid: deadPid(), start: "Thu Oct  1 08:00:00 2026", command: "gone", at: "" }));
  writeFileSync(join(dir, "b.lock"), JSON.stringify({ pid: process.pid, start: "Mon Jan  1 00:00:00 2001", command: "reused", at: "" }));
  writeFileSync(join(dir, "c.lock"), "not json");
  for (const name of ["a", "b", "c"]) {
    expect(tryLock(name, dir)).toBe(true);
    releaseLock(name, dir);
  }
});

test("releasing doesn't remove a lock someone else holds", async () => {
  const dir = tempDir();
  const child = await holdInChild(dir, "dev", 5000);
  releaseLock("dev", dir);
  expect(lockHolder("dev", dir)?.pid).toBe(child.pid);
  child.kill();
  await child.exited;
});

test("inside with-lock (HARNESS_SIM_LOCKED) the same lock doesn't wait on its parent, other locks still do", async () => {
  const dir = tempDir();
  const parent = await holdInChild(dir, "dev", 5000);
  process.env.HARNESS_SIM_LOCKED = "other,dev";
  try {
    const release = await acquire("dev", { dir, timeoutMs: 100 });
    release();
    expect(lockHolder("dev", dir)?.pid).toBe(parent.pid); // the no-op release left the parent's lock alone
    const sibling = await holdInChild(dir, "ipad", 5000);
    await expect(acquire("ipad", { dir, pollMs: 25, timeoutMs: 100 })).rejects.toThrow(/timed out/);
    sibling.kill();
  } finally {
    delete process.env.HARNESS_SIM_LOCKED;
    parent.kill();
  }
});

test("withLock lets go when fn throws", async () => {
  const dir = tempDir();
  await expect(withLock("dev", () => { throw new Error("boom"); }, { dir })).rejects.toThrow("boom");
  expect(existsSync(join(dir, "dev.lock"))).toBe(false);
  expect(tryLock("dev", dir)).toBe(true);
  releaseLock("dev", dir);
});

test("withLock runs callers one at a time", async () => {
  const dir = tempDir();
  let inside = 0;
  let most = 0;
  await Promise.all(
    Array.from({ length: 4 }, () =>
      withLock("dev", async () => {
        most = Math.max(most, ++inside);
        await Bun.sleep(30);
        inside--;
      }, { dir, pollMs: 5 }),
    ),
  );
  expect(most).toBe(1);
});

// ---------------------------------------------------------------- ensureDevice

/** A simctl that knows the given runtimes and keeps devices in memory; create takes a moment, like the real one. */
function fakeSimctl(runtimes: Runtime[], devices: Record<string, { udid: string; name: string; state: string; isAvailable: boolean }[]> = {}) {
  const calls: string[][] = [];
  let n = 0;
  const run: Simctl = async (...args) => {
    calls.push(args);
    const [cmd, what] = args;
    if (cmd === "list" && what === "runtimes") return JSON.stringify({ runtimes });
    if (cmd === "list" && what === "devices") return JSON.stringify({ devices });
    if (cmd === "create") {
      await Bun.sleep(50);
      const udid = `UDID-${++n}`;
      (devices[args[3]!] ??= []).push({ udid, name: args[1]!, state: "Shutdown", isAvailable: true });
      return udid;
    }
    if (cmd === "boot") {
      const d = Object.values(devices).flat().find((x) => x.udid === args[1]);
      if (d!.state === "Booted") throw new Error("Unable to boot device in current state: Booted");
      d!.state = "Booted";
    }
    return "";
  };
  return { run, calls, devices };
}

test("concurrent ensureDevice calls create one device on iOS 27.0 and boot it once", async () => {
  const dir = tempDir();
  const sim = fakeSimctl([runtime("27.1"), runtime("27.0")]);
  const opts = { simctl: sim.run, lockDir: dir, freeGiB: () => 100, log: () => {} };
  const udids = await Promise.all([ensureDevice("harness-shared", opts), ensureDevice("harness-shared", opts), ensureDevice("harness-shared", opts)]);
  expect(new Set(udids)).toEqual(new Set(["UDID-1"]));
  const creates = sim.calls.filter((c) => c[0] === "create");
  expect(creates).toEqual([["create", "harness-shared", iphone.identifier, "com.apple.CoreSimulator.SimRuntime.iOS-27-0"]]);
  expect(sim.calls.filter((c) => c[0] === "boot")).toHaveLength(1);
});

test("ensureDevice reuses the device on 27.0 and refuses a same-named one on another runtime", async () => {
  const dir = tempDir();
  const opts = { lockDir: dir, freeGiB: () => 100, log: () => {} };
  const reuse = fakeSimctl([runtime("27.0")], { "com.apple.CoreSimulator.SimRuntime.iOS-27-0": [{ udid: "OLD", name: "harness-shared", state: "Booted", isAvailable: true }] });
  expect(await ensureDevice("harness-shared", { ...opts, simctl: reuse.run })).toBe("OLD");
  expect(reuse.calls.some((c) => c[0] === "create" || c[0] === "boot")).toBe(false);

  const wrong = fakeSimctl([runtime("27.0"), runtime("27.1")], { "com.apple.CoreSimulator.SimRuntime.iOS-27-1": [{ udid: "X", name: "harness-shared", state: "Shutdown", isAvailable: true }] });
  await expect(ensureDevice("harness-shared", { ...opts, simctl: wrong.run })).rejects.toThrow(/exists on com\.apple\.CoreSimulator\.SimRuntime\.iOS-27-1/);
  expect(wrong.calls.some((c) => c[0] === "create")).toBe(false);
});

test("ensureDevice creates nothing without iOS 27.0 or without disk space", async () => {
  const dir = tempDir();
  const noRuntime = fakeSimctl([runtime("27.1"), runtime("18.6")]);
  await expect(ensureDevice("harness-shared", { simctl: noRuntime.run, lockDir: dir, freeGiB: () => 100 })).rejects.toThrow(/27\.0 simulator runtime isn't installed/);
  const full = fakeSimctl([runtime("27.0")]);
  await expect(ensureDevice("harness-shared", { simctl: full.run, lockDir: dir, freeGiB: () => 2 })).rejects.toThrow(/only 2\.0 GiB/);
  expect([...noRuntime.calls, ...full.calls].some((c) => c[0] === "create")).toBe(false);
  expect(existsSync(join(dir, "harness-shared.ensure.lock"))).toBe(false);
});
